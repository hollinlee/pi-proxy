import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readRuntimeConfig } from "./config.ts";
import { ChainCredentialProvider, EnvironmentCredentialProvider, MacOSKeychainCredentialProvider } from "./credentials.ts";
import type { DiagnosticCheck, DiagnosticResult } from "./contracts.ts";
import { createRuntime, type ProxyRuntime } from "./recovery.ts";

export interface AdapterOptions {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  create?: typeof createRuntime;
}

const diagnosticCodes = new Set([
  "ok", "cancelled", "timeout", "unreachable", "dns-failed", "https-failed", "probe-failed",
  "proxy-not-configured", "node-group-missing", "node-not-selected", "controller-cancelled",
  "controller-timeout", "controller-unreachable", "controller-http-status", "controller-invalid-json",
  "controller-invalid-version", "controller-invalid-proxies", "controller-invalid-proxy",
  "controller-invalid-delay", "controller-invalid-delay-url", "controller-selection-unconfirmed",
  "controller-invalid-selection", "credential-provider-failed",
]);

function publicCheck(value: DiagnosticCheck): DiagnosticCheck {
  const code = typeof value.code === "string" && (diagnosticCodes.has(value.code) || /^http-[1-5][0-9]{2}$/.test(value.code)) ? value.code : "probe-failed";
  return {
    ok: value.ok === true,
    code,
    ...(typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) && value.latencyMs >= 0 ? { latencyMs: value.latencyMs } : {}),
  };
}
function publicDiagnostics(value: DiagnosticResult, target: string): DiagnosticResult {
  return {
    target,
    dns: publicCheck(value.dns),
    proxy: publicCheck(value.proxy),
    github: publicCheck(value.github),
    ...(value.controller ? { controller: publicCheck(value.controller) } : {}),
    ...(value.node ? { node: publicCheck(value.node) } : {}),
  };
}

export function registerProxyTools(pi: ExtensionAPI, options: AdapterOptions = {}): void {
  const env = options.env ?? process.env;
  let pending: Promise<ProxyRuntime> | undefined;
  let current: ProxyRuntime | undefined;
  let closed = false;
  let target = "github.com";

  const getRuntime = (): Promise<ProxyRuntime> => {
    if (closed) throw new Error("proxy runtime closed");
    if (!pending) {
      const config = readRuntimeConfig(env);
      target = new URL(config.githubUrl).hostname;
      const providers = [
        new EnvironmentCredentialProvider(env),
        ...((options.platform ?? process.platform) === "darwin" ? [new MacOSKeychainCredentialProvider()] : []),
      ];
      pending = (options.create ?? createRuntime)({
        config,
        env,
        credentials: new ChainCredentialProvider(providers),
      }).then((runtime) => {
        current = runtime;
        return runtime;
      });
    }
    return pending;
  };

  const shutdown = async (): Promise<void> => {
    closed = true;
    if (!pending) return;
    let runtime: ProxyRuntime;
    try {
      runtime = await pending;
    } catch {
      pending = undefined;
      current = undefined;
      return;
    }
    try {
      await runtime.shutdown();
    } catch {
      throw new Error("proxy cleanup pending");
    }
    pending = undefined;
    current = undefined;
  };

  pi.on("session_start", async () => {
    await shutdown();
    closed = false;
  });
  pi.on("session_shutdown", shutdown);

  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  });

  pi.registerTool({
    name: "proxy_runtime_status",
    label: "Proxy runtime status",
    description: "Report session runtime ownership and cleanup state without reading or exposing proxy credentials or environment values.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return result({ initialized: Boolean(current), initializing: Boolean(pending && !current), closed, runtime: current?.status() });
    },
  });
  pi.registerTool({
    name: "proxy_runtime_diagnose",
    label: "Proxy runtime diagnose",
    description: "Run bounded configured DNS, TCP, controller, node and GitHub HTTPS checks without changing environment or selecting nodes.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal) {
      try {
        const runtime = await getRuntime();
        return result(publicDiagnostics(await runtime.diagnose(signal), target));
      } catch {
        throw new Error("proxy diagnostics failed");
      }
    },
  });
  pi.registerTool({
    name: "proxy_runtime_recover",
    label: "Proxy runtime recover",
    description: "After user confirmation, switch the configured selector or start caller-configured isolated fallback, verify GitHub HTTPS and retain process-local child proxy environment. Does not replay the failed caller operation.",
    parameters: Type.Object({
      idempotent: Type.Boolean({ description: "Explicitly classify the caller operation; this tool never replays it." }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("proxy recovery cancelled");
      if (!ctx.hasUI) return result({ recovered: false, reason: "confirmation-required" });
      let approved = false;
      try {
        approved = await ctx.ui.confirm(
          "Recover Agent proxy?",
          "May change the configured external selector, start an owned Mihomo process and change this Pi process's child proxy environment. External selector changes are not rolled back.",
        );
      } catch {
        throw new Error("proxy confirmation failed");
      }
      if (!approved) return result({ recovered: false, reason: "permission-denied" });
      if (signal?.aborted) throw new Error("proxy recovery cancelled");
      try {
        const runtime = await getRuntime();
        return result(await runtime.recover({ idempotent: params.idempotent, signal }));
      } catch {
        throw new Error("proxy recovery failed");
      }
    },
  });
}

export default function proxyExtension(pi: ExtensionAPI): void {
  registerProxyTools(pi);
}
