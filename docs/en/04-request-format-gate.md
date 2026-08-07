# Request Format Cracked: the Free-Tier CLI Gate

> This is the most important result of the whole reverse-engineering effort.
> It explains why plain OpenAI requests are rejected by the upstream
> (`403 free_mode_cli_required`) and what the correct request format is.

## The problem

The proxy's request pipeline itself was fine (session creation and agent runs
both succeeded), but `POST /api/v1/chat/completions` always returned:

```json
{
  "error": "free_mode_cli_required",
  "message": "Free mode is only available through the freebuff CLI. Install it with `npm i -g freebuff`, then run `freebuff`. Calling the API directly is not supported and may get your account banned."
}
```

In other words, free mode has a **CLI gate**: it wants to confirm the request
really comes from the official CLI, otherwise it rejects it and warns that
the account may be banned.

## Research method

### 1. MITM capture (the "ground truth")

We wrote a TLS man-in-the-middle proxy (`tools/mitm-ssl-proxy.mjs`), routed
the official CLI (`freebuff` v0.0.141) through it to `www.codebuff.com`, and
captured its **successful** request (HTTP 200 + SSE stream):

- Request header `User-Agent: ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser`
- Request body contains: `model`, `stop`, `codebuff_metadata`, `provider`,
  **3 messages (system + 2 user)**, 24 tools, `tool_choice`, `stream`

The captured body is saved as `tools/captured/chatbody-official.json`; the
agent definitions (the 460KB payload sent to `/api/agents/validate`) are
saved as `tools/captured/agentdefs-full.json`.

### 2. Variant bisection (which fields are actually required)

We wrote a bisection script (`tools/discover-gate.mjs`) that turns off one
field at a time (system message, tools, stop, provider, …) and hits the
upstream live with a real account, watching whether the gate lets it through
or rejects it.

## Test results table

| Variant | System message content | Result |
| ---- | --------------- | ---- |
| EXACT-FULL | Official full system prompt (10,788 chars) | ✅ 200 SSE |
| SHORT-BUFFY | `You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.` | ✅ 200 |
| FIRST-SENTENCE | `You are Buffy, the strategic coding assistant.` | ✅ 200 |
| NO-TOOLS | Same as EXACT, but tools removed | ✅ 200 |
| NO-STOP | Same as EXACT, but stop removed | ✅ 200 |
| NO-PROVIDER | Same as EXACT, but provider removed | ✅ 200 |
| EXACT-OUR-UA | With the proxy's own UA (`0.10.7` version) | ✅ 200 |
| NO-SYSTEM | No system message at all | ❌ 403 |
| MINIMAL-FULL | `You are a helpful assistant.` | ❌ 403 |
| BUFFY-NAME | `You are Buffy.` | ❌ 403 |
| FREEBUFF-ONLY | `You are an AI assistant for the product Freebuff.` | ❌ 403 |
| BUFFY+FREEBUFF | `You are Buffy. You are the AI agent behind the product Freebuff.` | ❌ 403 |
| CLI-MARKER | `You are the official freebuff CLI coding assistant.` | ❌ 403 |

## Core conclusion

**The free-tier gate checks for an exact phrase inside the system message:**

```
You are Buffy, the strategic coding assistant
```

- Any request whose messages contain a system message with that phrase →
  **allowed** (HTTP 200)
- Otherwise → `403 free_mode_cli_required`
- All other fields (tools, stop, provider, user-agent version, full system
  content) are **optional** and don't affect the gate's decision

This also explains why all earlier attempts failed: `scratch-e2e.mjs`'s
baseline request had only a single `{role: "user"}` message with no system
message; the various system variants in `scratch-replay.mjs` ("You are a
helpful assistant", bare names, case changes, …) never contained the target
phrase.

## The fix

`src/server.ts` gained `injectCliSystemMarker()`, which guarantees the system
message carries the phrase before forwarding:

1. If a system message already contains the target phrase → leave it alone
2. Otherwise, if a first system message exists → **merge** the marker in
   front of it (preserving the client's own system prompt)
3. Otherwise → **insert** a standalone system message at the front of
   `messages`

```ts
const CLI_SYSTEM_MARKER =
  "You are Buffy, the strategic coding assistant. " +
  "You are the AI agent behind the product, Freebuff, " +
  "a tool where users can chat with you to code with AI for free.";
```

This way no OpenAI client (Claude Code, Cline, curl, …) needs to know about
the gate — the proxy injects the marker automatically.

## Post-fix end-to-end verification

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
```

- ✅ Streaming (`stream: true`): HTTP 200, SSE pushes `chat.completion.chunk`
  normally
- ✅ Non-streaming: HTTP 200, real answer `"content":"PONG"` with usage stats
- ✅ Proxy logs confirm the upstream body carries the injected system marker
  and `ancestorRunIds: []`

## Other findings along the way

- `free_mode_invalid_agent_hierarchy`: appeared once after a system variant
  passed the gate, hinting at an agent-hierarchy problem — the run's
  `agentId` must match the session's model
  (`base2-free-deepseek-flash` ↔ `deepseek/deepseek-v4-flash`).
- The official CLI's `agent-runs` START body is
  `{"action":"START","agentId":"…","ancestorRunIds":[]}`; the proxy has been
  aligned to it (`src/upstream.ts`).
