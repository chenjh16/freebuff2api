# 06 End-to-End Test Records

> This document records the key tests and conclusions from the development and
> reverse-engineering process, for reproduction and debugging. All tests used
> a real account (credentials at
> `~/.config/freebuff2api/credentials.json`).

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

## How to reproduce

All verification scripts are archived in `tools/` (see `tools/README.md`):

- `tools/e2e-test.mjs` — session/run/chat request-format exploration
- `tools/discover-gate.mjs` — gate variant bisection (reproduces doc 04's
  table)
- `tools/prodlike-test.mjs` — proxy-shape request verification (streaming +
  non-streaming)
- `tools/replay-captured.mjs` — replays the official captured request
