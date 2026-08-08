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

bun run dev:cli    # standalone proxy; `bun run dev` is the hosted Next.js app
```

```bash
curl http://localhost:23333/v1/models
curl http://localhost:23333/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"freebuff/deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

Point any OpenAI-compatible client at `http://localhost:23333/v1`.

## Configuration priority

```
General: environment variables > config.json (cwd, then ~/.config/freebuff2api/, then legacy ~/.freebuff2api/) > login credentials > defaults; HTTP_PROXY: `--http-proxy` CLI > config.json > environment
```

## Environment variables

| Variable | Default | Description |
| ---- | ------ | ---- |
| `AUTH_TOKENS` | saved login credentials | Comma-separated Freebuff tokens; optional for allowlisted public models, but needed for Freebuff-only models, authenticated fallback, or a disabled public provider |
| `UPSTREAM_BASE_URL` | `https://www.codebuff.com` | Upstream backend URL |
| `LOGIN_BASE_URL` | `https://freebuff.com` | Base URL for the login flow |
| `LISTEN_ADDR` | `:23333` | Listen address (affected by `PORT` in managed environments) |
| `REQUEST_TIMEOUT` | `15m` | Upstream request timeout (Go-style durations) |
| `ROTATION_INTERVAL` | `6h` | Run rotation interval |
| `API_KEYS` | empty = open in standalone; hosted empty = fail closed | Explicit keys clients must present; configure high-entropy values for hosted deployments |
| `SITE_ACCESS_TOKEN` | empty = gate off | Hosted web console gate token(s), comma-separated. When set, visitors must present one (typed into the lock screen, or via `?token=…`) to unlock the site |
| `PROXY_SECRET` | auto (see 08) | Stable secret that encrypts web-login API keys (`sk-fb-…`); set a fixed value so keys survive redeploys (hosted app only) |
| `PROXY_SECRET_FILE` | `.data/proxy-secret` | Where the fallback secret is persisted when no env secret is set (hosted app only) |
| `HTTP_PROXY` | empty | Upstream HTTP(S) proxy; precedence is `--http-proxy` > config.json > environment |
| `MAX_BODY_SIZE` | `16MB` | Maximum chat request body (16,000,000 bytes) |
| `MAX_CONCURRENT_REQUESTS` | `32` | Maximum in-flight chat requests |
| `PUBLIC_UPSTREAM_ENABLED` | `true` | Fixed anonymous providers are enabled by default; set `false` to disable all public routes |
| `PUBLIC_UPSTREAM_PROVIDERS` | `opencode,pollinations,felo` | Fixed provider ids; arbitrary providers are ignored |
| `PUBLIC_UPSTREAM_BASE_URL` | `https://opencode.ai/zen/v1` | OpenCode-only HTTPS override; Pollinations/Felo endpoints remain fixed |
| `PUBLIC_UPSTREAM_MODELS` | aggregated allowlist | Chat model allowlist — canonical `provider/model` ids; never arbitrary model ids (OpenCode entries may keep their historical bare ids for backward compatibility) |
| `PUBLIC_UPSTREAM_IMAGE_MODELS` | `pollinations/flux,pollinations/turbo,pollinations/zimage` | Image model allowlist for `POST /v1/images/generations` (Pollinations, anonymous) |
| `PUBLIC_UPSTREAM_TIMEOUT` | `20s` | Initial response timeout before another public route or authenticated fallback |
| `USER_AGENT` | see below | Override the chat request User-Agent |
| `DEBUG_UPSTREAM` | off | `1` prints upstream request details (token redacted) |

> `SITE_ACCESS_TOKEN` (web app only) is the hosted console's **front door**:
> when set, `POST /api/gate/verify` checks presented tokens against it
> (constant-time SHA-256 comparison). Visitors either type the token into the
> lock screen or open the site with `?token=…`; once accepted, the browser
> keeps it in `localStorage` and re-verifies it on each visit. It does not
> affect the `/v1` API, which stays protected by `API_KEYS`.

Default `USER_AGENT` (matches the official SDK; any version is verified to
pass the gate):

```
ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser
```

## Public anonymous provider

The proxy aggregates four explicitly fixed capabilities before the authenticated Freebuff session path: OpenCode Zen, keyless Pollinations (chat **and** image generation), and Felo's reverse-engineered web protocol. Every model id is provider-namespaced (`opencode/big-pickle`, `pollinations/openai`, `felo/felo-chat`; Freebuff models are `freebuff/<model>`); unprefixed ids are neither listed nor routable. Set `PUBLIC_UPSTREAM_ENABLED=false` to disable all public routes, or narrow the provider/model lists. `PUBLIC_UPSTREAM_BASE_URL` is restricted to `opencode.ai` and never changes the fixed Pollinations/Felo destinations.

`POST /v1/images/generations` serves the allowlisted image models through `image.pollinations.ai` (anonymous; the upstream call is a plain `GET /prompt/<prompt>?…`, or a `POST` with a JSON body when reference images are attached). It accepts OpenAI image params: `model`, `prompt`, `size` (`WxH`, clamped 256–2048, multiple of 8), `n` (1–4), `seed`, `response_format` (`url` data-URI or `b64_json`; both fields are returned), and `image` — an optional reference image (a data URI or public URL, or an array of up to 4) for **img2img / image editing** (see [09 - Model Catalog](09-model-catalog.md)). Anonymous results carry the Pollinations logo (`nologo` requires an account and is never sent). Image generation uses its own **≥60s** per-image timeout, independent of `PUBLIC_UPSTREAM_TIMEOUT` (default 20s), because anonymous image rendering is slower than chat.

Public clients receive only the provider-specific body and headers. They do not receive downstream `Authorization`, `x-api-key`, cookies, or any Freebuff account token. A timeout, 401, 408, 425, 429, or 5xx response is treated as transient and tries another matching public route before authenticated fallback (image requests surface the failure directly — there is no authenticated image path). A normal 4xx is returned directly. The Pollinations allowlist excludes premium/optional-key models (verified live 2026-08-08: `gemini-flash-lite-3.1` and `perplexity-reasoning` return 401 even for a minimal prompt). Note that Pollinations' anonymous chat tier rejects certain prompt shapes with 401 (e.g. "Reply with exactly: …"); benign prompts work, and the proxy's transient-status fallback/retry covers the rest. Felo has no official API and its web protocol may change. Prompts and code for allowlisted models are sent to the selected third parties; review their current terms and privacy requirements before deployment.

When the public route is enabled, the standalone CLI may start without `AUTH_TOKENS` and can serve allowlisted public models. `AUTH_TOKENS` (or saved login credentials) is still needed for Freebuff-only models and fallback capacity. If the public provider fails without a configured token, the proxy returns a clear retryable error rather than crashing.

## Common commands

| Command | Description |
| ---- | ---- |
| `freebuff2api` / `bun run src/index.ts` | Start the proxy |
| `freebuff2api login` | Device-code login |
| `freebuff2api login --resume` | Resume an interrupted login |
| `freebuff2api login --force` | Log in fresh (switch account / refresh token) |
| `freebuff2api --help` | Help |
| `freebuff2api --port 23333` | Override the listen port |
| `freebuff2api --listen-addr 127.0.0.1:9000` | Override the listen address |
| `freebuff2api --http-proxy http://127.0.0.1:7890` | Override the upstream proxy |
| `node tools/model-availability.mjs` | Probe every model returned by `/v1/models` (consumes quota) |
| `bun run typecheck` | Type check |
| `bun run build:cli` | Bundle to `dist/index.js` (node target) |
| `DEBUG_UPSTREAM=1 bun run src/index.ts` | Start with upstream debug logs |

## Proxy endpoints

| Method | Path | Description |
| ---- | ---- | ---- |
| GET | `/healthz` | Public liveness status |
| GET | `/v1/models` | Available models (OpenAI format) |
| POST | `/v1/chat/completions` | Chat (streaming / non-streaming) |
| POST | `/v1/images/generations` | Image generation (Pollinations, anonymous) |

## Deployment notes

- With the default public provider enabled, the standalone CLI can serve allowlisted OpenCode models without `AUTH_TOKENS`; configure `AUTH_TOKENS` or saved `freebuff2api login` credentials for Freebuff-only models and authenticated fallback. If `PUBLIC_UPSTREAM_ENABLED=false`, the standalone CLI requires a token. `AUTH_TOKENS` remains optional for the hosted Next.js app because each visitor can use web login and a personal `sk-fb-*` key.
- Hosted `/v1` fails closed when `API_KEYS` is unset (web-login `sk-fb-…` keys still work); provision an explicit high-entropy value before exposing the endpoint.
- Build artifact: `bun run build:cli` → `dist/index.js` (pointed to by
  `bin.freebuff2api` in `package.json`)
- Production (hosted): hosting detects the Next.js app and builds it with
  `bun run build` (= `next build`); the CLI bundle is built separately with
  `bun run build:cli`. The runtime doesn't depend on external services
- Production env vars are managed separately from the sandbox `.env` via the
  `freebuff-deploy env` commands

## Security notes

- The token equals API usage rights on your account — keep it secret, never
  commit it to the repo
- Don't store plaintext tokens in `.env` and commit them; prefer managed
  environment variables or the login credentials
- The free tier is rate-limited (verified: deepseek-v4-flash gets roughly 6
  base requests per day, reset on Pacific time) — use it sparingly
