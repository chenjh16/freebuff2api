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
│  POST /v1/chat/completions   →  ┘  ├─ loadConfig()                        │
│                                    ├─ ModelRegistry (free agents)         │
│                                    ├─ TokenManager (free sessions)        │
│                                    ├─ RunManager (agent runs)             │
│                                    └─ createHandler() from src/handler.ts │
└────────────────────────────────────────────────────────────────────────────┘
```

The single code path means the local CLI server and the hosted endpoint behave
identically (session admission, 503 waiting-room, model lock, streaming, the
CLI-gate system-marker injection).

## Public surface

- **Domain:** `https://freebuff2api.freebuff.app`
- **Base URL:** `https://freebuff2api.freebuff.app/v1`

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/` | Landing page / live console (status, models, try-a-chat) |
| GET | `/healthz` | Liveness + model registry + token/session state |
| GET | `/v1/models` | Free models currently served |
| POST | `/v1/chat/completions` | Chat — JSON or SSE stream |

Authentication for the API surface is `Authorization: Bearer <key>` or
`x-api-key: <key>`.

## Deployment environment

| Var | Required | Default | Meaning |
| --- | -------- | ------- | ------- |
| `AUTH_TOKENS` | ✅ | — | Freebuff auth token(s), comma-separated. Until set, the proxy answers `503` with a clear message. |
| `API_KEYS` | no | `sk-freebuff2api-2026` | Keys clients must present. The hosted app falls back to this default so the public endpoint is never left open; set the env var to override. |
| `UPSTREAM_BASE_URL` | no | `https://www.codebuff.com` | Freebuff backend base URL. |
| `REQUEST_TIMEOUT` | no | `15m` | Upstream request timeout. |
| `ROTATION_INTERVAL` | no | `6h` | Agent-run rotation interval. |
| `MAX_BODY_SIZE` | no | `16MB` | Max chat request body. |
| `MAX_CONCURRENT_REQUESTS` | no | `32` | Max concurrent chat requests. |

These are the same variables documented in
[07 – Configuration & Usage](07-configuration-and-usage.md); the hosted app
reads them from the deployment environment.

## Deploying

1. Push the repo (Freebuff hosting builds from the connected repository).
2. Open the **Deployments** panel and run the first **Deploy** — hosting
   detects the Next.js app, runs `next build`, and serves it on the project
   domain. (Redeploys after the first one can be triggered with
   `freebuff-deploy start`.)
3. Set `AUTH_TOKENS` in the deploy environment (Deployments → env). Without
   it the site and `/healthz` stay up, but `/v1/*` returns a `503`
   "proxy is not configured" error.
4. Verify:

```bash
# health (public)
curl https://freebuff2api.freebuff.app/healthz

# models (authenticated)
curl https://freebuff2api.freebuff.app/v1/models \
  -H "Authorization: Bearer sk-freebuff2api-2026"

# chat (streaming)
curl https://freebuff2api.freebuff.app/v1/chat/completions \
  -H "Authorization: Bearer sk-freebuff2api-2026" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

## Behavior notes

- **Health probes:** `/healthz` answers `200 {ok:false, configured:false}`
  until `AUTH_TOKENS` is set, so hosting health checks stay green while the
  proxy waits for configuration. All other endpoints return a 503 with the
  exact reason.
- **CORS:** open on `/v1/*` (preflight answered with `204`), so browser-based
  OpenAI clients can call the endpoint directly.
- **Streaming:** SSE responses pass through; the chat route allows long-lived
  streams (max duration 300 s).
- **Account limits are unchanged:** one free session (≈1 hour) per account,
  locked to a single model at a time. A request for a different model while
  the session is pinned returns `409 model_locked` naming the locked model
  (the proxy never masks it as a 503).
- **State:** the session pool / run manager / model registry live in the
  server process; a cold start (redeploy) re-acquires everything lazily.
- **Scaling:** a single account = a single concurrent session, so the hosted
  endpoint serves one model at a time. Multiple `AUTH_TOKENS` in the deploy
  env let the proxy round-robin across several accounts.

## Local development of the hosted app

```bash
bun run dev        # next dev — same /v1 surface + landing console
bun run build:web  # next build — the artifact hosting builds
```

The CLI server is unchanged: `bun run dev:cli` (or `bun run start`).
