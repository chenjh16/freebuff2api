# 06 End-to-End Test Records

> This document records the key tests and conclusions from the development and
> reverse-engineering process, for reproduction and debugging. Authenticated
> stages use the real account credentials at
> `~/.config/freebuff2api/credentials.json`; public-provider stages intentionally
> run without account credentials.

## Stage 1: Login flow ✅

| Test | Result |
| ---- | ---- |
| `bun run login` generates a link | ✅ prints `freebuff.com/login?auth_code=…` |
| Sign in in the browser | ✅ prints `Login successful! Return to your terminal to continue.` |
| Poll returns the user record | ✅ `name/email/authToken` all present |
| Credentials persisted | ✅ `credentials.json` (`default` key) |
| Server auto-uses credentials | ✅ `acting_user_id` in `/healthz` is the logged-in user's id |

Known pitfalls:

- One account has only **1 active session** at a time. If the official CLI is
  holding the session, you'll see
  `Another instance of freebuff has taken over this session` — log in again
  with another account.

## Stage 2: Session / run endpoints ✅

| Request | Result |
| ---- | ---- |
| `POST /api/v1/freebuff/session` (body `{}` or no body both work) | ✅ 200 `status: active` + `instanceId` |
| `GET /api/v1/freebuff/session` (with instance-id) | ✅ 200 |
| `POST /api/v1/agent-runs` START (`base2-free-deepseek-flash`) | ✅ 200 `runId` |
| `POST /api/v1/agent-runs` FINISH | ✅ 200 `{success:true}` |
| `DELETE /api/v1/freebuff/session` | ✅ 200 `{status:"ended"}` |

## Stage 3: The 403 mystery on the chat endpoint (key)

Initially every chat request returned `403 free_mode_cli_required` even
though session/run succeeded. The path to the answer:

1. MITM capture of the official CLI's successful request
   (see `tools/mitm-ssl-proxy.mjs`)
2. Variant bisection (see `tools/discover-gate.mjs`)

concluded the gate checks the **exact phrase in the system message**
`You are Buffy, the strategic coding assistant`.

See the full test table in
[04 - Request Format & the CLI Gate](04-request-format-gate.md).

## Stage 4: Full-chain verification after the fix ✅

Start the proxy and request:

```bash
DEBUG_UPSTREAM=1 LISTEN_ADDR=:18080 bun run src/index.ts
```

### Streaming chat

```bash
curl -sN http://127.0.0.1:18080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
```

Result: ✅ HTTP 200, SSE pushes:

```
: connected 2026-08-06T18:21:16.504Z
data: {"id":"93390497-…","object":"chat.completion.chunk","model":"deepseek/deepseek-v4-flash",…}
```

### Non-streaming chat

```bash
curl -s http://127.0.0.1:18080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
```

Result: ✅ HTTP 200, real answer:

```json
{ "choices": [ { "message": { "role": "assistant", "content": "PONG",
  "reasoning_content": "The user wants me to reply with exactly \"PONG\"…" } } ],
  "usage": { "prompt_tokens": 459, "completion_tokens": 19, "total_tokens": 478,
             "cost": 0, … } }
```

### Proxy logs (`DEBUG_UPSTREAM=1`) confirm the injection

```text
body: {"model":"deepseek/deepseek-v4-flash","messages":[
  {"role":"system","content":"You are Buffy, the strategic coding assistant. …"},
  {"role":"user","content":"Reply with exactly: PONG"}],
  "codebuff_metadata":{"run_id":"8c85402b-…","cost_mode":"free",…}}
-> status 200 OK
[freebuff2api] [796604…7a7b] completed (model: deepseek/deepseek-v4-flash) in 1457ms with status 200
```

## Stage 5: Engineering checks

| Check | Result |
| ---- | ---- |
| `bun run typecheck` (tsc -b --noEmit) | ✅ passes |
| Graceful shutdown (SIGTERM → FINISH run → END session) | ✅ confirmed in logs |

## Stage 6: opencode end-to-end acceptance (third-party OpenAI client) ✅

> Acceptance criteria: a real third-party OpenAI-compatible client
> (**opencode**) completes a small project through the proxy's `/v1` surface,
> proving "any OpenAI client can drive Freebuff's free models". Artifacts
> live in [`tests/agentic/cases/opencode-demo/`](../../tests/agentic/cases/opencode-demo/README.md).

| Step | Result |
| ---- | ---- |
| Install opencode v1.18.14 (official script, `~/.opencode/bin`) | ✅ `opencode --version` works |
| Configure a custom `freebuff` provider: `@ai-sdk/openai-compatible`, `baseURL` pointing at the proxy `http://127.0.0.1:18080/v1` | ✅ `opencode models freebuff` lists the model |
| Run `opencode run --model freebuff/deepseek/deepseek-v4-flash --auto` in `tests/agentic/cases/opencode-demo` to build a fibonacci mini-project | ✅ created `fib.js` + `fib.test.js` |
| opencode self-debugging: the first `node fib.test.js` failed with `require is not defined` because the parent `type: module`; it re-read `package.json`, rewrote with ESM, and re-ran | ✅ passed on re-run |
| `node fib.test.js` acceptance | ✅ `All fib tests passed` (f(0), f(1), f(10) — 3 assertions, exit 0) |
| Proxy logs | ✅ 4 upstream chat calls, all `status 200` (model deepseek/deepseek-v4-flash) |

**Conclusion**: opencode completed a full real coding task through the
freebuff2api proxy (write code → run tests → find a bug → fix it → all green);
the end-to-end chain is accepted.

To reproduce:

```bash
# 1. Start the proxy (keep it alive in tmux)
tmux new-session -d -s fba 'cd <repo> && LISTEN_ADDR=:18080 bun run src/index.ts'

# 2. Configure opencode (~/.config/opencode/config.json):
#    provider.freebuff = { npm: "@ai-sdk/openai-compatible",
#      options: { baseURL: "http://127.0.0.1:18080/v1", apiKey: "local" },
#      models: { "deepseek/deepseek-v4-flash": {} } }

# 3. Run
cd tests/agentic/cases/opencode-demo
opencode run --model freebuff/deepseek/deepseek-v4-flash --auto "<task description>"
```

## Stage 7: Complex-task acceptance (opencode built-in toolchain) ✅

> Acceptance criteria: opencode completes a multi-file complex task using its
> built-in tools (read / write / edit / bash / webfetch). Artifacts live in
> [`tests/agentic/cases/opencode-md2html/`](../../tests/agentic/cases/opencode-md2html/README.md).

Task: build a zero-dependency Markdown→HTML converter (`md2html.js` +
`cli.js` + `test.js` covering headings, paragraphs, lists, inline code, code
blocks, links, bold), convert `sample.md` via `node cli.js`, and fetch
`https://example.com` with webfetch.

| Step | Result |
| ---- | ---- |
| Session info | agent=build, model `freebuff/deepseek/deepseek-v4-flash`, 13 messages / **12 upstream chat calls** (all status 200 in proxy logs) |
| Tool usage (from session export) | `read` ×2, `write` ×5, `edit` ×2, `bash` ×6, `webfetch` ×2 |
| `node test.js` | ✅ all 10 assertions pass (incl. HTML escaping `a < b & c` → `a &lt; b &amp; c`) |
| `node cli.js sample.md` | ✅ output contains `<h1>` `<ul>` `<pre><code>` `<a href="https://opencode.ai">` |
| webfetch `https://example.com` | ✅ page title "Example Domain" |
| Zero dependencies | ✅ no third-party deps added |

**Conclusion**: the complex task passed end-to-end — opencode drove 12 model
calls through the proxy, used 5 built-in tools (read/write/edit/bash/
webfetch), handled the ESM environment on its own (re-read `package.json`),
and produced a complete runnable project.

## Stage 8: Luna / DeepSeek Flash fresh-session comparison

The official source confirms that the two models use separate root agents:

| Model | Agent |
| ---- | ---- |
| `openai/gpt-5.6-luna` | `base2-free-luna` |
| `deepseek/deepseek-v4-flash` | `base2-free-deepseek-flash` |

The official CLI sends an **empty-body** session POST and pins the model with
`x-freebuff-model`; waiting-room GET polling carries both
`x-freebuff-instance-id` and `x-freebuff-compact-session: 1`. One account can
hold only one active session, so the models cannot be switched within one
session. End the old session or use separate accounts for independent probes.

Two fresh-session minimal Chat probes were run through the proxy:

| Model | Fresh-session / Chat result | Conclusion |
| ---- | ---- | ---- |
| `openai/gpt-5.6-luna` | HTTP `503 server_error`, about 2 seconds | No usable response was available for this account/upstream state; this does not prove permanent model unavailability |
| `deepseek/deepseek-v4-flash` | Previously completed live E2E returned HTTP 200; this probe depends on the account's current session/quota state | The proxy chain is functional, but it needs an independent fresh-session retest |

The proxy defect identified was that `409 model_unavailable` or
`409 model_locked` from session creation could be treated as a cache state and
refreshed repeatedly, leaving the client with a timeout or generic 503.
The current fix:

1. Aligns session POST/GET with the official CLI (empty POST body, compact poll);
2. Prevents terminal session states from looping forever;
3. Preserves `409` and `error.code` for model admission errors instead of
   confusing them with waiting-room/no-healthy-token `503`;
4. Adds regression coverage for wire shape and terminal admission errors.

## Stage 9: Dual-model re-verification (proxy + official CLI, MITM captured) ✅

> Executed 2026-08-07 with a real account, after the Stage 8 fix. The previous
> round's blocker (the executor's tmux helper could not write to `/tmp`) was
> worked around with a `script`-based PTY driver (`tools/cli-probe.mjs`) that
> drives the official CLI's TUI without tmux.

### 9.1 Both models now succeed through the proxy (fresh sessions)

| Model | Result | Notes |
| ---- | ---- | ---- |
| `openai/gpt-5.6-luna` | ✅ HTTP 200 in ~4.8s | session POST (`x-freebuff-model: openai/gpt-5.6-luna`) → `agent-runs` START `base2-free-luna` → chat `MODEL_PROBE_OK` |
| `deepseek/deepseek-v4-flash` | ✅ HTTP 200 in ~3.2s | same chain with `base2-free-deepseek-flash` |

This confirms the Stage 8 fix (preserve terminal 409 admission states, never
loop/refresh them into a generic 503). A session must be ended (`DELETE
/api/v1/freebuff/session`) before switching models — one account holds exactly
one model-locked session for 1 hour.

### 9.2 Model switch while a session is locked → 409, not 503

With a Luna session active, requesting `deepseek/deepseek-v4-flash` through the
proxy now returns (verified live):

```json
{"error":{"message":"free session unavailable for deepseek/deepseek-v4-flash: model_locked (session is locked to openai/gpt-5.6-luna)","type":"upstream_error","code":"model_locked"}}
HTTP 409
```

The upstream response is `409 model_locked` with `currentModel` /
`requestedModel`; the proxy surfaces it instead of masking it as 503.

### 9.3 Official CLI, MITM-captured (both models, full chat chain)

Drove the real `freebuff` CLI (v0.0.142) through
`tools/mitm-ssl-proxy.mjs`; the model is selected by editing
`~/.config/manicode/settings.json` `freebuffModel` (the CLI shows a model
picker on first launch — press Enter on the highlighted model).

| Model | Session POST | agent-runs START | chat POST | Reply |
| ---- | ---- | ---- | ---- | ---- |
| `deepseek/deepseek-v4-flash` | ✅ 200 `x-freebuff-model: deepseek/deepseek-v4-flash` | ✅ `base2-free-deepseek-flash` | ✅ 200 (99,383-byte body, full system prompt + 24 tools) | `MODEL_PROBE_OK` |
| `openai/gpt-5.6-luna` | ✅ 200 `x-freebuff-model: openai/gpt-5.6-luna` | ✅ `base2-free-luna` | ✅ 200 (101,668-byte body) | `MODEL_PROBE_OK` (~10s) |

Official CLI request sequence (from the capture): `POST /api/v1/ads` → `GET
/api/v1/freebuff/session` (rejoin) → `GET /api/v1/me?fields=id,email` →
`POST /api/v1/freebuff/session` (`x-freebuff-model`, empty body) → `POST
/api/agents/validate` → `POST /api/v1/agent-runs` → `POST
/api/v1/chat/completions`.

### 9.4 Wire-format comparison (official CLI vs proxy)

| Aspect | Official CLI | freebuff2api | Compatible? |
| ---- | ---- | ---- | ---- |
| session POST body | empty (`content-length: 0`) | empty | ✅ |
| session POST headers | `Authorization` + `x-freebuff-model` + `Bun/1.3.14` UA (no acting-user-id) | same + `x-freebuff-acting-user-id` | ✅ (backend tolerates it) |
| agent-runs START | `{action, agentId, ancestorRunIds: []}` | identical | ✅ |
| chat UA | `ai-sdk/openai-compatible/0.0.0-test/...` | `.../0.10.7/...` | ✅ (gate ignores the version) |
| chat body | full system prompt + 24 tools + `stop`/`tool_choice` | minimal + injected `Buffy` marker, no tools | ✅ (gate only checks the system phrase) |
| `codebuff_metadata` | `run_id` / `client_id` / `cost_mode: "free"` / `freebuff_instance_id` / `trace_session_id` / `llm_step_number` | identical | ✅ |

### 9.5 Root-cause summary for the 503

1. **Pre-fix defect**: an upstream `409 model_unavailable` / `409
   model_locked` on session POST was cached as a non-active session state and
   refreshed in a loop; clients saw a hang or a generic `503`.
2. **Fix (already in the tree)**: terminal admission states are surfaced as a
   finite `409` + `error.code`; session POST/GET shapes match the CLI;
   `model` is pinned per session pool.
3. **This round's addition**: `model_locked` errors now name the locking model
   (`currentModel` from the upstream), and other upstream session-admission
   failures (`429` / `500` / `503` / `401`) pass through with their real status,
   `Retry-After` and message instead of a masked "no healthy upstream token
   available" (matching the official CLI, which retries 429/503 with backoff).
4. **Verified live**: both models 200; model switch → `409 model_locked`.

New debugging tools: `tools/probe-session.mjs` (per-model session admission
probe, no chat quota in `--admit-only` mode) and `tools/cli-probe.mjs`
(PTY-driven official-CLI probe with optional MITM capture). Regression tests
added in `tests/unit/{upstream,session,server}.test.ts`.

## Stage 10: Default public OpenCode upstream ✅

The public-provider path is enabled by default and is intentionally covered by
an explicit live test because it contacts a third-party service. The test starts
the standalone CLI with `AUTH_TOKENS` empty and omits
`PUBLIC_UPSTREAM_ENABLED`, so it verifies the actual default rather than an
explicit opt-in configuration.

| Check | Result |
| ---- | ---- |
| CLI startup without `AUTH_TOKENS` | ✅ ready on `/healthz` |
| `GET /v1/models` | ✅ HTTP 200 and includes `big-pickle` |
| `POST /v1/chat/completions` | ✅ HTTP 200 through OpenCode Zen; response matched `NOAUTH_DEFAULT_PROXY_OK` |
| Command | `LIVE_PUBLIC_UPSTREAM_TEST=1 bun test ./tests/e2e/public-upstream.e2e.test.ts --timeout 120000` |

The test is opt-in only to keep ordinary CI/unit runs independent of external
network availability; it does not mean the feature itself is opt-in.

## How to reproduce

All verification scripts are archived in `tools/` (see `tools/README.md`):

- `tools/e2e-test.mjs` — session/run/chat request-format exploration
- `tools/discover-gate.mjs` — gate variant bisection (reproduces doc 04's
  table)
- `tools/prodlike-test.mjs` — proxy-shape request verification (streaming +
  non-streaming)
- `tools/replay-captured.mjs` — replays the official captured request
- `tools/probe-session.mjs` — per-model session admission probe
  (`--admit-only` never consumes chat quota)
- `tools/cli-probe.mjs` — PTY-driven official-CLI probe (optional MITM capture)
- `tools/model-availability.mjs` — probes every `/v1/models` entry with a
  minimal chat (consumes quota per model)
