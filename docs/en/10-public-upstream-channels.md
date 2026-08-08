# 10 — Public Upstream Channels

> The default-enabled aggregate of fixed, no-auth upstream providers behind the
> proxy: OpenCode Zen, keyless Pollinations (chat **and** image generation),
> and Felo's reverse-engineered web protocol. This document covers each
> channel's protocol, its verified quirks, the streaming normalization layer,
> and client compatibility (e.g. Cherry Studio's `AI_FinishReasonError`).
> Implementation: `src/public-upstream.ts`.

## Why public channels

The proxy has an authenticated Freebuff path and a default-enabled set of fixed
public capabilities. For an allowlisted public model the proxy sends the
translated body to the matching fixed HTTPS provider **without forwarding any
downstream credential** (no `Authorization`, `x-api-key`, cookies, or Freebuff
token). Public routes are tried first; on transient failure the request falls
through to the next matching public provider and finally to authenticated
Freebuff. This means an instance can serve useful models with **zero
configuration** and no Freebuff token at all.

Disable everything with `PUBLIC_UPSTREAM_ENABLED=false`; narrow it with
`PUBLIC_UPSTREAM_PROVIDERS`, `PUBLIC_UPSTREAM_MODELS` and
`PUBLIC_UPSTREAM_IMAGE_MODELS`.

## Channel inventory

| Channel | Base URL (fixed) | Auth | Protocol | Verified models |
| ---- | ---- | ---- | ---- | ---- |
| OpenCode Zen | `https://opencode.ai/zen/v1` (override: `PUBLIC_UPSTREAM_BASE_URL`, HTTPS `opencode.ai` host only) | None | OpenAI chat, SSE streaming | 4 chat |
| Pollinations chat | `https://gen.pollinations.ai/v1` | None | OpenAI chat, SSE streaming | 8 chat |
| Pollinations image | `https://image.pollinations.ai` | None (watermark removal `nologo` requires a token and is never sent) | `GET /prompt/<prompt>?…` → OpenAI images response | 3 image |
| Felo | `https://felo.ai` | None | Reverse-engineered web protocol (chat-like categories), SSE relayed as OpenAI stream | 5 chat |

Model ids: every model has a single provider-prefixed `provider/model` id
(`opencode/big-pickle`, `pollinations/openai`, `felo/felo-chat`). Unprefixed
ids are neither listed by `GET /v1/models` nor routable. On transient failure a
request falls through the remaining matching providers in
`PUBLIC_UPSTREAM_PROVIDERS` priority (`opencode` → `pollinations` → `felo`,
Freebuff last). Full catalog: [09 - Model Catalog & Routing](09-model-catalog.md).

## Channel-by-channel behavior

### OpenCode Zen (no auth) — 4 models

`opencode/big-pickle`, `opencode/deepseek-v4-flash-free`,
`opencode/mimo-v2.5-free`, `opencode/nemotron-3-ultra-free`

- Native OpenAI-compatible `/v1/chat/completions`; ids are namespaced as
  `opencode/<model>`.
- `hy3-free` and `north-mini-code-free` were **removed** from the whitelist:
  live checks return 401 without an account token.
- **Free tier is stochastic** (verified live 2026-08-08): a request may stream
  the full `reasoning_content` and then end with an **empty** final answer
  (`{"delta":{"content":""},"finish_reason":"stop"}`) — the model thought but
  did not answer. Repeating the identical prompt can return a real answer, so
  this is a provider-side lottery, not a proxy bug.
- Occasionally the stream ends **without any finish chunk**, or appends a junk
  trailer chunk like `{"choices":[],"cost":"0"}` (no `choices`/`usage`).

### Pollinations chat (no auth) — 8 models

`pollinations/openai`, `pollinations/openai-fast`, `pollinations/openai-large`,
`pollinations/qwen-coder`, `pollinations/mistral`, `pollinations/deepseek`,
`pollinations/grok`, `pollinations/perplexity-fast`

- Anonymous calls work for these models; `gemini-flash-lite-3.1` and
  `perplexity-reasoning` were **removed** (401 even with the simplest prompt).
- **Prompt-dependent 401 lottery** (verified live): the anonymous gateway
  sometimes routes certain prompt shapes to an authenticated backend and
  answers `401 "Authentication required"` — e.g. `"hi"` reliably 200, while
  `"Reply with exactly: PUBLIC_MODEL_OK"` was 10/10 401 in one session. The
  refusal is per (model, prompt) and intermittent; the proxy classifies 401 as
  transient, so clients should retry (or rely on Freebuff fallback).
- **No anonymous tool calling** (verified live 2026-08-08): a request body
  containing a `tools` field is **deterministically** rejected with 401 for
  every model (`pollinations/qwen-coder`, `pollinations/openai`,
  `pollinations/perplexity-fast`, `pollinations/deepseek` all 3/3
  401; the same models without `tools` are 3/3 200). Tool calling requires an
  account, so tool-driven agents (opencode, Claude Code, Cline, …) cannot use
  Pollinations chat anonymously — only plain (tool-less) chat works.
- Throttling appears under bursts; sequential probes with spacing stay healthy.

### Pollinations image (no auth) — 3 models

`pollinations/flux`, `pollinations/turbo`, `pollinations/zimage`

- `GET https://image.pollinations.ai/prompt/<prompt>?width=…&height=…&seed=…&model=…&format=jpeg`,
  translated to an OpenAI images response (`url` data-URI + `b64_json`).
- `nologo` (watermark removal) requires an account token and is intentionally
  **never** sent — anonymous results carry the Pollinations logo.
- Images are fetched synchronously and base64-encoded before responding, so
  latency scales with generation time. No authenticated fallback exists: a
  transient provider failure is surfaced directly (the client retries).

### Felo (no auth, reverse-engineered) — 5 models

`felo/felo-chat`, `felo/felo-search`, `felo/felo-scholar`, `felo/felo-social`,
`felo/felo-document`

- No official API; the adapter speaks the browser-facing protocol
  (`/api/message/v1/stream/<key>` etc.) and relays it as an OpenAI SSE stream.
- The protocol **may change without notice**, breaking this channel until the
  adapter is updated.
- Chat/search-oriented category models: they answer questions well (verified
  via opencode: a single-turn reply works), but have **no tool-calling
  capability**, so they cannot drive coding agents that need to write files or
  run commands.

## Streaming normalization (`sanitizeOpenAIStream`)

All public chat streams (OpenCode + Pollinations; Felo's adapter output too)
are normalized before relay so that **strict parsers always receive a
well-formed stream**:

- A terminal chunk with `finish_reason: "stop"` is **guaranteed**:
  - non-standard reasons (`"other"` etc.) are rewritten to `"stop"`;
  - if the upstream ends without a finish chunk (OpenCode's free tier
    truncating after `reasoning_content`), a terminal chunk is synthesized;
  - Felo's protocol never carries an OpenAI finish chunk, so the adapter
    always appends one.
- `content` / `reasoning_content` deltas and usage chunks pass through
  untouched.
- Malformed lines and junk trailers (e.g. `{"choices":[],"cost":"0"}`) are
  dropped.
- The stream always ends with exactly one `data: [DONE]`.

## Client compatibility & troubleshooting

**Symptom (Cherry Studio):** after the model finishes outputting its
reasoning/thinking block, no final reply appears and the app reports:

```
AI_FinishReasonError: Response ended with finish reason "other"
```

**Root cause:** Cherry Studio's provider layer is built on the Vercel AI SDK,
which aborts when the OpenAI-compatible SSE stream ends with an unknown or
missing finish reason — it maps unknown values to `"other"` and throws. The
proxy used to relay public upstream streams verbatim, so anything the
provider sent (missing finish chunk, `"other"`, or truncation right after
`reasoning_content`) surfaced as that error. It is a **format** problem, not a
content problem.

**Fix:** the streaming normalization above runs on every public chat stream,
so the client always sees a clean `finish_reason: "stop"` + `[DONE]` — no more
`AI_FinishReasonError` regardless of what the upstream sends.

**Residual behavior you may still see:** for `opencode/deepseek-v4-flash-free`
(free
tier) the upstream occasionally ends with an **empty** final answer after the
reasoning block. The proxy cannot invent content; with the fix the request
terminates cleanly instead of erroring. When the reply is empty, retry the
request or switch to another model (`opencode/big-pickle`,
`opencode/mimo-v2.5-free`, a `pollinations/*` model, or a `felo/*` model). Pollinations 401s during bursts are
transient — retrying usually succeeds.

**Other OpenAI clients** (curl, Claude Code, LobeChat, …) are unaffected: they
already tolerate loose streams; the normalization is harmless to them.

### Which channels work with tool-driven agents (opencode etc.)

| Channel | Plain chat | Agent tasks (tool calling) | Reason |
| ---- | ---- | ---- | ---- |
| OpenCode Zen | ✅ | ✅ (verified end-to-end via opencode, 2026-08-08) | Native OpenAI-compatible, supports tools |
| Pollinations chat | ✅ (tool-less requests) | ❌ deterministic 401 | Anonymous tier rejects `tools` bodies |
| Felo | ✅ (single-turn verified) | ❌ | Chat/search models, no tool calling |

## Configuration knobs

| Env var | Default | Effect |
| ---- | ---- | ---- |
| `PUBLIC_UPSTREAM_ENABLED` | `true` | Disable all public channels |
| `PUBLIC_UPSTREAM_PROVIDERS` | `opencode,pollinations,felo` | Enabled channels and alias priority order |
| `PUBLIC_UPSTREAM_MODELS` | Aggregate allowlist | Public chat model whitelist (`provider/model` ids) |
| `PUBLIC_UPSTREAM_IMAGE_MODELS` | `pollinations/flux,pollinations/turbo,pollinations/zimage` | Image model whitelist |
| `PUBLIC_UPSTREAM_BASE_URL` | `https://opencode.ai/zen/v1` | Override only for OpenCode (HTTPS `opencode.ai` host) |
| `PUBLIC_UPSTREAM_TIMEOUT` | `20s` | First-response timeout before fallback |

With public channels enabled, a standalone CLI needs **no `AUTH_TOKENS` at
all** to serve the whitelisted public models.

## Privacy & terms

Every request routed to a public channel sends your prompt and any code in the
conversation to that provider's servers (OpenCode / Pollinations / Felo), and
leaves this service. Review each provider's terms of service and privacy
policy before deployment; disable individual channels via
`PUBLIC_UPSTREAM_PROVIDERS` or everything via `PUBLIC_UPSTREAM_ENABLED=false`
if that is a concern. Felo is an unofficial, reverse-engineered integration
and may stop working at any time.

## Verification

- Live E2E (`LIVE_PUBLIC_UPSTREAM_TEST=1`, opt-in) verified every default
  public model through the proxy: OpenCode chat (4), Pollinations chat (8),
  Felo (5) via `/v1/chat/completions`, Pollinations images (3) via
  `/v1/images/generations`; `/v1/models` and prefixed-only routing also
  covered.
- Live streaming check: `/v1/chat/completions` with `opencode/deepseek-v4-flash-free`
  terminates with `finish_reason: ["stop"]` and a final `[DONE]`.
- Agent E2E through opencode (2026-08-08, fresh-write mode): OpenCode Zen
  `opencode/deepseek-v4-flash-free` and `opencode/big-pickle` completed real
  coding tasks
  (fib demo + md2html converter) through the proxy; Pollinations `tools`
  requests 401 (no anonymous tool calling); Felo answered single-turn chat.
- Unit tests cover truncation, non-standard finish reasons, junk trailers,
  usage preservation, malformed lines, JSON passthrough, client aborts, and
  the Felo terminal chunk.
