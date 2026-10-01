import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { readRuntimeConfig } from "./config.ts";
import { FallbackError, startFallbackCore, type FallbackOperations } from "./fallback-core.ts";
const source = "proxies:\n  - {name: one, type: http, server: example.com, port: 443, password: 'credential://node'}\nproxy-groups:\n  - {name: select, type: select, proxies: [one]}\n";
async function fixture(t: import("node:test").TestContext, mode = "normal") {
  const parent = await mkdtemp(join(tmpdir(), "fallback-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const calls: string[][] = [], kills: string[] = [];
  let cwd = "", command = "", executable = "", exited = false, secret = "", ports: number[] = [], started = "original", fetches = 0, terminating = false;
  let foreignListener = false;
  const ops: FallbackOperations = {
    platform: "darwin",
    async run(_file, args) { calls.push(args); if (args[0] === "-h") return mode === "unsupported" ? "help" : " -f file\n -d directory\n -t test"; if (mode === "invalid") throw new Error("private-secret"); return ""; },
    launch(file, args, directory) {
      cwd = directory; executable = file; command = [file, ...args].join(" ");
      if (mode === "exit") exited = true;
      return { pid: 4242, get exited() { return exited; } };
    },
    async identity() { return { command, executable, start: started, pgid: 4242 }; },
    async listeners() {
      const doc = parse(await readFile(join(cwd, "config.yaml"), "utf8"));
      secret = doc.secret; ports = [Number(doc["external-controller"].split(":")[1]), doc["mixed-port"]];
      if (foreignListener) return ["127.0.0.1:1"];
      if (terminating || mode === "missing-port") return [];
      return ports.map((port) => `127.0.0.1:${port}`);
    },
    killGroup(_pid, signal) { kills.push(signal); terminating = true; if (mode !== "escalate" || signal === "SIGKILL") exited = true; },
  };
  const config = readRuntimeConfig({}, { fallback: { executable: "/bin/echo", source: { kind: "content", yaml: source }, controllerHost: "127.0.0.1", dataDirectory: parent } });
  config.timeouts = { requestMs: 20, controllerReadyMs: 1000, nodeDelayMs: 20, recoveryMs: 1000, shutdownMs: 20 };
  const deps = { credentials: { get: async () => "private-secret" }, fetch: async (_url: unknown, init?: RequestInit) => {
    fetches++;
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    if (mode === "unready") return new Response(null, { status: 503 });
    if (mode === "warming" && fetches < 4 && String(_url).endsWith("/proxies")) return new Response(JSON.stringify({ proxies: {} }));
    return new Response(JSON.stringify(String(_url).endsWith("/version") ? { version: "test" } : { proxies: { select: { type: "Selector", all: ["one"], now: "one" } } }));
  } };
  return { parent, config, deps, ops, calls, kills, dir: () => cwd, setForeign: (value: boolean) => { foreignListener = value; }, setIdentity: (value: string) => { started = value; }, setExited: () => { exited = true; }, fetches: () => fetches };
}
test("private config, provider credentials, authenticated readiness, secret-free handle and idempotent stop", async (t) => {
  const f = await fixture(t);
  const runtime = await startFallbackCore(f.config, f.deps, { operations: f.ops });
  const doc = parse(await readFile(join(f.dir(), "config.yaml"), "utf8"));
  assert.equal(doc.password, undefined); assert.equal(doc.proxies[0].password, "private-secret");
  assert.equal(doc["allow-lan"], false); assert.equal(doc.mode, "rule"); assert.deepEqual(doc.rules, ["MATCH,select"]);
  assert.equal((await stat(f.dir())).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.dir(), "config.yaml"))).mode & 0o777, 0o600);
  assert.equal(runtime.nodeGroup, "select"); assert.equal(runtime.proxy.port, doc["mixed-port"]);
  assert.ok(f.fetches() >= 2); assert.equal(JSON.stringify(runtime).includes("private-secret"), false);
  assert.equal(JSON.stringify(runtime).includes(doc.secret), false); assert.equal(JSON.stringify(runtime.controller).includes(doc.secret), false);
  assert.equal(JSON.stringify(f.calls).includes("private-secret"), false);
  await Promise.all([runtime.stop(), runtime.stop()]); await runtime.stop();
  assert.deepEqual(f.kills, ["SIGTERM"]); assert.deepEqual(await readdir(f.parent), []);
});
test("unsupported CLI and validation failure remove only owned subdirectory", async (t) => {
  for (const mode of ["unsupported", "invalid"]) {
    const f = await fixture(t, mode);
    await assert.rejects(startFallbackCore(f.config, f.deps, { operations: f.ops }), (error: unknown) => error instanceof FallbackError && !JSON.stringify(error).includes("private-secret"));
    assert.deepEqual(await readdir(f.parent), []); assert.deepEqual(f.kills, []);
  }
});
test("pre-abort and readiness deadline clean owned state", async (t) => {
  const a = await fixture(t);
  await assert.rejects(startFallbackCore(a.config, a.deps, { operations: a.ops, signal: AbortSignal.abort() }), (error: unknown) => error instanceof FallbackError && error.code === "cancelled");
  assert.deepEqual(await readdir(a.parent), []);
  const b = await fixture(t, "unready"); b.config.timeouts.controllerReadyMs = 80;
  await assert.rejects(startFallbackCore(b.config, b.deps, { operations: b.ops }), (error: unknown) => error instanceof FallbackError && error.code === "startup-timeout");
  assert.deepEqual(b.kills, ["SIGTERM"]); assert.deepEqual(await readdir(b.parent), []);
});
test("escalates only verified child, refuses changed identity, and permits retry", async (t) => {
  const a = await fixture(t, "escalate"); const owned = await startFallbackCore(a.config, a.deps, { operations: a.ops });
  await owned.stop(); assert.deepEqual(a.kills, ["SIGTERM", "SIGKILL"]);
  const b = await fixture(t); const runtime = await startFallbackCore(b.config, b.deps, { operations: b.ops });
  b.setIdentity("reused-pid");
  await assert.rejects(runtime.stop(), (error: unknown) => error instanceof FallbackError && error.code === "ownership-unconfirmed");
  assert.deepEqual(b.kills, []); assert.equal((await readdir(b.parent)).length, 1);
  b.setIdentity("original"); await runtime.stop(); assert.deepEqual(await readdir(b.parent), []);
});
test("rejects unsafe config, inline credentials, aliases, providers and unsupported platforms before spawn", async (t) => {
  const f = await fixture(t);
  for (const yaml of [source + "tun: {enable: true}\n", source + "listeners: []\n", source + "proxy-providers: {}\n", source.replace("credential://node", "literal-secret"), "proxies: &a [*a]\nproxy-groups: []\n", source.replace("type: http", "type: ss, plugin: external")]) {
    f.config.fallback!.source = { kind: "content", yaml };
    await assert.rejects(startFallbackCore(f.config, f.deps, { operations: f.ops }), FallbackError);
  }
  await assert.rejects(startFallbackCore(f.config, f.deps, { operations: { ...f.ops, platform: "linux" } }), (error: unknown) => error instanceof FallbackError && error.code === "platform-unsupported");
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.parent), []);
});
test("initialization failure, early child exit and hanging credential provider clean up", async (t) => {
  const a = await fixture(t); a.ops.prepareDirectory = async () => { throw new Error("private-secret"); };
  await assert.rejects(startFallbackCore(a.config, a.deps, { operations: a.ops }), FallbackError);
  assert.deepEqual(await readdir(a.parent), []);
  const b = await fixture(t, "exit");
  await assert.rejects(startFallbackCore(b.config, b.deps, { operations: b.ops }), (error: unknown) => error instanceof FallbackError && error.code === "startup-exited");
  assert.deepEqual(await readdir(b.parent), []); assert.deepEqual(b.kills, []);
  const c = await fixture(t); c.config.timeouts.controllerReadyMs = 50;
  c.deps.credentials.get = async () => new Promise<string>(() => {});
  await assert.rejects(startFallbackCore(c.config, c.deps, { operations: c.ops }), (error: unknown) => error instanceof FallbackError && error.code === "startup-timeout");
  assert.deepEqual(await readdir(c.parent), []);
});
test("in-flight caller cancellation and absent owned listener clean up", async (t) => {
  const a = await fixture(t); const abort = new AbortController();
  a.deps.fetch = async () => { abort.abort(); return new Response(null, { status: 503 }); };
  await assert.rejects(startFallbackCore(a.config, a.deps, { operations: a.ops, signal: abort.signal }), (error: unknown) => error instanceof FallbackError && error.code === "cancelled");
  assert.deepEqual(a.kills, ["SIGTERM"]); assert.deepEqual(await readdir(a.parent), []);
  const b = await fixture(t, "missing-port"); b.config.timeouts.controllerReadyMs = 80;
  await assert.rejects(startFallbackCore(b.config, b.deps, { operations: b.ops }), (error: unknown) => error instanceof FallbackError && error.code === "startup-timeout");
  assert.deepEqual(b.kills, ["SIGTERM"]); assert.deepEqual(await readdir(b.parent), []);
});
test("readiness refreshes initially absent selector and preserves failed-start cleanup handle", async (t) => {
  const a = await fixture(t, "warming"); const ready = await startFallbackCore(a.config, a.deps, { operations: a.ops });
  assert.ok(a.fetches() >= 4); await ready.stop();
  const b = await fixture(t); b.setForeign(true);
  let failed: FallbackError | undefined;
  try { await startFallbackCore(b.config, b.deps, { operations: b.ops }); } catch (error) { assert.ok(error instanceof FallbackError); failed = error; }
  assert.equal(failed?.code, "ownership-unconfirmed"); assert.equal(typeof failed?.retryCleanup, "function");
  assert.deepEqual(b.kills, []); assert.equal((await readdir(b.parent)).length, 1);
  b.setForeign(false); await failed!.retryCleanup!();
  assert.deepEqual(b.kills, ["SIGTERM"]); assert.deepEqual(await readdir(b.parent), []);
});
