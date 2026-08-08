# 08 — Hosted Deployment (Freebuff)

## Why a Next.js app?

The core proxy is a standalone Bun/Node server (`src/index.ts`). Freebuff
hosting only builds **React projects** (Vite + React, Next.js, Create React
App), so to deploy without a VPS the repository also ships a Next.js App
Router app under `app/` that mounts the **exact same** request handler
(`src/handler.ts`) behind the standard OpenAI surface.

```
┌─────────────────────────── hosted app (Next.js) ───────────────────────────┐
│  GET  /healthz               →  ┐                                          │
│  GET  /v1/models             →  │  app/lib/proxy.ts (lazy singleton)      │
│  POST /v1/chat/completions   →  │  ├─ loadConfig()                        │
│  POST /v1/images/generations →  ┘  ├─ ModelRegistry (free agents)         │
│                                    ├─ TokenManager (free sessions)        │
│                                    ├─ RunManager (agent runs)             │
│                                    └─ createHandler() from src/handler.ts │
└────────────────────────────────────────────────────────────────────────────┘
```

The single code path means the local CLI server and the hosted endpoint behave
identically (session admission, 503 waiting-room, model lock, streaming, the
CLI-gate system-marker injection).

## Public surface

- **Domain:** `https://open.freebuff.app`
- **Base URL:** `https://open.freebuff.app/v1`

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/` | Landing page: sign in, API key dashboard, model playground |
| GET | `/healthz` | Public liveness status |
| GET | `/v1/models` | Free models currently served |
| POST | `/v1/chat/completions` | Chat — JSON or SSE stream |
| POST | `/v1/images/generations` | Image generation (Pollinations, anonymous, base64) |
| POST | `/api/auth/start` | Start a device-code login (web) |
| GET | `/api/auth/status` | Poll the login until the user signs in |
| POST | `/api/auth/register` | Validate the account token, mint an `sk-fb-…` key |
| POST | `/api/auth/revoke` | Revoke an API key (sign out) |
| POST | `/api/gate/verify` | Check a site access token (unlocks the console when the gate is on) |

Authentication for the API surface is `Authorization: Bearer <key>` or
`x-api-key: <key>`.

## Deployment environment

| Var | Required | Default | Meaning |
| --- | -------- | ------- | ------- |
| `AUTH_TOKENS` | no | saved login credentials (standalone only) | Shared Freebuff auth token(s), comma-separated. Optional when users sign in through the hosted web console; needed to provide a shared token pool. |
| `PROXY_SECRET` | no | auto | Stable secret that encrypts web-login API keys (`sk-fb-…`). Set a fixed value so keys survive redeploys. |
| `API_KEYS` | no | empty (fail closed) | Explicit high-entropy keys clients must present. Without it hosted `/v1` rejects unauthenticated requests (web-login `sk-fb-…` keys still work), preventing a published default credential. |
| `SITE_ACCESS_TOKEN` | no | — | Gate token(s) for the web console, comma-separated. When set, visitors must present one (typed into the lock screen or via `?token=…`) to unlock the site. |
| `UPSTREAM_BASE_URL` | no | `https://www.codebuff.com` | Freebuff backend base URL. |
| `REQUEST_TIMEOUT` | no | `15m` | Upstream request timeout. |
| `ROTATION_INTERVAL` | no | `6h` | Agent-run rotation interval. |
| `MAX_BODY_SIZE` | no | `16MB` | Max chat request body. |
| `MAX_CONCURRENT_REQUESTS` | no | `32` | Max concurrent chat requests. |
| `PUBLIC_UPSTREAM_ENABLED` | no | `true` | Try fixed public providers first; set `false` to disable all public routes. |
| `PUBLIC_UPSTREAM_PROVIDERS` | no | `opencode,pollinations,felo` | Fixed provider ids to enable; arbitrary ids are ignored. |
| `PUBLIC_UPSTREAM_BASE_URL` | no | `https://opencode.ai/zen/v1` | OpenCode-only HTTPS override; Pollinations/Felo endpoints remain fixed. |
| `PUBLIC_UPSTREAM_MODELS` | no | aggregated allowlist | Chat model allowlist — canonical `provider/model` ids (OpenCode entries may keep their historical bare ids for backward compatibility). |
| `PUBLIC_UPSTREAM_IMAGE_MODELS` | no | `pollinations/flux,pollinations/turbo,pollinations/zimage` | Image model allowlist for `POST /v1/images/generations`. |
| `PUBLIC_UPSTREAM_TIMEOUT` | no | `20s` | Initial response timeout before another public route or authenticated fallback. |

These are the same variables documented in
[07 – Configuration & Usage](07-configuration-and-usage.md); the hosted app
reads them from the deployment environment. The fixed public provider set (OpenCode Zen, keyless Pollinations — chat and image generation — and Felo's
reverse-engineered web protocol) is enabled by default for its explicit
allowlist. Every model id is provider-namespaced (`freebuff/<model>`, `opencode/<model>`,
`pollinations/<model>`, `felo/<model>`); unprefixed ids are neither listed nor
routable. Set
`PUBLIC_UPSTREAM_ENABLED=false` when prompts/code must stay on the
authenticated Freebuff path. Public providers never receive downstream
credentials, but they do receive the request body for routed models. Felo has
no official API and may change without notice.

## Web login (per-user API keys)

Besides the shared `AUTH_TOKENS` pool, visitors can sign in on the site
itself — the flow mirrors `freebuff2api login`:

1. The page requests a one-time device-code link (`POST /api/auth/start`),
   opens it in a new tab and polls `GET /api/auth/status` until the user
   signs in on freebuff.com.
2. The server polls the upstream and keeps the resulting account token in a
   short-lived, HttpOnly-cookie-bound login transaction. The browser never
   receives the raw token. Registration validates it with `GET /api/v1/me`,
   then mints an API key of the form `sk-fb-…` encrypted with AES-256-GCM.
3. The proxy resolves any `sk-fb-…` key back to the account token per
   request, so OpenAI-compatible clients only ever need the API key; each
   key's sessions/quota belong to its own freebuff.com account.
4. **Sign out** on the site revokes the key in the current server process and
   clears the browser copy; the next login mints a fresh key. Because hosted
   instances may be ephemeral or horizontally scaled, revocation is not a
   durable cross-instance session store. Use a stable `PROXY_SECRET` and a
   real shared state store if durable revocation is a requirement.

Login transactions (`/api/auth/start` → `/api/auth/status` | `/register`) are
likewise kept in per-process memory. In multi-instance deployments the
browser's login calls must land on the same instance (sticky sessions), or the
flow fails with an unknown-transaction error.

So `AUTH_TOKENS` is **optional** in hosted mode: it only feeds the shared
pool used by the default `API_KEYS`. The key-encryption secret is derived
from `PROXY_SECRET` (recommended — set a fixed value so web-login keys
survive redeploys), else from a hash of `AUTH_TOKENS`, else a secret
persisted to a local file (`.data/proxy-secret`, so keys survive process
restarts even without env vars), else a per-process random (keys then reset
on restart).

## Site access gate (optional)

By default anyone can open the console. To restrict who may use the site,
set `SITE_ACCESS_TOKEN` in the deployment environment (comma-separated list
allowed). The page then shows a lock screen:

- Visitors type the token into the lock screen, or open the site directly
  with the token in the URL: `https://open.freebuff.app/?token=…`
- `POST /api/gate/verify` validates the token (constant-time SHA-256
  comparison) and returns `{ok: true}` or `401`.
- Once accepted, the browser keeps the token in `localStorage` and
  re-verifies it on every visit — refreshing the page does not re-prompt.
- An invalid `?token=…` is stripped from the URL and the lock screen is shown
  with an error.

> The gate is the console's **front door only**. The `/v1` API surface is
> always protected by `API_KEYS` regardless of the gate. Without
> `SITE_ACCESS_TOKEN` the console behaves exactly as before (open).

> ⚠️ **`AUTH_TOKENS` vs `API_KEYS`** — these are different credentials.
> `AUTH_TOKENS` is your **freebuff.com account token** (the token your
> freebuff.com account uses; get it with `freebuff2api login`, or from your
> browser session on freebuff.com). `API_KEYS` is the key **your clients**
> send as `Authorization: Bearer`; hosted deployments must provision it
> explicitly with a high-entropy value. Leaving it unset makes hosted `/v1`
> requests fail closed. Setting `AUTH_TOKENS` to the proxy API key makes the
> upstream API answer `401 Invalid API key` on `/v1/chat/completions` — the
> proxy stays healthy but cannot admit a session with that token.

## Deploying

1. Push the repo (Freebuff hosting builds from the connected repository).
2. Open the **Deployments** panel and run the first **Deploy** — hosting
   detects the Next.js app, runs `next build`, and serves it on the project
   domain. (Redeploys after the first one can be triggered with
   `freebuff-deploy start`.)
3. (Optional) Set `AUTH_TOKENS` in the deploy environment (Deployments →
   env) to feed the shared token pool. Without it the site still works:
   visitors sign in on the page and get their own `sk-fb-…` keys. Set
   `PROXY_SECRET` to a fixed value so web-login keys survive redeploys.
4. Verify:

```bash
# health (public)
curl https://open.freebuff.app/healthz

# models (authenticated)
curl https://open.freebuff.app/v1/models \
  -H "Authorization: Bearer <your-explicit-api-key>"

# chat (streaming)
curl https://open.freebuff.app/v1/chat/completions \
  -H "Authorization: Bearer <your-explicit-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"freebuff/deepseek/deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

## Behavior notes

- **Health probes:** `/healthz` remains public and liveness-only; it does not
  expose account ids, token fragments, queue state, or model registry details.
  In hosted mode, web-login operation can work without `AUTH_TOKENS`; the
  default public provider can also serve its allowlisted models without it. A
  shared token pool or Freebuff-only model still needs `AUTH_TOKENS` (or saved
  CLI credentials). If the runtime
  cannot build a usable handler, `/healthz` answers `200 {ok:false,
  configured:false}` and other proxy endpoints return a clear 503.
- **CORS:** open on `/v1/*` (preflight answered with `204`), so browser-based
  OpenAI clients can call the endpoint directly.
- **Streaming:** SSE responses pass through; the chat route allows long-lived
  streams (max duration 300 s).
- **Account limits are unchanged:** one free session (≈1 hour) per account,
  locked to a single model at a time. A request for a different model while
  the session is pinned returns `409 model_locked` naming the locked model
  (the proxy never masks it as a 503).
- **State:** the session pool / run manager / model registry live in the
  server process; a cold start (redeploy) re-acquires everything lazily. API-key
  revocation is also process-local; durable cross-instance revocation requires a
  shared state store.
- **Scaling:** a single account = a single concurrent session, so the hosted
  endpoint serves one model at a time. Multiple `AUTH_TOKENS` in the deploy
  env let the proxy round-robin across several accounts.

## Local development of the hosted app

```bash
bun run dev:web    # next dev — same /v1 surface + landing console
bun run build:web  # next build — the artifact hosting builds
```

**Preview command (Freebuff Cloud agent):** set the dev/preview command to

```bash
bun run dev -- -H 0.0.0.0
```

This runs the Next.js dev server bound to all interfaces so the cloud preview
can reach it. Freebuff-injected `PORT` overrides the port automatically (do
not pass `-p`, and do not use bare `-` arguments — `next dev` would treat
them as a project directory and fail).

The CLI server is unchanged: `bun run dev:cli` (or `bun run start`). The package's `dev` alias is also the Next.js app; use `dev:cli` for the standalone proxy.
