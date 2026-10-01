import assert from "node:assert/strict";
import test from "node:test";
import { registerProxyTools } from "./extension.ts";
import type { ProxyRuntime } from "./recovery.ts";

const diagnostic = { target: "github.com", dns: { ok: true }, proxy: { ok: true }, github: { ok: true } };

test("adapter clears rejected runtime creation and retries on the next request", async () => {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  let attempts = 0;
  const runtime: ProxyRuntime = {
    status: () => ({ busy: false, closed: false, ownsFallback: false, cleanupPending: false, retainedEnvironment: false }),
    diagnose: async () => diagnostic,
    recover: async () => ({ recovered: true, events: [], retainedEnvironment: true }),
    shutdown: async () => {},
  };
  registerProxyTools({
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  } as any, {
    env: {},
    create: async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient initialization failure");
      return runtime;
    },
  });
  const diagnose = tools.get("proxy_runtime_diagnose");
  await assert.rejects(diagnose.execute("first", {}, undefined, undefined, {}), /proxy diagnostics failed/);
  assert.equal((await diagnose.execute("second", {}, undefined, undefined, {})).details.github.ok, true);
  assert.equal(attempts, 2);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
});
