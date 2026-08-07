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
Content-Type: application/json
body: {}                                        # official CLI sends an empty body; "{}" also works
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

### Poll the waiting room

```
GET /api/v1/freebuff/session
x-freebuff-instance-id: <instanceId>
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
| 503 | Waiting room / no healthy token | Return with Retry-After |
