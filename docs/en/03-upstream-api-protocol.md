# 03 Upstream API Protocol

> This document records the complete protocol of the Freebuff upstream backend
> (`https://www.codebuff.com`), verified via official CLI packet captures and
> live requests. Implementation lives in `src/upstream.ts`.

## General conventions

- Base URL: `https://www.codebuff.com` (override with `UPSTREAM_BASE_URL`)
- Auth: `Authorization: Bearer <token>` (the `authToken` from login)
- User identity: non-SDK requests carry `x-freebuff-acting-user-id: <user id>`
- **User-Agent routing** (the free-tier gate uses this to tell apart
  "CLI-created" sessions from direct calls):
  - Session / agent run / other non-SDK requests: `Bun/1.3.14`
    (the official CLI runs on the Bun runtime)
  - Chat requests: `ai-sdk/openai-compatible/<ver>/codebuff ai-sdk/provider-utils/<ver> runtime/browser`
- Debugging: with `DEBUG_UPSTREAM=1`, every upstream request's headers and
  body are printed (token redacted)

## Fixed public/no-auth upstreams

The proxy has an authenticated Freebuff path and a default-enabled aggregate
of fixed public capabilities: OpenCode Zen, keyless Pollinations (chat **and**
image generation), and Felo's reverse-engineered web protocol.

### Model id scheme

Every model id is provider-namespaced (`freebuff/…`, `opencode/…`,
`pollinations/…`, `felo/…`); unprefixed ids are neither listed by
`GET /v1/models` nor routable, so a model id always names its provider.

| Provider | Model id form | Example |
| ---- | ---- | ---- |
| Freebuff | `freebuff/<model>` | `freebuff/deepseek/deepseek-v4-flash` |
| OpenCode | `opencode/<model>` | `opencode/big-pickle` |
| Pollinations chat | `pollinations/<model>` | `pollinations/openai` |
| Pollinations image | `pollinations/<model>` | `pollinations/flux` |
| Felo | `felo/<model>` | `felo/felo-chat` |

Public routes are matched by these prefixed ids; on transient failure the
request falls through the remaining matching public providers in
`PUBLIC_UPSTREAM_PROVIDERS` order (`opencode` → `pollinations` → `felo`) before
the authenticated Freebuff path.

`PUBLIC_UPSTREAM_BASE_URL` may override only an HTTPS `opencode.ai` URL;
Pollinations (`https://gen.pollinations.ai/v1`, chat; `https://image.pollinations.ai`,
images) and Felo (`https://felo.ai`) remain fixed. `PUBLIC_UPSTREAM_PROVIDERS`,
`PUBLIC_UPSTREAM_MODELS` and `PUBLIC_UPSTREAM_IMAGE_MODELS` narrow the allowlist,
while `PUBLIC_UPSTREAM_ENABLED=false` disables every public route.

Each adapter constructs its own outbound headers and sends only the translated
request body—never downstream `Authorization`, `x-api-key`, cookies, or a
Freebuff account token. Timeouts and transient `401/408/425/429/5xx` responses
try another matching public route and then fall back to authenticated Freebuff;
a normal `4xx` is returned directly (image generation has no authenticated
fallback and surfaces the provider failure). Pollinations' anonymous catalog
excludes premium/optional-key models (verified live 2026-08-08); its anonymous
chat tier additionally returns 401 for some prompt shapes — the proxy treats
that as transient, so clients should retry or rely on Freebuff fallback. Felo
has no official API and its browser-facing protocol may change without notice.
Because routed prompts and code leave this service, review all selected
providers' terms and privacy requirements.

## Endpoints at a glance

| Method | Path | Description |
| ---- | ---- | ---- |
| GET | `/api/healthz` | Liveness check |
| GET | `/api/v1/me?fields=id,email` | Current user info |
| POST | `/api/v1/ads` | Ad slots (called by the official CLI; not required) |
| POST | `/api/agents/validate` | Reports the full agent definitions (official CLI sends a 460KB payload) |
| POST | `/api/v1/freebuff/session` | Create/refresh a free session |
| GET | `/api/v1/freebuff/session` | Poll (waiting room) or compact session |
| DELETE | `/api/v1/freebuff/session` | End a session |
| POST | `/api/v1/agent-runs` | Start / finish an agent run |
| POST | `/api/v1/chat/completions` | OpenAI-compatible chat (streaming / non-streaming) |
| POST | `/api/logs` | Client log reporting (called by the official CLI; not required) |

## 1. Free session

### Create / refresh

```
POST /api/v1/freebuff/session
Authorization: Bearer <token>
User-Agent: Bun/1.3.14
x-freebuff-model: deepseek/deepseek-v4-flash   # optional, pins the model

# The official CLI sends no request body and does not require an explicit Accept header.
body: <empty>
```

Success (`status: active`):

```json
{
  "status": "active",
  "accessTier": "full",
  "instanceId": "57e9bd9e-…",
  "model": "deepseek/deepseek-v4-flash",
  "admittedAt": "2026-08-06T17:35:38.571Z",
  "expiresAt": "2026-08-06T18:35:38.571Z",
  "remainingMs": 3011763,
  "rateLimit": { "model": "…", "limit": 6, "period": "pacific_day", … }
}
```

Waiting room (`status: queued`, with `instanceId`, `position`,
`queueDepth`, `estimatedWaitMs`): the proxy returns `503 + Retry-After` and
polls in the background.

Other statuses: `disabled` (free tier unavailable, 404),
`none`/`ended`/`superseded` (need to re-create), `country_blocked`/`banned`
(403), `model_locked`/`model_unavailable` (409), 429 (rate limited).

> 404 mapping: the official CLI maps 404 → `{status: "none"}` (free tier not
> available); freebuff2api maps it to `{status: "disabled"}` — both stop
> polling.

Model locked (`409`, verified live — one account holds a single
model-locked 1-hour session):

```json
{
  "status": "model_locked",
  "currentModel": "openai/gpt-5.6-luna",      // what the active session is pinned to
  "requestedModel": "deepseek/deepseek-v4-flash", // what was asked for
  "accessTier": "full"
}
```

> The official CLI's response to `model_locked` (from its bundled source): if
> the user picked a different model it first `DELETE`s the session and then
> re-POSTs (auto-switch); if the DELETE fails it tells the user to run
> `/end-session`. It also applies exponential backoff (base 20s, cap 300s)
> and treats `408/429/503` on session POST as retryable while all other 4xx
> stop. freebuff2api surfaces `409 model_locked` (with the locking model) and
> passes through other admission failures (`429`/`500`/`503`/`401`) with their
> real status, `Retry-After` and message instead of masking them as a generic
> 503.

### Poll the waiting room

```
GET /api/v1/freebuff/session
x-freebuff-instance-id: <instanceId>
x-freebuff-compact-session: 1
User-Agent: Bun/1.3.14
```

### End

```
DELETE /api/v1/freebuff/session
User-Agent: Bun/1.3.14
```

## 2. Agent runs (agent-runs)

### Start (START)

```
POST /api/v1/agent-runs
Authorization: Bearer <token>
x-freebuff-acting-user-id: <user id>
User-Agent: Bun/1.3.14

{ "action": "START", "agentId": "base2-free-deepseek-flash", "ancestorRunIds": [] }
```

> `ancestorRunIds: []` matches the official CLI exactly (verified as the
> required format). `agentId` must match the session's model, otherwise you
> may get `free_mode_invalid_agent_hierarchy`.

Response: `{ "runId": "26a22543-…" }`

### Finish (FINISH)

```
POST /api/v1/agent-runs
{ "action": "FINISH", "runId": "…", "status": "completed",
  "totalSteps": 0, "directCredits": 0, "totalCredits": 0 }
```

Response: `{ "success": true }` (best-effort; failure is not fatal)

## 3. Chat completions (core)

```
POST /api/v1/chat/completions
Authorization: Bearer <token>
x-freebuff-acting-user-id: <user id>
Content-Type: application/json
User-Agent: ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser
Accept: */*
```

Request body = the OpenAI payload + two injected blocks:

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "You are Buffy, the strategic coding assistant. …" },
    { "role": "user", "content": "Reply with exactly: PONG" }
  ],
  "codebuff_metadata": {
    "run_id": "26a22543-…",
    "client_id": "d3jy2o9a54e",
    "cost_mode": "free",
    "trace_session_id": "3d370235-…",
    "llm_step_number": "1",
    "freebuff_instance_id": "57e9bd9e-…"
  },
  "provider": { "data_collection": "deny" }
}
```

**Key point**: the system message must contain
`You are Buffy, the strategic coding assistant` (the free-tier CLI gate).
See [04 - Request Format & the CLI Gate](04-request-format-gate.md).

Supports `stream: true` (SSE, `chat.completion.chunk`) and non-streaming
(`chat.completion`, with `usage`).

Response characteristics:
- `Content-Type: text/event-stream` (streaming) or `application/json`
- `reasoning_content`: DeepSeek-family models return their reasoning process
- `provider: "DeepSeek"` etc.

Public upstream streams are normalized before relay: a terminal
`finish_reason: "stop"` chunk is guaranteed (rewritten or synthesized when the
upstream ends without one or emits a non-standard reason such as `"other"`),
junk trailing chunks are dropped, and the stream always ends with a single
`data: [DONE]` — so strict clients like Cherry Studio's AI SDK never hit
`finish reason "other"` (`AI_FinishReasonError`). See
[10 - Public Upstream Channels](10-public-upstream-channels.md) for the channel
inventory, verified provider quirks, and troubleshooting.

## 4. Misc

- `/api/agents/validate`: the official CLI POSTs all agent definitions
  (including systemPrompt, toolNames, spawnableAgents) on every startup for
  validation. freebuff2api does not need to call it to pass the gate
  (verified).
- `/api/v1/ads`: waiting-room ads, `Freebuff-CLI/<ver>` UA, not required.

## Status-code quick reference (chat endpoint)

| Status | Meaning | Proxy handling |
| ---- | ---- | -------- |
| 200 | Success (streaming / non-streaming) | Pass through |
| 400 | Bad request; includes `runId not found` etc. | Rotate run and retry once |
| 401 | Token invalid | Cooldown 30 minutes, switch token |
| 403 `free_mode_cli_required` | Missing the CLI system marker | Inject marker and retry |
| 403 `free_mode_invalid_agent_hierarchy` | Run agent doesn't match the model | Fix agentId |
| 429 | Rate limited | Return with Retry-After |
| 409 `model_unavailable` / `model_locked` | Model cannot be admitted or is locked | Preserve 409 and the error code; do not mask it as 503 |
| 503 | Waiting room / no healthy token | Return with Retry-After |

Session-admission (`POST /api/v1/freebuff/session`) failures: `409
model_unavailable`/`model_locked` are terminal for that model — preserved as
409 + `error.code` (never looped into a timeout or a generic 503); other
statuses (`429`, `401`, `500`, `503`) are passed through with `Retry-After`
and the upstream message so clients can retry like the official CLI does.
