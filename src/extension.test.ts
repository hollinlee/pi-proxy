import assert from "node:assert/strict";
import test from "node:test";
import { injectProxy, isNetworkCommand, registerProxyExtension } from "./extension.ts";

test("recognizes common network commands", () => {
  assert.equal(isNetworkCommand("git clone https://example.com/repo"), true);
  assert.equal(isNetworkCommand("curl https://example.com"), true);
  assert.equal(isNetworkCommand("npm install"), true);
  assert.equal(isNetworkCommand("printf 'curl https://example.com'"), false);
  assert.equal(isNetworkCommand("npm test"), true);
  assert.equal(isNetworkCommand("ls -la"), false);
});

test("injects all proxy environment spellings", () => {
  const command = injectProxy("git fetch origin", { host: "127.0.0.1", port: 7897 });
  assert.match(command, /^export HTTP_PROXY='http:\/\/127\.0\.0\.1:7897'/);
  assert.match(command, /HTTPS_PROXY='http:\/\/127\.0\.0\.1:7897'/);
  assert.match(command, /all_proxy='http:\/\/127\.0\.0\.1:7897'/);
});

test("only rewrites network bash calls", () => {
  const handlers: Record<string, ((event: any) => void)[]> = {};
  registerProxyExtension({ on(event: string, handler: (value: any) => void) { (handlers[event] ??= []).push(handler); } } as any, { PROXY_HOST: "proxy.local", PROXY_PORT: "8080" });
  const hook = handlers.tool_call[0];
  const network = { toolName: "bash", input: { command: "curl https://example.com" } };
  hook(network);
  assert.match(network.input.command, /^export HTTP_PROXY=/);
  const local = { toolName: "bash", input: { command: "npm test" } };
  hook(local);
  assert.match(local.input.command, /^export HTTP_PROXY=/);
  const shell = { toolName: "bash", input: { command: "ls -la" } };
  hook(shell);
  assert.equal(shell.input.command, "ls -la");
  const read = { toolName: "read", input: { path: "https://example.com" } };
  hook(read);
  assert.equal(read.input.path, "https://example.com");
});

test("does not duplicate explicit proxy environment", () => {
  const handlers: Record<string, ((event: any) => void)[]> = {};
  registerProxyExtension({ on(event: string, handler: (value: any) => void) { (handlers[event] ??= []).push(handler); } } as any, { PROXY_HOST: "proxy.local", PROXY_PORT: "8080" });
  const command = { toolName: "bash", input: { command: "HTTPS_PROXY=http://other git fetch" } };
  handlers.tool_call[0](command);
  assert.equal(command.input.command, "HTTPS_PROXY=http://other git fetch");
});
