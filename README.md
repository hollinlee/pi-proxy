# pi-proxy

Explicit Agent GitHub proxy recovery for Pi. Requires Node.js >=22.19. The package exposes a dependency-injected runtime and loads its adapter through `pi.extensions`. Fallback Mihomo process management is macOS-only; controller and diagnostics can run on other platforms.

## Configuration

There are no implicit local proxy defaults. Set `PROXY_HOST` and `PROXY_PORT` together for an existing HTTP or mixed proxy. Configure `PI_PROXY_CONTROLLER_URL` and `PI_PROXY_NODE_GROUP` for a Mihomo REST controller and selector group. Controller secret references resolve `PI_PROXY_SECRET_<ref>` first and macOS Keychain service `pi-proxy-<ref>` second. Keychain exit code 44 means “item not found”; other Keychain failures are reported as a generic credential-provider error without stdout/stderr. If the optional controller secret is missing, requests are unauthenticated; the controller must be configured to permit that, otherwise authentication fails. Never put credentials in URLs, tool arguments, shell arguments, or committed config.

`PI_PROXY_GITHUB_URL` defaults to `https://github.com/`. `PI_PROXY_CANDIDATE_LIMIT` defaults to 3 (maximum 16). Timeout defaults and maxima are: `PI_PROXY_REQUEST_TIMEOUT_MS` 5000/60000, `PI_PROXY_CONTROLLER_READY_TIMEOUT_MS` 10000/120000, `PI_PROXY_NODE_DELAY_TIMEOUT_MS` 5000/60000, `PI_PROXY_RECOVERY_TIMEOUT_MS` 30000/300000, and `PI_PROXY_SHUTDOWN_TIMEOUT_MS` 3000/30000. Values must be positive integers. Controller REST requests currently have a fixed 5000 ms request cap; the recovery deadline also bounds the whole transaction.

## Isolated fallback

Set `PI_PROXY_FALLBACK_CONFIG` to an absolute caller-owned config path. `PI_PROXY_FALLBACK_BINARY` defaults to `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo`; `PI_PROXY_FALLBACK_CONTROLLER_HOST` must be `127.0.0.1`; optional `PI_PROXY_FALLBACK_CONTROLLER_PORT` selects a port and `PI_PROXY_FALLBACK_DATA_DIR` selects an absolute existing parent. Programmatic callers may supply a path or YAML content. The fallback accepts inline proxy nodes, one selector group, and omitted rules or the selector's exact `MATCH` rule. Credentials in `password`, `username`, or `uuid` must use `credential://ref`. Supported node types are `http`, `socks5`, `ss`, `trojan`, `vmess`, and `vless`; providers, subscriptions, plugins, DNS/TUN/listeners, aliases, external files, and unknown fields are rejected.

Agent creates a private directory and generated controller secret, then validates readiness and process ownership. It never adopts or changes Clash Verge-owned state. This is ownership isolation, not an OS sandbox.

## Pi tools and lifecycle

- `proxy_runtime_status` reports initialization, ownership, and cleanup booleans without environment values.
- `proxy_runtime_diagnose` reports bounded DNS, proxy TCP, controller, node-delay, and GitHub HTTPS checks.
- `proxy_runtime_recover` requires UI confirmation for selector/process/environment changes. Headless execution is denied. Recovery verifies GitHub HTTPS through an explicit Undici `ProxyAgent`; it never replays the caller's failed operation.

Successful process-local proxy environment is inherited by later child processes. `http_proxy`, `https_proxy`, and `all_proxy` are set to the configured HTTP/mixed endpoint; HTTPS-capable HTTP proxy clients use HTTP CONNECT. The HTTPS recovery gate does not rely on environment variables: it uses an explicit Undici `ProxyAgent` dispatcher. External controller selection is never restored, even if later verification fails. Transaction-owned provider failures retain their phase but are generalized to `operation-failed` to avoid exposing injected error text or codes. Only Agent-owned fallback processes and environment snapshots are cleaned at session shutdown; failed cleanup remains retryable.

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
