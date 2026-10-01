export type RecoveryPhase = "diagnose" | "controller" | "node" | "fallback" | "proxy" | "verify" | "rollback" | "cleanup";
export interface ControllerConfig { baseUrl: string; secretRef?: string; nodeGroup: string; }
export type FallbackConfigSource = { kind: "path"; path: string } | { kind: "content"; yaml: string };
export interface FallbackConfig { executable: string; source: FallbackConfigSource; controllerHost: "127.0.0.1"; controllerPort?: number; dataDirectory?: string; }
export interface RuntimeConfig { githubUrl: string; proxy?: { host: string; port: number }; controller?: ControllerConfig; fallback?: FallbackConfig; candidateLimit: number; timeouts: { requestMs: number; controllerReadyMs: number; nodeDelayMs: number; recoveryMs: number; shutdownMs: number }; }
export interface CredentialProvider { get(ref: string): Promise<string | undefined>; }
export interface ControllerProxy { name: string; type?: string; all?: string[]; now?: string; }
export interface ControllerCapabilities { version: string; canSelectProxy: boolean; canDelayProxy: boolean; }
export interface ControllerProvider { capabilities(signal?: AbortSignal): Promise<ControllerCapabilities>; proxies(signal?: AbortSignal): Promise<readonly ControllerProxy[]>; select(group: string, name: string, signal?: AbortSignal): Promise<void>; delay(name: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<number>; }
export interface DiagnosticCheck { ok: boolean; code?: string; latencyMs?: number; }
export interface DiagnosticResult { target: string; dns: DiagnosticCheck; proxy: DiagnosticCheck; controller?: DiagnosticCheck; node?: DiagnosticCheck; github: DiagnosticCheck; }
export interface EnvironmentSnapshot { readonly before: Readonly<Record<string, string | undefined>>; restore(): void; }
export interface OwnedRuntime { readonly id: string; readonly pid: number; readonly controllerUrl: string; stop(): Promise<void>; }
export interface RuntimeDependencies { credentials: CredentialProvider; fetch: typeof globalThis.fetch; now?: () => number; }
export interface RecoveryEvent { phase: RecoveryPhase; type: "started" | "succeeded" | "failed" | "skipped" | "rolled_back"; message: string; at: number; }
export interface RecoveryFailure { phase: RecoveryPhase; code: string; message: string; retryable: boolean; }
export interface RecoveryResult { recovered: boolean; events: RecoveryEvent[]; failure?: RecoveryFailure; retainedEnvironment: boolean; }
export interface RecoveryRequest { idempotent: boolean; signal?: AbortSignal; }
export class ConfigError extends Error { constructor(message: string) { super(message); this.name = "ConfigError"; } }
export function redact(value: unknown, secrets: readonly string[]): unknown {
  const clean = (text: string): string => {
    const matches = secrets.filter(Boolean).flatMap((secret) => {
      const positions: Array<[number, number]> = [];
      for (let i = text.indexOf(secret); i >= 0; i = text.indexOf(secret, i + 1)) positions.push([i, i + secret.length]);
      return positions;
    }).sort((a, b) => a[0] - b[0]);
    const spans: Array<[number, number]> = [];
    for (const [start, end] of matches) { const last = spans.at(-1); if (last && start < last[1]) last[1] = Math.max(last[1], end); else spans.push([start, end]); }
    let result = "", offset = 0;
    for (const [start, end] of spans) { result += text.slice(offset, start) + "[REDACTED]"; offset = end; }
    return result + text.slice(offset);
  };
  if (typeof value === "string") return clean(value);
  if (value instanceof Error) return { name: clean(value.name), message: clean(value.message) };
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), /secret|token|password|authorization|credential|api[-_]?key/i.test(key) ? "[REDACTED]" : redact(item, secrets)]));
  return value;
}
