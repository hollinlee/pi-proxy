import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readProxyConfig, proxyUrl, type ProxyConfig } from "./config.ts";

const networkCommand = /(?:^|[;&|()]\s*)(?:env\s+)?(?:sudo\s+)?(?:curl|wget|git|gh|npm|pnpm|yarn|bun|npx|pip|pip3|pipx|uv|poetry|cargo|go|gem|composer|docker|podman|helm|kubectl|terraform|ansible-galaxy|brew)(?:\s|$)/i;
const injectedVariable = /(?:^|\s)(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)=/;

export function isNetworkCommand(command: string): boolean {
  return networkCommand.test(command);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function injectProxy(command: string, config: ProxyConfig): string {
  const url = shellQuote(proxyUrl(config));
  const assignments = [
    `HTTP_PROXY=${url}`,
    `HTTPS_PROXY=${url}`,
    `ALL_PROXY=${url}`,
    `http_proxy=${url}`,
    `https_proxy=${url}`,
    `all_proxy=${url}`,
  ].join(" ");
  return `export ${assignments}; ${command}`;
}

export function registerProxyExtension(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  pi.on("tool_call", (event: any) => {
    if (event.toolName !== "bash" || typeof event.input?.command !== "string") return;
    if (!isNetworkCommand(event.input.command) || injectedVariable.test(event.input.command)) return;
    const config = readProxyConfig(env);
    if (config) event.input.command = injectProxy(event.input.command, config);
  });
}

export default function proxyExtension(pi: ExtensionAPI): void {
  registerProxyExtension(pi);
}
