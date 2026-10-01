import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, redact } from "./contracts.ts";
import { readRuntimeConfig } from "./config.ts";
import { ChainCredentialProvider, EnvironmentCredentialProvider, MacOSKeychainCredentialProvider } from "./credentials.ts";
test("explicit defaults and secret references", () => {
  const config = readRuntimeConfig({ PROXY_HOST: "127.0.0.1", PROXY_PORT: "7897", PI_PROXY_CONTROLLER_URL: "http://127.0.0.1:9090", PI_PROXY_NODE_GROUP: "select", PI_PROXY_CONTROLLER_SECRET_REF: "main" });
  assert.equal(config.githubUrl, "https://github.com/"); assert.equal(config.controller?.secretRef, "main"); assert.equal("secret" in config.controller!, false); assert.deepEqual(config.proxy, { host: "127.0.0.1", port: 7897 });
});
test("reject malformed, unsafe and partial config", () => {
  for (const env of [{ PROXY_PORT: "3abc", PROXY_HOST: "localhost" }, { PROXY_PORT: "", PROXY_HOST: "localhost" }, { PROXY_PORT: "65536", PROXY_HOST: "localhost" }, { PROXY_HOST: "localhost" }, { PI_PROXY_GITHUB_URL: "http://github.com" }, { PI_PROXY_CONTROLLER_URL: "http://u:p@localhost" }, { PI_PROXY_CANDIDATE_LIMIT: "17" }]) assert.throws(() => readRuntimeConfig(env), ConfigError);
  assert.throws(() => readRuntimeConfig({}, { fallback: { executable: "/bin/core", source: { kind: "content", yaml: "x: y" }, controllerHost: "127.0.0.1", controllerPort: 65536 } }), ConfigError);
  assert.equal(readRuntimeConfig({}, { fallback: { executable: "/bin/core", source: { kind: "content", yaml: "x: y" }, controllerHost: "127.0.0.1" } }).fallback?.source.kind, "content");
  for (const fallback of [null, {}, { executable: "/bin/core", controllerHost: "127.0.0.1" }, { executable: "/bin/core", source: { kind: "unknown", value: "x" }, controllerHost: "127.0.0.1" }, { executable: "relative/core", source: { kind: "content", yaml: "x: y" }, controllerHost: "127.0.0.1" }, { executable: "/bin/core", source: { kind: "content", yaml: "x: y" }, controllerHost: "127.0.0.1", controllerPort: "9000" }]) {
    assert.throws(() => readRuntimeConfig({}, { fallback } as any), ConfigError);
  }
});
test("redacts nested values, keys, errors and overlapping secrets", () => {
  assert.deepEqual(redact({ message: "secret-long", token: "hidden", nested: ["secret"] }, ["secret", "secret-long"]), { message: "[REDACTED]", token: "[REDACTED]", nested: ["[REDACTED]"] });
  assert.deepEqual(redact({ abc: "abc" }, ["abc"]), { "[REDACTED]": "[REDACTED]" });
  assert.deepEqual(redact(Object.assign(new Error("secret"), { name: "secret" }), ["secret"]), { name: "[REDACTED]", message: "[REDACTED]" });
});
test("env precedes Keychain and missing item differs from operational failure", async () => {
  let calls = 0;
  const keychain = new MacOSKeychainCredentialProvider(async (_file, args, options) => { calls++; assert.equal(args.at(-1), "-w"); assert.equal(options.timeout, 5000); return { stdout: "key-secret\n", stderr: "" }; });
  assert.equal(await new ChainCredentialProvider([new EnvironmentCredentialProvider({ PI_PROXY_SECRET_main: "env-secret" }), keychain]).get("main"), "env-secret"); assert.equal(calls, 0); assert.equal(await keychain.get("main"), "key-secret");
  assert.equal(await new MacOSKeychainCredentialProvider(async () => { throw Object.assign(new Error("private"), { code: 44 }); }).get("main"), undefined);
  for (const code of ["ENOENT", "EIO"]) await assert.rejects(() => new MacOSKeychainCredentialProvider(async () => { throw Object.assign(new Error("private"), { code }); }).get("main"), (error: unknown) => error instanceof Error && error.message === "credential provider failed" && !JSON.stringify(error).includes("private"));
});
