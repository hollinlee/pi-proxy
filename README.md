# pi-proxy

Explicit Agent GitHub proxy recovery for Pi. Requires Node.js >=22.19. The package exposes a dependency-injected runtime and loads its adapter through `pi.extensions`. Fallback Mihomo process management is macOS-only; controller and diagnostics can run on other platforms.

## Configuration

There are no implicit local proxy defaults. Set `PROXY_HOST` and `PROXY_PORT` together for an existing HTTP or mixed proxy. Configure `PI_PROXY_CONTROLLER_URL` and `PI_PROXY_NODE_GROUP` for a Mihomo REST controller and selector group. Controller secret references resolve `PI_PROXY_SECRET_<ref>` first and macOS Keychain service `pi-proxy-<ref>` second. Never put credentials in URLs, tool arguments, shell arguments, or committed config.

`PI_PROXY_GITHUB_URL` defaults to `https://github.com/`. Candidate count and timeouts use the bounded `PI_PROXY_CANDIDATE_LIMIT` and `PI_PROXY_*_TIMEOUT_MS` settings validated by `src/config.ts`.

## Isolated fallback

Set `PI_PROXY_FALLBACK_CONFIG` to an absolute caller-owned config path. The default executable is `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo`; it can be overridden by `PI_PROXY_FALLBACK_BINARY`. The controller binds to loopback only. The fallback accepts inline proxy nodes, one selector group, and omitted rules or the selector's exact `MATCH` rule. Credentials must use `credential://ref`; providers, subscriptions, plugins, DNS/TUN/listeners, aliases, external files, and unknown fields are rejected.

Agent creates a private directory and generated controller secret, then validates readiness and process ownership. It never adopts or changes Clash Verge-owned state. This is ownership isolation, not an OS sandbox.

## Pi tools and lifecycle

- `proxy_runtime_status` reports initialization, ownership, and cleanup booleans without environment values.
- `proxy_runtime_diagnose` reports bounded DNS, proxy TCP, controller, node-delay, and GitHub HTTPS checks.
- `proxy_runtime_recover` requires UI confirmation for selector/process/environment changes. Headless execution is denied. Recovery verifies GitHub HTTPS through an explicit Undici `ProxyAgent`; it never replays the caller's failed operation.

Successful process-local proxy environment is inherited by later child processes. External controller selection is not rolled back. Only Agent-owned fallback processes and environment snapshots are cleaned at session shutdown; failed cleanup remains retryable.

## Runtime API

```ts
const runtime = await createRuntime({ config, credentials, env: process.env });
const result = await runtime.recover({ idempotent: true, signal });
if (!result.recovered) throw new Error(result.failure?.message ?? "proxy recovery failed");
```

## Verification

```sh
npm test
npm run check:load
npm pack --dry-run --json
```

Unit tests use injected dependencies and do not contact GitHub or start a real Mihomo process. Before release, verify the installed binary's help/config-validation flags, authenticated readiness, and ownership-safe TERM/KILL cleanup using a caller-owned isolated config. This smoke test is not proof of OS sandboxing.
