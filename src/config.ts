export interface ProxyConfig {
  host: string;
  port: number;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("PROXY_PORT must be a valid port");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PROXY_PORT is outside the valid range");
  return port;
}

export function readProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig | undefined {
  const host = env.PROXY_HOST?.trim();
  const port = env.PROXY_PORT?.trim();
  if (!host && !port) return undefined;
  if (!host || !port) throw new Error("PROXY_HOST and PROXY_PORT must be provided together");
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) throw new Error("PROXY_HOST must be a hostname or IPv4 address");
  return { host, port: parsePort(port) };
}

export function proxyUrl(config: ProxyConfig): string {
  return `http://${config.host}:${config.port}`;
}
