import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { parseDocument, stringify } from "yaml";
import type { ControllerProvider, OwnedRuntime, RuntimeConfig, RuntimeDependencies } from "./contracts.ts";
import { MihomoControllerProvider } from "./controller.ts";
const exec = promisify(execFile);
export class FallbackError extends Error {
  readonly code: string;
  declare readonly retryCleanup?: () => Promise<void>;
  constructor(code: string, retryCleanup?: () => Promise<void>) { super("fallback runtime failed"); this.name = "FallbackError"; this.code = code; if (retryCleanup) Object.defineProperty(this, "retryCleanup", { value: retryCleanup }); }
}
export interface FallbackRuntime extends OwnedRuntime {
  readonly proxy: { host: string; port: number };
  readonly nodeGroup: string;
  readonly controller: ControllerProvider;
}
export interface FallbackChild {
  readonly pid: number;
  readonly exited: boolean;
}
export interface FallbackOperations {
  platform: string;
  run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string>;
  launch(file: string, args: string[], cwd: string): FallbackChild;
  identity(pid: number): Promise<{ command: string; executable: string; start: string; pgid: number }>;
  prepareDirectory?(directory: string, id: string): Promise<void>;
  listeners(pid: number): Promise<string[]>;
  killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}
const defaultOperations: FallbackOperations = {
  platform: process.platform,
  async run(file, args, timeoutMs, signal) {
    const home = args.includes("-d") ? args[args.indexOf("-d") + 1] : tmpdir();
    const result = await exec(file, args, { timeout: timeoutMs, signal, killSignal: "SIGKILL", cwd: home, env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8", maxBuffer: 65536 });
    return result.stdout + result.stderr;
  },
  launch(file, args, cwd) {
    const child = spawn(file, args, { cwd, detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: cwd } });
    let exited = false;
    child.on("error", () => { exited = true; });
    child.on("exit", () => { exited = true; });
    return { get pid() { return child.pid ?? 0; }, get exited() { return exited; } };
  },
  async identity(pid) {
    const probe = async (field: string) => (await exec("/bin/ps", ["-p", String(pid), "-o", `${field}=`], { timeout: 1000, maxBuffer: 65536, encoding: "utf8" })).stdout.trim();
    const [command, executable, start, group] = await Promise.all([probe("command"), probe("comm"), probe("lstart"), probe("pgid")]);
    return { command, executable, start, pgid: Number(group) };
  },
  async listeners(pid) {
    try {
      const { stdout } = await exec("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 1000, maxBuffer: 65536, encoding: "utf8" });
      return stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return [];
      throw error;
    }
  },
  killGroup(pid, signal) { process.kill(-pid, signal); },
};
function map(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FallbackError("config-invalid");
  return value as Record<string, unknown>;
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new FallbackError("startup-timeout"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function isolatedConfig(text: string, deps: RuntimeDependencies, signal: AbortSignal): Promise<{ document: Record<string, unknown>; group: string }> {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new FallbackError("config-too-large");
  let document: Record<string, unknown>;
  try {
    const parsed = parseDocument(text, { strict: true, uniqueKeys: true, version: "1.2" });
    if (parsed.errors.length || parsed.warnings.length) throw new Error();
    document = map(parsed.toJS({ maxAliasCount: 0 }));
  } catch { throw new FallbackError("config-invalid"); }
  const top = new Set(["proxies", "proxy-groups", "rules"]);
  if (Object.keys(document).some((key) => !top.has(key))) throw new FallbackError("config-unsupported-field");
  if (!Array.isArray(document.proxies) || !document.proxies.length || !Array.isArray(document["proxy-groups"]) || document["proxy-groups"].length !== 1) throw new FallbackError("config-invalid");
  const nodeKeys = new Set(["name", "type", "server", "port", "password", "username", "cipher", "uuid", "tls", "skip-cert-verify", "sni", "servername", "udp", "alterId", "network", "alpn"]);
  const names = new Set<string>();
  for (const raw of document.proxies) {
    const node = map(raw);
    if (Object.keys(node).some((key) => !nodeKeys.has(key))) throw new FallbackError("config-unsupported-field");
    if (!["http", "socks5", "ss", "trojan", "vmess", "vless"].includes(String(node.type)) || typeof node.name !== "string" || !node.name || names.has(node.name) || ["DIRECT", "REJECT"].includes(node.name)) throw new FallbackError("config-invalid-node");
    if (typeof node.server !== "string" || !/^[A-Za-z0-9.-]+$/.test(node.server) || !Number.isInteger(node.port) || Number(node.port) < 1 || Number(node.port) > 65535 || (node.network !== undefined && node.network !== "tcp")) throw new FallbackError("config-invalid-node");
    for (const [key, value] of Object.entries(node)) {
      if (key === "alpn") { if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new FallbackError("config-invalid-node"); }
      else if (!["string", "number", "boolean"].includes(typeof value)) throw new FallbackError("config-invalid-node");
      if (["password", "uuid", "username"].includes(key)) {
        if (typeof value !== "string" || !/^credential:\/\/[A-Za-z0-9_.-]{1,64}$/.test(value)) throw new FallbackError("credential-reference-required");
        let secret: string | undefined;
        try { secret = await bounded(deps.credentials.get(value.slice("credential://".length)), signal); } catch { if (signal.aborted) throw new FallbackError("startup-timeout"); throw new FallbackError("credential-provider-failed"); }
        if (!secret) throw new FallbackError("credential-missing");
        node[key] = secret;
      }
    }
    names.add(node.name);
  }
  const group = map(document["proxy-groups"][0]);
  if (Object.keys(group).some((key) => !["name", "type", "proxies"].includes(key)) || group.type !== "select" || typeof group.name !== "string" || !group.name || names.has(group.name) || ["DIRECT", "REJECT"].includes(group.name) || !Array.isArray(group.proxies) || !group.proxies.length || !group.proxies.every((name) => typeof name === "string" && names.has(name))) throw new FallbackError("config-invalid-group");
  if (document.rules !== undefined && (!Array.isArray(document.rules) || document.rules.length !== 1 || document.rules[0] !== `MATCH,${group.name}`)) throw new FallbackError("config-unsupported-rule");
  return { document, group: group.name };
}
async function reserve(port = 0): Promise<{ port: number; release(): Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new FallbackError("port-allocation-failed"); }
  return { port: address.port, release: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function startFallbackCore(config: RuntimeConfig, deps: RuntimeDependencies, options: { signal?: AbortSignal; operations?: FallbackOperations } = {}): Promise<FallbackRuntime> {
  const ops = options.operations ?? defaultOperations;
  if (ops.platform !== "darwin") throw new FallbackError("platform-unsupported");
  if (!config.fallback) throw new FallbackError("fallback-not-configured");
  const fallback = config.fallback;
  if (!isAbsolute(fallback.executable) || fallback.controllerHost !== "127.0.0.1" || (fallback.dataDirectory && !isAbsolute(fallback.dataDirectory))) throw new FallbackError("config-invalid");
  const budgetController = new AbortController();
  const timer = setTimeout(() => budgetController.abort(), config.timeouts.controllerReadyMs);
  const budget = budgetController.signal;
  const signal = options.signal ? AbortSignal.any([budget, options.signal]) : budget;
  const cancelled = () => { if (signal.aborted) throw new FallbackError(options.signal?.aborted ? "cancelled" : "startup-timeout"); };
  let directory: string | undefined, inode: bigint | undefined, child: FallbackChild | undefined;
  let fingerprint: string | undefined, initialized = false;
  let expectedExecutable = "";
  const reservations: Array<Awaited<ReturnType<typeof reserve>>> = [];
  let expectedCommand = "";
  const id = randomUUID();
  const ownsDirectory = async () => {
    if (!directory) return false;
    const stat = await lstat(directory, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() && (inode === undefined || stat.ino === inode) && (!initialized || await readFile(join(directory, "owner"), "utf8") === id);
  };
  const ownsProcess = async () => {
    if (!child || child.exited || !await ownsDirectory()) return false;
    const identity = await ops.identity(child.pid);
    if (child.exited || !identity.start || identity.executable !== expectedExecutable || identity.command !== expectedCommand || identity.pgid !== child.pid || (fingerprint && fingerprint !== identity.start)) return false;
    fingerprint ??= identity.start;
    const listeners = await ops.listeners(child.pid);
    const expected = reservations.map(({ port }) => `127.0.0.1:${port}`);
    return !child.exited && listeners.every((listener) => expected.includes(listener));
  };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        if (child && !child.exited) {
          if (!await ownsProcess()) throw new FallbackError("ownership-unconfirmed");
          ops.killGroup(child.pid, "SIGTERM");
          const deadline = Date.now() + config.timeouts.shutdownMs;
          while (!child.exited && Date.now() < deadline) await sleep(20);
          if (!child.exited) {
            if (!await ownsProcess()) throw new FallbackError("ownership-unconfirmed");
            ops.killGroup(child.pid, "SIGKILL");
            const killed = Date.now() + config.timeouts.shutdownMs;
            while (!child.exited && Date.now() < killed) await sleep(20);
            if (!child.exited) throw new FallbackError("shutdown-timeout");
          }
        }
        if (directory) {
          if (!await ownsDirectory()) throw new FallbackError("directory-ownership-unconfirmed");
          await rm(directory, { recursive: true });
          directory = undefined;
        }
      } catch (error) { throw error instanceof FallbackError ? error : new FallbackError("cleanup-failed"); }
    })().catch((error) => { stopping = undefined; throw error; });
    return stopping;
  };
  try {
    cancelled();
    const executable = await realpath(fallback.executable);
    const text = fallback.source.kind === "path" ? await readFile(fallback.source.path, { encoding: "utf8", signal }) : fallback.source.yaml;
    const prepared = await isolatedConfig(text, deps, signal);
    cancelled();
    directory = await mkdtemp(join(fallback.dataDirectory ?? tmpdir(), "pi-proxy-"));
    inode = (await lstat(directory, { bigint: true })).ino;
    if (ops.prepareDirectory) await ops.prepareDirectory(directory, id);
    else { await chmod(directory, 0o700); await writeFile(join(directory, "owner"), id, { mode: 0o600, flag: "wx" }); }
    initialized = true;
    reservations.push(await reserve(fallback.controllerPort));
    reservations.push(await reserve());
    const [control, proxy] = reservations;
    const secret = randomBytes(32).toString("hex");
    const controllerUrl = `http://127.0.0.1:${control.port}`;
    const file = join(directory, "config.yaml");
    await writeFile(file, stringify({ ...prepared.document, rules: [`MATCH,${prepared.group}`], "mixed-port": proxy.port, "bind-address": "127.0.0.1", "allow-lan": false, "external-controller": `127.0.0.1:${control.port}`, secret, mode: "rule", "log-level": "silent", "ipv6": false }), { mode: 0o600, flag: "wx" });
    const help = await ops.run(executable, ["-h"], config.timeouts.requestMs, signal);
    if (!["-f", "-d", "-t"].every((flag) => new RegExp(`(?:^|\\s)${flag}(?:\\s|,|$)`).test(help))) throw new FallbackError("cli-unsupported");
    await ops.run(executable, ["-t", "-d", directory, "-f", file], config.timeouts.requestMs, signal);
    const args = ["-d", directory, "-f", file];
    expectedExecutable = executable;
    expectedCommand = [executable, ...args].join(" ");
    await Promise.all(reservations.map((reservation) => reservation.release()));
    cancelled();
    child = ops.launch(executable, args, directory);
    if (!Number.isInteger(child.pid) || child.pid < 1) { child = undefined; throw new FallbackError("spawn-failed"); }
    let controller: ControllerProvider;
    while (true) {
      cancelled();
      if (child.exited) throw new FallbackError("startup-exited");
      try {
        if (!await ownsProcess()) throw new FallbackError("ownership-unconfirmed");
        const current = new MihomoControllerProvider({ baseUrl: controllerUrl, nodeGroup: prepared.group }, deps.fetch, secret);
        const caps = await current.capabilities(signal);
        const listeners = await ops.listeners(child.pid);
        if (caps.canSelectProxy && reservations.every(({ port }) => listeners.includes(`127.0.0.1:${port}`))) { controller = {
          capabilities: (signal) => current.capabilities(signal), proxies: (signal) => current.proxies(signal),
          select: (group, name, signal) => current.select(group, name, signal), delay: (name, url, timeout, signal) => current.delay(name, url, timeout, signal),
        }; break; }
      } catch (error) { if (error instanceof FallbackError) throw error; }
      await sleep(25);
    }
    cancelled();
    const runtime = { id, pid: child.pid, controllerUrl, proxy: { host: "127.0.0.1", port: proxy.port }, nodeGroup: prepared.group, stop };
    return Object.defineProperty(runtime, "controller", { value: controller, enumerable: false }) as FallbackRuntime;
  } catch (error) {
    for (const reservation of reservations) { try { await reservation.release(); } catch {} }
    try { await stop(); } catch (cleanupError) { throw new FallbackError(cleanupError instanceof FallbackError ? cleanupError.code : "cleanup-failed", stop); }
    if (options.signal?.aborted) throw new FallbackError("cancelled");
    if (budget.aborted) throw new FallbackError("startup-timeout");
    throw error instanceof FallbackError ? error : new FallbackError("startup-failed");
  } finally { clearTimeout(timer); }
}
