# 07 Configuration & Usage

> This document summarizes freebuff2api's configuration options, common
> commands, and usage examples. Implementation lives in `src/config.ts`.

## Quick start

```bash
bun install

# Option A (recommended): device-code login, credentials saved to
# ~/.config/freebuff2api/credentials.json
bun run login

# Option B: provide a token directly
# export AUTH_TOKENS="<your freebuff.com token>"

bun run dev        # or bun run src/index.ts
```

```bash
curl http://localhost:8080/v1/models
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

Point any OpenAI-compatible client at `http://localhost:8080/v1`.

## Configuration priority

```
environment variables > config.json (cwd or ~/.freebuff2api/) > login credentials > defaults
```

## Environment variables

| Variable | Default | Description |
| ---- | ------ | ---- |
| `AUTH_TOKENS` | login credentials | Comma-separated Freebuff tokens; rotation across tokens + 401 cooldown |
| `UPSTREAM_BASE_URL` | `https://www.codebuff.com` | Upstream backend URL |
| `LOGIN_BASE_URL` | `https://freebuff.com` | Base URL for the login flow |
| `LISTEN_ADDR` | `:8080` | Listen address (affected by `PORT` in managed environments) |
| `REQUEST_TIMEOUT` | `15m` | Upstream request timeout (Go-style durations) |
| `ROTATION_INTERVAL` | `6h` | Run rotation interval |
| `API_KEYS` | empty = open | Optional keys clients must present to the proxy |
| `HTTP_PROXY` | empty | Upstream HTTP(S) proxy (natively supported by Bun fetch) |
| `USER_AGENT` | see below | Override the chat request User-Agent |
| `DEBUG_UPSTREAM` | off | `1` prints upstream request details (token redacted) |

Default `USER_AGENT` (matches the official SDK; any version is verified to
pass the gate):

```
ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser
```

## Common commands

| Command | Description |
| ---- | ---- |
| `freebuff2api` / `bun run src/index.ts` | Start the proxy |
| `freebuff2api login` | Device-code login |
| `freebuff2api login --resume` | Resume an interrupted login |
| `freebuff2api login --force` | Log in fresh (switch account / refresh token) |
| `freebuff2api --help` | Help |
| `bun run typecheck` | Type check |
| `bun run build` | Bundle to `dist/index.js` (node target) |
| `DEBUG_UPSTREAM=1 bun run src/index.ts` | Start with upstream debug logs |

## Proxy endpoints

| Method | Path | Description |
| ---- | ---- | ---- |
| GET | `/healthz` | Liveness + model registry + per-token session state |
| GET | `/v1/models` | Available models (OpenAI format) |
| POST | `/v1/chat/completions` | Chat (streaming / non-streaming) |

## Deployment notes

- Build artifact: `bun run build` → `dist/index.js` (pointed to by
  `bin.freebuff2api` in `package.json`)
- Production: use the `freebuff-deploy` tooling to configure the build
  command (build = `bun run build`) and listen port; the runtime doesn't
  depend on external services
- Production env vars are managed separately from the sandbox `.env` via the
  `freebuff-deploy env` commands

## Security notes

- The token equals API usage rights on your account — keep it secret, never
  commit it to the repo
- Don't store plaintext tokens in `.env` and commit them; prefer managed
  environment variables or the login credentials
- The free tier is rate-limited (verified: deepseek-v4-flash gets roughly 6
  base requests per day, reset on Pacific time) — use it sparingly
