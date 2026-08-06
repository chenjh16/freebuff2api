# freebuff2api

[![CI](https://github.com/chenjh16/freebuff2api/actions/workflows/ci.yml/badge.svg)](https://github.com/chenjh16/freebuff2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/freebuff2api.svg)](https://www.npmjs.com/package/freebuff2api)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.0-black.svg)](https://bun.sh)

OpenAI-compatible reverse proxy for the **Freebuff** coding API
([freebuff.com](https://freebuff.com), the free AI coding agent). It exposes a
standard OpenAI `/v1` surface and relays requests to the Freebuff backend using
a free account's auth token — so any OpenAI-compatible client (Claude Code,
Cline, LobeChat, curl, …) can drive Freebuff's free models.

> 📖 **中文文档见 [`docs/`](docs/README.md)** —— 包含完整的上游协议逆向分析、
> 免费模式网关破解过程、端到端测试记录。调试与分析工具见
> [`tools/`](tools/README.md)。

Zero runtime dependencies. Written in TypeScript for [Bun](https://bun.sh)
(also runs on Node 22+ with `node --experimental-strip-types` or after
`bun run build`).

> This project was implemented against the live Freebuff backend protocol
> (verified against the official [`CodebuffAI/freebuff`](https://github.com/CodebuffAI/freebuff)
> client source). It is a third-party tool, not affiliated with Freebuff.
> Free access can be gated by the service at any time — use responsibly.

## How it works

Freebuff's free tier is session-gated. For every chat request the proxy:

1. **Acquires a free session** — `POST /api/v1/freebuff/session` with your
   token. If the service is under load it returns `queued` (the "waiting
   room"); the proxy answers the client with `503` + `Retry-After` and keeps
   polling so retries succeed.
2. **Starts an agent run** — `POST /api/v1/agent-runs` (`action: START`) for
   the agent that owns the requested model. Runs are reused across requests
   and rotated/finished automatically.
3. **Forwards the request** — `POST /api/v1/chat/completions` with your
   OpenAI payload plus the `codebuff_metadata` block the backend expects
   (`run_id`, `client_id`, `cost_mode: "free"`, `freebuff_instance_id`).
   Streaming (SSE) passes straight through.

   > **CLI gate (verified against the live backend):** the free-tier endpoint
   > rejects requests that don't look like they came from the official CLI
   > (`403 free_mode_cli_required`). The check is the **system message**: it
   > must contain the exact phrase `You are Buffy, the strategic coding
   > assistant` (the official agent's system-prompt opening). The proxy
   > automatically prepends/merges this marker into the client's messages, so
   > ordinary OpenAI clients don't need to know about it.
4. **Rotates tokens** — with multiple `AUTH_TOKENS`, requests round-robin
   across tokens; a token that gets rejected upstream (401) is cooled down for
   30 minutes instead of poisoning every request.

## Quick start

```bash
bun install

# Option A (recommended): sign in with a device-code login flow.
# Prints a URL to open in your browser; credentials are stored at
# ~/.config/freebuff2api/credentials.json.
bun run login

# Option B: provide a token directly
# export AUTH_TOKENS="<your freebuff.com token>"

bun run dev        # or: bun run src/index.ts
```

```bash
curl http://localhost:8080/v1/models
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

Point any OpenAI-compatible client at `http://localhost:8080/v1`.

## Login

`freebuff2api login` implements the same device-code login flow as the
official Freebuff CLI (verified against the `CodebuffAI/freebuff` client
source):

1. `POST /api/auth/cli/code` with a persistent install fingerprint
2. prints a one-time URL (`freebuff.com/login?auth_code=…`) to open in your
   browser — no need to hand the token around manually
3. polls `GET /api/auth/cli/status` until you complete the sign-in, then saves
   the account record to `~/.config/freebuff2api/credentials.json`

```bash
bun run login                       # start login and wait for the browser sign-in
bun run login -- --resume           # keep waiting on an interrupted login
bun run login -- --force            # fresh login, ignoring saved credentials
```

The saved token is picked up automatically by the server when `AUTH_TOKENS`
is not set. Use `--force` later to refresh it. (Login uses `LOGIN_BASE_URL`,
which defaults to `https://freebuff.com`.)

## Configuration

Priority: **environment variables** → `config.json` (auto-detected in the
working directory) → saved `login` credentials → defaults.

| Env var             | Default                   | Description                                             |
| ------------------- | ------------------------- | ------------------------------------------------------- |
| `AUTH_TOKENS`       | *(required*¹*)*           | Comma-separated Freebuff auth tokens                    |
| `UPSTREAM_BASE_URL` | `https://www.codebuff.com`| Freebuff backend base URL                              |
| `LOGIN_BASE_URL`    | `https://freebuff.com`    | Base URL used by `freebuff2api login`                   |
| `LISTEN_ADDR`       | `:8080`                   | Listen address (`PORT` env wins in managed workspaces) |
| `REQUEST_TIMEOUT`   | `15m`                     | Upstream request timeout (Go-style durations)          |
| `ROTATION_INTERVAL` | `6h`                      | How long an agent run lives before rotation            |
| `API_KEYS`          | *(empty = open)*          | Comma-separated keys clients must present to the proxy |
| `HTTP_PROXY`        | *(empty)*                 | Optional upstream HTTP(S) proxy (Bun honors natively)  |

See [`config.example.json`](config.example.json) and [`env.example`](env.example).

¹`AUTH_TOKENS` is required unless you have run `freebuff2api login`, in which
case the saved credentials are used.

The token is a freebuff.com account token (the same one your browser session
uses). Keep it secret — it grants API usage on your account.

## Endpoints

| Method | Path                     | Description                                  |
| ------ | ------------------------ | -------------------------------------------- |
| GET    | `/healthz`               | Liveness, model registry + token state       |
| GET    | `/v1/models`             | Models currently available in free mode      |
| POST   | `/v1/chat/completions`   | OpenAI chat completions (streaming supported)|

Models are kept in sync with the official client by fetching
`CodebuffAI/freebuff`'s `free-agents.ts` every 6 hours; a curated fallback
keeps the proxy working if the fetch fails.

## Development

```bash
bun run typecheck   # tsc -b --noEmit
bun run build       # bundles to dist/index.js (node target; bin: freebuff2api)
bun run start       # run the built bundle
bun run login       # device-code login (see above)
bun run check       # typecheck + build
```

## Documentation

- [`docs/`](docs/README.md) — full Chinese documentation: protocol
  reverse-engineering, the free-tier CLI gate crack, e2e test records
- [`tools/`](tools/README.md) — debugging scripts (TLS MITM proxy, gate
  discovery, replay, production-shape verification) and captured artifacts
- [`docs/04-请求格式破解.md`](docs/04-请求格式破解.md) — **the core finding**: how
  the free-tier gate works and the exact request format

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report bugs / request features via
[GitHub Issues](https://github.com/chenjh16/freebuff2api/issues).

## License

[MIT](LICENSE) © 2026 chenjh16

## Roadmap / not yet implemented

- Claude-compatible `/v1/messages` + `/v1/messages/count_tokens` endpoints
- Tool-schema normalization for chat clients that emit complex JSON Schema
- Per-key rate limiting / usage stats
