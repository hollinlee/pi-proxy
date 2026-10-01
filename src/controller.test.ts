import assert from "node:assert/strict";
import test from "node:test";
import { createControllerProvider, ControllerError } from "./controller.ts";
import { runDiagnostics } from "./diagnostics.ts";
import type { RuntimeDependencies } from "./contracts.ts";

const config = { baseUrl: "http://127.0.0.1:9090", nodeGroup: "select", secretRef: "main" } as const;

function response(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function deps(fetch: typeof globalThis.fetch): RuntimeDependencies {
  return { fetch, credentials: { get: async (ref) => ref === "main" ? "secret-value" : undefined }, now: () => 1000 };
}
function runtimeConfig(overrides: Record<string, unknown> = {}) {
  return { githubUrl: "https://github.com/", proxy: { host: "127.0.0.1", port: 7897 }, controller: config, candidateLimit: 3, timeouts: { requestMs: 50, controllerReadyMs: 50, nodeDelayMs: 50, recoveryMs: 100, shutdownMs: 50 }, ...overrides } as any;
}

test("authenticates, reads version/proxies, selects and confirms group", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let selected = "old";
  const provider = await createControllerProvider(config, deps(async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/version")) return response({ version: "mihomo-test" });
    if (String(input).endsWith("/proxies/select")) {
      selected = JSON.parse(String(init?.body)).name;
      return response({}, 204);
    }
    return response({ proxies: { select: { type: "Selector", all: ["old", "new"], now: selected }, new: { type: "Direct" } } });
  }));
  assert.deepEqual(await provider.capabilities(), { version: "mihomo-test", canSelectProxy: true, canDelayProxy: true });
  assert.equal((await provider.proxies())[0].name, "select");
  await provider.select("select", "new");
  assert.equal((await provider.proxies())[0].now, "new");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer secret-value");
});

test("validates delay and maps status, malformed JSON and pre-cancel", async () => {
  const provider = await createControllerProvider(config, deps(async (input) => {
    if (String(input).includes("delay")) return response({ delay: 42 });
    return response({}, 503);
  }));
  await assert.rejects(() => provider.capabilities(), (error) => error instanceof ControllerError && error.code === "controller-http-status" && error.status === 503);
  assert.equal(await provider.delay("new", "https://github.com/", 5000), 42);
  const malformed = await createControllerProvider(config, deps(async () => new Response("not-json")));
  await assert.rejects(() => malformed.capabilities(), (error) => error instanceof ControllerError && error.code === "controller-invalid-json");
  await assert.rejects(() => provider.capabilities(AbortSignal.abort()), (error) => error instanceof ControllerError && error.code === "controller-cancelled");
});

test("diagnostics keep controller/node/https checks separate and use explicit dispatcher", async () => {
  const dispatcher = { close: async () => {} };
  const controller = {
    capabilities: async () => ({ version: "x", canSelectProxy: true, canDelayProxy: true }),
    proxies: async () => [{ name: "select", all: ["new"], now: "new" }],
    select: async () => {},
    delay: async () => 12,
  };
  const result = await runDiagnostics(runtimeConfig(), deps(async () => response({ version: "x" })), controller, {
    dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
    httpsFetch: async (_url, init) => {
      assert.equal((init as RequestInit & { dispatcher?: unknown }).dispatcher, dispatcher);
      return response({}, 204);
    },
    proxyAgentFactory: () => dispatcher,
  });
  assert.equal(result.controller?.ok, true);
  assert.equal(result.node?.ok, true);
  assert.equal(result.github.ok, true);
});

test("diagnostics report bounded DNS, TCP and HTTPS failures without secret", async () => {
  const result = await runDiagnostics(runtimeConfig(), deps(async () => { throw new Error("secret-value"); }), undefined, {
    dnsLookup: async () => { throw new Error("dns"); },
    httpsFetch: async () => { throw new Error("secret-value"); },
    proxyAgentFactory: () => ({ close: async () => {} }),
  });
  assert.equal(result.dns.code, "dns-failed");
  assert.equal(result.github.code, "https-failed");
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("diagnostics bound a hanging DNS lookup", async () => {
  const result = await runDiagnostics(runtimeConfig({ timeouts: { requestMs: 10, controllerReadyMs: 10, nodeDelayMs: 10, recoveryMs: 20, shutdownMs: 10 } }), deps(async () => response({}, 204)), undefined, {
    dnsLookup: async () => await new Promise<never>(() => {}),
    httpsFetch: async () => response({}, 204),
    proxyAgentFactory: () => ({ close: async () => {} }),
  });
  assert.equal(result.dns.code, "timeout");
});
