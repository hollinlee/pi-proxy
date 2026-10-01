import type { ControllerConfig, ControllerCapabilities, ControllerProvider, ControllerProxy, RuntimeDependencies } from "./contracts.ts";

export class ControllerError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message = "controller request failed", status?: number) { super(message); this.name = "ControllerError"; this.code = code; this.status = status; }
}
type ControllerPayload = Record<string, unknown>;
function object(value: unknown, code: string): ControllerPayload { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControllerError(code); return value as ControllerPayload; }
function nonEmpty(value: unknown, code: string): string { if (typeof value !== "string" || !value.trim()) throw new ControllerError(code); return value; }
function endpoint(config: ControllerConfig, path: string): string { return new URL(path.replace(/^\//, ""), `${config.baseUrl.replace(/\/$/, "")}/`).toString(); }
export async function createControllerProvider(config: ControllerConfig, deps: RuntimeDependencies): Promise<ControllerProvider> { let secret: string | undefined; try { secret = config.secretRef ? await deps.credentials.get(config.secretRef) : undefined; } catch { throw new ControllerError("credential-provider-failed"); } return new MihomoControllerProvider(config, deps.fetch, secret); }
export class MihomoControllerProvider implements ControllerProvider {
  private readonly config: ControllerConfig; private readonly fetcher: typeof globalThis.fetch; private readonly secret: string | undefined; private proxyCache?: readonly ControllerProxy[];
  constructor(config: ControllerConfig, fetcher: typeof globalThis.fetch, secret?: string) { this.config = config; this.fetcher = fetcher; this.secret = secret; }
  private async request(path: string, init: RequestInit = {}, parseBody = true): Promise<unknown> {
    if (init.signal?.aborted) throw new ControllerError("controller-cancelled");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000); const abort = () => controller.abort(); init.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetcher(endpoint(this.config, path), { ...init, signal: controller.signal, headers: { ...(init.headers ?? {}), ...(this.secret ? { Authorization: `Bearer ${this.secret}` } : {}) } });
      if (!response.ok) throw new ControllerError("controller-http-status", `controller returned HTTP ${response.status}`, response.status);
      if (!parseBody) { await response.body?.cancel(); return undefined; }
      try { return await response.json(); } catch { throw new ControllerError("controller-invalid-json"); }
    } catch (error) { if (error instanceof ControllerError) throw error; if (init.signal?.aborted) throw new ControllerError("controller-cancelled"); if (controller.signal.aborted) throw new ControllerError("controller-timeout"); throw new ControllerError("controller-unreachable"); }
    finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
  }
  async capabilities(signal?: AbortSignal): Promise<ControllerCapabilities> {
    const version = nonEmpty(object(await this.request("/version", { signal }), "controller-invalid-version").version, "controller-invalid-version");
    const proxies = await this.proxies(signal); const group = proxies.find((item) => item.name === this.config.nodeGroup);
    return { version, canSelectProxy: Boolean(group?.all?.length), canDelayProxy: Boolean(group?.all?.length) };
  }
  async proxies(signal?: AbortSignal): Promise<readonly ControllerProxy[]> {
    if (this.proxyCache) return this.proxyCache;
    const raw = object(object(await this.request("/proxies", { signal }), "controller-invalid-proxies").proxies, "controller-invalid-proxies");
    const result = Object.entries(raw).map(([name, value]) => { const item = object(value, "controller-invalid-proxy"); const hasAll = "all" in item; const all = hasAll && Array.isArray(item.all) && item.all.every((entry) => typeof entry === "string") ? item.all as string[] : undefined; if (hasAll && !all) throw new ControllerError("controller-invalid-proxy"); if ("now" in item && typeof item.now !== "string") throw new ControllerError("controller-invalid-proxy"); if ("type" in item && typeof item.type !== "string") throw new ControllerError("controller-invalid-proxy"); return { name, type: typeof item.type === "string" ? item.type : undefined, all, now: typeof item.now === "string" ? item.now : undefined }; });
    this.proxyCache = result; return result;
  }
  async select(group: string, name: string, signal?: AbortSignal): Promise<void> { if (!group || !name) throw new ControllerError("controller-invalid-selection"); await this.request(`/proxies/${encodeURIComponent(group)}`, { method: "PUT", body: JSON.stringify({ name }), headers: { "content-type": "application/json" }, signal }, false); this.proxyCache = undefined; const selected = (await this.proxies(signal)).find((proxy) => proxy.name === group); if (!selected || selected.now !== name) throw new ControllerError("controller-selection-unconfirmed"); }
  async delay(name: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<number> { let parsed: URL; try { parsed = new URL(url); } catch { throw new ControllerError("controller-invalid-delay-url"); } const payload = object(await this.request(`/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(parsed.toString())}&timeout=${timeoutMs}`, { signal }), "controller-invalid-delay"); if (typeof payload.delay !== "number" || !Number.isFinite(payload.delay) || payload.delay < 0) throw new ControllerError("controller-invalid-delay"); return payload.delay; }
}
