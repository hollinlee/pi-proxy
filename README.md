# pi-proxy

Pi extension that injects a configured HTTP proxy into agent commands that may access the network.

## Configuration

Set both variables:

```sh
export PROXY_HOST=127.0.0.1
export PROXY_PORT=7897
```

The extension does not start a proxy, switch nodes, modify `process.env`, or maintain fallback processes. It only rewrites the command passed to Pi's built-in `bash` tool.

## Command injection

The following command families receive `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and lowercase equivalents:

```text
curl wget git gh
npm pnpm yarn bun npx
pip pip3 pipx uv poetry
cargo go gem composer
docker podman helm kubectl terraform ansible-galaxy brew
```

Example:

```sh
export HTTP_PROXY='http://127.0.0.1:7897' HTTPS_PROXY='http://127.0.0.1:7897' ...
git clone https://github.com/example/repo
```

Local commands such as `ls` and `rg` are not modified. `npm` is always treated as network-capable because install and registry operations use the same executable. Commands that already provide a proxy variable are left unchanged. Only `bash` tool calls are intercepted; custom tools and remote execution are not.

## Verification

```sh
npm test
npm run check:load
```
