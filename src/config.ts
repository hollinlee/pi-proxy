import { isAbsolute } from "node:path";
import { ConfigError, type FallbackConfig, type RuntimeConfig } from "./contracts.ts";
function integer(raw: string | undefined, fallback: number, name: string, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > max) throw new ConfigError(`${name} is outside its allowed integer range`);
  return n;
}
function url(raw: string, name: string, httpsOnly = false): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new ConfigError(`${name} must be a valid URL`); }
  if (!(httpsOnly ? parsed.protocol === "https:" : ["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new ConfigError(`${name} has unsupported protocol or credentials/query/fragment`);
  return parsed.toString();
}
function fallbackConfig(value: unknown): FallbackConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("fallback configuration must be an object");
  const candidate = value as Partial<FallbackConfig>;
  if (typeof candidate.executable !== "string" || !isAbsolute(candidate.executable) || candidate.controllerHost !== "127.0.0.1") throw new ConfigError("fallback requires an absolute executable and loopback controller");
  if (candidate.controllerPort !== undefined && (typeof candidate.controllerPort !== "number" || !Number.isSafeInteger(candidate.controllerPort) || candidate.controllerPort < 1 || candidate.controllerPort > 65535)) throw new ConfigError("fallback port is outside its allowed integer range");
  if (candidate.dataDirectory !== undefined && (typeof candidate.dataDirectory !== "string" || !isAbsolute(candidate.dataDirectory))) throw new ConfigError("fallback data directory must be absolute");
  const source = candidate.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new ConfigError("fallback requires a config source");
  if (source.kind === "path") {
    if (typeof source.path !== "string" || !isAbsolute(source.path)) throw new ConfigError("fallback config path must be absolute");
  } else if (source.kind === "content") {
    if (typeof source.yaml !== "string" || !source.yaml.trim()) throw new ConfigError("fallback config content must be non-empty");
  } else {
    throw new ConfigError("fallback config source kind is unsupported");
  }
  return candidate as FallbackConfig;
}
export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env, overrides: { fallback?: FallbackConfig } = {}): RuntimeConfig {
  const host = env.PROXY_HOST;
  const port = env.PROXY_PORT;
  if ((host === undefined) !== (port === undefined)) throw new ConfigError("PROXY_HOST and PROXY_PORT must be provided together");
  if (host !== undefined && !/^[A-Za-z0-9.-]+$/.test(host)) throw new ConfigError("PROXY_HOST must be a hostname or IPv4 address");
  const parsedPort = port === undefined ? undefined : integer(port, 1, "proxy port", 65535);
  const rawFallback = overrides.fallback !== undefined ? overrides.fallback : (env.PI_PROXY_FALLBACK_CONFIG ? {
    executable: env.PI_PROXY_FALLBACK_BINARY || "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo",
    source: { kind: "path" as const, path: env.PI_PROXY_FALLBACK_CONFIG },
    controllerHost: env.PI_PROXY_FALLBACK_CONTROLLER_HOST || "127.0.0.1",
    controllerPort: env.PI_PROXY_FALLBACK_CONTROLLER_PORT === undefined ? undefined : integer(env.PI_PROXY_FALLBACK_CONTROLLER_PORT, 1, "fallback port", 65535),
    dataDirectory: env.PI_PROXY_FALLBACK_DATA_DIR,
  } : undefined);
  const fallback = rawFallback === undefined ? undefined : fallbackConfig(rawFallback);
  const baseUrl = env.PI_PROXY_CONTROLLER_URL ? url(env.PI_PROXY_CONTROLLER_URL, "controller URL") : undefined;
  const nodeGroup = env.PI_PROXY_NODE_GROUP?.trim();
  if (baseUrl && !nodeGroup) throw new ConfigError("controller requires PI_PROXY_NODE_GROUP");
  const secretRef = env.PI_PROXY_CONTROLLER_SECRET_REF;
  if (secretRef !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(secretRef)) throw new ConfigError("invalid credential reference");
  return {
    githubUrl: url(env.PI_PROXY_GITHUB_URL || "https://github.com/", "GitHub URL", true),
    proxy: host !== undefined && parsedPort !== undefined ? { host, port: parsedPort } : undefined,
    controller: baseUrl ? { baseUrl, nodeGroup: nodeGroup!, secretRef } : undefined,
    fallback: fallback as FallbackConfig | undefined,
    candidateLimit: integer(env.PI_PROXY_CANDIDATE_LIMIT, 3, "candidate limit", 16),
    timeouts: {
      requestMs: integer(env.PI_PROXY_REQUEST_TIMEOUT_MS, 5000, "request timeout", 60000),
      controllerReadyMs: integer(env.PI_PROXY_CONTROLLER_READY_TIMEOUT_MS, 10000, "readiness timeout", 120000),
      nodeDelayMs: integer(env.PI_PROXY_NODE_DELAY_TIMEOUT_MS, 5000, "delay timeout", 60000),
      recoveryMs: integer(env.PI_PROXY_RECOVERY_TIMEOUT_MS, 30000, "recovery timeout", 300000),
      shutdownMs: integer(env.PI_PROXY_SHUTDOWN_TIMEOUT_MS, 3000, "shutdown timeout", 30000),
    },
  };
}
