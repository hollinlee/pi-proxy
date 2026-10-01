import type { ControllerProvider, DiagnosticResult, EnvironmentSnapshot, RecoveryEvent, RecoveryFailure, RecoveryPhase, RecoveryRequest, RecoveryResult, RuntimeConfig, RuntimeDependencies } from "./contracts.ts";
import { createControllerProvider } from "./controller.ts";
import { runDiagnostics } from "./diagnostics.ts";
import { FallbackError, startFallbackCore, type FallbackRuntime } from "./fallback-core.ts";
export interface RecoveryOperations {
  controller(config: RuntimeConfig, deps: RuntimeDependencies, signal: AbortSignal): Promise<ControllerProvider>;
  diagnose(config: RuntimeConfig, deps: RuntimeDependencies, provider: ControllerProvider | undefined, signal: AbortSignal): Promise<DiagnosticResult>;
  fallback(config: RuntimeConfig, deps: RuntimeDependencies, signal: AbortSignal): Promise<FallbackRuntime>;
}
export interface RuntimeStatus { busy: boolean; closed: boolean; ownsFallback: boolean; cleanupPending: boolean; retainedEnvironment: boolean; }
export interface ProxyRuntime { status(): RuntimeStatus; diagnose(signal?: AbortSignal): Promise<DiagnosticResult>; recover(request: RecoveryRequest): Promise<RecoveryResult>; shutdown(): Promise<void>; }
class RecoveryError extends Error {
  readonly code: string;
  constructor(code: string) { super("proxy recovery failed"); this.name = "RecoveryError"; this.code = code; }
}
const defaults: RecoveryOperations = {
  async controller(config, deps, signal) { if (signal.aborted) throw new RecoveryError("cancelled"); if (!config.controller) throw new RecoveryError("controller-not-configured"); return createControllerProvider(config.controller, deps); },
  diagnose: (config, deps, provider, signal) => runDiagnostics(config, deps, provider, { signal }),
  fallback: (config, deps, signal) => startFallbackCore(config, deps, { signal }),
};
const keys = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "no_proxy", "NO_PROXY"] as const;
export function snapshotProxyEnvironment(env: NodeJS.ProcessEnv, proxy: { host: string; port: number }): EnvironmentSnapshot {
  const before = Object.freeze(Object.fromEntries(keys.map((key) => [key, env[key]])));
  const address = `http://${proxy.host}:${proxy.port}`;
  const writes: Record<string, string> = { http_proxy: address, https_proxy: address, all_proxy: address, HTTP_PROXY: address, HTTPS_PROXY: address, ALL_PROXY: address, no_proxy: "localhost,127.0.0.1,::1", NO_PROXY: "localhost,127.0.0.1,::1" };
  for (const key of keys) env[key] = writes[key];
  return { before, restore() { for (const key of keys) { if (env[key] !== writes[key]) continue; if (before[key] === undefined) delete env[key]; else env[key] = before[key]; } } };
}
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new RecoveryError("cancelled");
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => { if (settled) return; settled = true; reject(new RecoveryError("cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw new RecoveryError("cancelled"); return work(); }).then((value) => { if (!settled) { settled = true; resolve(value); } }, (error) => { if (!settled) { settled = true; reject(error); } }).finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function retryIdempotent<T>(operation: () => Promise<T>, idempotent: boolean, retries = 1, signal?: AbortSignal): Promise<T> {
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 3) throw new RecoveryError("invalid-retry-limit");
  for (let attempt = 0; ; attempt++) { if (signal?.aborted) throw new RecoveryError("cancelled"); try { return await operation(); } catch (error) { if (!idempotent || attempt >= retries || signal?.aborted) throw error; } }
}
export async function createRuntime(options: { config: RuntimeConfig; credentials: RuntimeDependencies["credentials"]; env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; now?: () => number; operations?: Partial<RecoveryOperations> }): Promise<ProxyRuntime> {
  const config = structuredClone(options.config), env = options.env ?? process.env;
  const deps: RuntimeDependencies = { credentials: options.credentials, fetch: options.fetch ?? globalThis.fetch, now: options.now };
  const ops = { ...defaults, ...options.operations }, now = deps.now ?? Date.now;
  let busy = false, closed = false, retainedEnvironment = false;
  let owner: FallbackRuntime | undefined, retainedConfig: RuntimeConfig | undefined;
  let active: AbortController | undefined, activeDone: Promise<RecoveryResult> | undefined, shutdownWork: Promise<void> | undefined;
  const snapshots: EnvironmentSnapshot[] = [], cleanup = new Set<() => Promise<void>>(), pendingStartup = new Set<Promise<void>>();
  const rememberCleanup = (error: unknown) => { if (error instanceof FallbackError && error.retryCleanup) cleanup.add(error.retryCleanup); };
  const cleanupOne = async (stop: () => Promise<void>) => { cleanup.add(stop); await stop(); cleanup.delete(stop); };
  const status = (): RuntimeStatus => ({ busy, closed, ownsFallback: Boolean(owner), cleanupPending: cleanup.size > 0 || pendingStartup.size > 0, retainedEnvironment });
  const failure = (phase: RecoveryPhase, code: string): RecoveryFailure => ({ phase, code, message: "proxy recovery failed", retryable: !["cancelled", "runtime-closed", "runtime-busy", "cleanup-pending"].includes(code) });
  const recover = (request: RecoveryRequest): Promise<RecoveryResult> => {
    if (closed || busy || cleanup.size || pendingStartup.size) return Promise.resolve({ recovered: false, events: [], failure: failure("diagnose", closed ? "runtime-closed" : busy ? "runtime-busy" : "cleanup-pending"), retainedEnvironment });
    busy = true; active = new AbortController();
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), config.timeouts.recoveryMs);
    const signal = AbortSignal.any([active.signal, deadline.signal, ...(request.signal ? [request.signal] : [])]);
    const events: RecoveryEvent[] = [];
    let phase: RecoveryPhase = "diagnose", snapshot: EnvironmentSnapshot | undefined, newOwner: FallbackRuntime | undefined;
    const event = (type: RecoveryEvent["type"], message: string) => { events.push({ phase, type, message, at: now() }); };
    const gate = <T>(work: () => Promise<T>) => bounded(work, signal);
    const verify = async (current: RuntimeConfig): Promise<boolean> => {
      phase = "verify"; event("started", "checking GitHub HTTPS");
      const result = await gate(() => ops.diagnose(current, deps, undefined, signal));
      if (!result.github.ok) { event("failed", "GitHub HTTPS failed"); return false; }
      if (signal.aborted) throw new RecoveryError("cancelled");
      event("succeeded", "GitHub HTTPS verified"); return true;
    };
    const switchNode = async (provider: ControllerProvider, groupName: string, current: RuntimeConfig): Promise<void> => {
      phase = "controller"; event("started", "checking controller capabilities");
      const caps = await gate(() => provider.capabilities(signal)), proxies = await gate(() => provider.proxies(signal));
      const group = proxies.find((proxy) => proxy.name === groupName);
      if (!caps.canSelectProxy || !caps.canDelayProxy || group?.type !== "Selector" || !group.all?.length) throw new RecoveryError("selector-unavailable");
      event("succeeded", "controller selector available");
      phase = "node"; event("started", "screening bounded candidates");
      const valid = [...new Set(group.all)].filter((name) => !["DIRECT", "REJECT", groupName].includes(name) && proxies.some((proxy) => proxy.name === name));
      const candidates = [...valid.filter((name) => name !== group.now), ...valid.filter((name) => name === group.now)].slice(0, config.candidateLimit);
      for (const name of candidates) {
        try { await gate(() => provider.delay(name, current.githubUrl, config.timeouts.nodeDelayMs, signal)); }
        catch { if (signal.aborted) throw new RecoveryError("cancelled"); continue; }
        // Current node is usable for a fresh one-node fallback; no redundant PUT.
        if (name !== group.now) await gate(() => provider.select(groupName, name, signal));
        event("succeeded", "healthy candidate ready"); return;
      }
      throw new RecoveryError("no-healthy-candidate");
    };
    const startOwned = async (): Promise<FallbackRuntime> => {
      if (signal.aborted) throw new RecoveryError("cancelled");
      // Track acquisition beyond the deadline so late ownership is never lost.
      const acquisition = ops.fallback(config, deps, signal).then(async (runtime) => {
        if (signal.aborted || closed) { try { await cleanupOne(runtime.stop); } catch {} throw new RecoveryError("cancelled"); }
        return runtime;
      }, (error) => { rememberCleanup(error); throw error; });
      const tracked = acquisition.then(() => {}, () => {});
      pendingStartup.add(tracked);
      void tracked.then(() => pendingStartup.delete(tracked));
      return gate(() => acquisition);
    };
    const transaction = async (): Promise<RecoveryResult> => {
      try {
        if (signal.aborted) throw new RecoveryError("cancelled");
        const initialConfig = retainedConfig ?? config;
        event("started", "checking existing GitHub access");
        const initial = await gate(() => ops.diagnose(initialConfig, deps, undefined, signal));
        if (initial.github.ok) { if (signal.aborted) throw new RecoveryError("cancelled"); event("succeeded", "existing GitHub HTTPS verified"); return { recovered: true, events, retainedEnvironment }; }
        event("failed", "existing GitHub HTTPS failed");
        let selected: RuntimeConfig | undefined;
        const existing = owner?.controller;
        if (existing || config.controller) {
          try {
            phase = "controller";
            const provider = existing ?? await gate(() => ops.controller(config, deps, signal)), current = owner ? retainedConfig! : config;
            if (!current.proxy) throw new RecoveryError("proxy-not-configured");
            await switchNode(provider, owner?.nodeGroup ?? config.controller!.nodeGroup, current);
            if (await verify(current)) selected = current;
          } catch (error) { if (signal.aborted) throw error; event("failed", "controller recovery failed"); if (!config.fallback || owner) throw error; }
        }
        if (!selected) {
          phase = "fallback";
          if (owner) throw new RecoveryError("owned-runtime-unhealthy");
          if (!config.fallback) throw new RecoveryError("fallback-not-configured");
          event("started", "starting isolated owned runtime"); newOwner = await startOwned(); event("succeeded", "owned runtime ready");
          const current: RuntimeConfig = { ...config, proxy: newOwner.proxy, controller: { baseUrl: newOwner.controllerUrl, nodeGroup: newOwner.nodeGroup } };
          await switchNode(newOwner.controller, newOwner.nodeGroup, current);
          if (!await verify(current)) throw new RecoveryError("github-verification-failed");
          selected = current;
        }
        if (signal.aborted) throw new RecoveryError("cancelled");
        phase = "proxy"; event("started", "committing child proxy environment");
        snapshot = snapshotProxyEnvironment(env, selected.proxy!); snapshots.push(snapshot); retainedConfig = selected;
        if (newOwner) { owner = newOwner; newOwner = undefined; }
        retainedEnvironment = true; event("succeeded", "verified proxy environment retained");
        return { recovered: true, events, retainedEnvironment };
      } catch (error) {
        const failedPhase = phase;
        const code = request.signal?.aborted || active?.signal.aborted ? "cancelled" : deadline.signal.aborted ? "recovery-timeout" : error instanceof RecoveryError ? error.code : "operation-failed";
        event("failed", "recovery transaction failed"); rememberCleanup(error);
        phase = "rollback"; snapshot?.restore(); event("rolled_back", "transaction environment restored");
        if (newOwner) { phase = "cleanup"; try { await cleanupOne(newOwner.stop); event("succeeded", "owned runtime removed"); } catch { event("failed", "owned runtime cleanup pending"); } }
        return { recovered: false, events, failure: failure(failedPhase, code), retainedEnvironment };
      } finally { clearTimeout(timer); busy = false; active = undefined; }
    };
    activeDone = transaction(); return activeDone;
  };
  const diagnose = async (signal?: AbortSignal): Promise<DiagnosticResult> => {
    if (closed) throw new RecoveryError("runtime-closed");
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), config.timeouts.recoveryMs);
    const combined = signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal;
    try { const current = retainedConfig ?? config, provider = owner?.controller ?? (current.controller ? await bounded(() => ops.controller(current, deps, combined), combined) : undefined); return await bounded(() => ops.diagnose(current, deps, provider, combined), combined); }
    finally { clearTimeout(timer); }
  };
  const shutdown = (): Promise<void> => {
    if (shutdownWork) return shutdownWork;
    closed = true; active?.abort();
    shutdownWork = (async () => {
      await activeDone;
      for (const snapshot of [...snapshots].reverse()) snapshot.restore(); snapshots.length = 0; retainedEnvironment = false;
      if (owner) { cleanup.add(owner.stop); owner = undefined; }
      const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), config.timeouts.shutdownMs);
      try {
        await bounded(() => Promise.all([...pendingStartup]), timeout.signal);
        let failed = false;
        for (const stop of [...cleanup]) { try { await bounded(() => cleanupOne(stop), timeout.signal); } catch { failed = true; } }
        if (failed) throw new RecoveryError("cleanup-pending");
      } catch { throw new RecoveryError("cleanup-pending"); }
      finally { clearTimeout(timer); }
    })().catch((error) => { shutdownWork = undefined; throw error; });
    return shutdownWork;
  };
  return { status, diagnose, recover, shutdown };
}
