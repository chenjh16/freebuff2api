# 01 Project Overview

## What it is

**freebuff2api** is a zero-runtime-dependency, OpenAI-compatible reverse proxy
with two goals:

1. Reuse a free account's auth token to forward standard OpenAI API requests
   to the Freebuff ([freebuff.com](https://freebuff.com), the free AI coding
   assistant) upstream backend
2. Expose an OpenAI-compatible `/v1` surface locally so any OpenAI client
   (Claude Code, Cline, LobeChat, curl, …) can drive Freebuff's free models

Tech stack: TypeScript + [Bun](https://bun.sh) (Node 22+ also works), no
third-party runtime dependencies.

## How it works in one sentence

Freebuff's free tier is granted per **session**: each account has exactly one
active session at a time. For every chat request the proxy:

1. **Acquires a free session** — `POST /api/v1/freebuff/session`
   (when busy, the backend enters a "waiting room"; the proxy answers the
   client with `503 + Retry-After` and keeps polling)
2. **Starts an agent run** — `POST /api/v1/agent-runs` (`action: START`),
   picking the agent that owns the requested model; runs are reused, rotated
   on an interval, and finished gracefully on shutdown
3. **Forwards the request** — `POST /api/v1/chat/completions`, injecting
   `codebuff_metadata` (`run_id`, `client_id`, `cost_mode: "free"`,
   `freebuff_instance_id`, …) plus the **CLI-identity system marker**
   (see [04 - Request Format & the CLI Gate](04-request-format-gate.md))
4. **Rotates tokens** — with multiple `AUTH_TOKENS`, requests round-robin
   across tokens; a token rejected with 401 upstream is cooled down for 30
   minutes so it doesn't poison every request

## Directory layout

```
src/
  index.ts      entry: argument parsing, server startup, graceful shutdown
  config.ts     config loading (env > config.json > login credentials > defaults)
  login.ts      device-code login flow (generate link, poll status, save credentials)
  upstream.ts   upstream HTTP client (session/run/chat endpoints + debug logging)
  session.ts    session pool management (SessionPool / TokenManager / token cooldown)
  runs.ts       run management (start, reuse, rotation, finish)
  models.ts     model registry (syncs the official Agent→model mapping)
  server.ts     OpenAI-compatible HTTP server (incl. CLI gate marker injection)
docs/            bilingual documentation (zh/ + en/)
tools/           debugging & analysis scripts (see tools/README.md)
```

## Module responsibilities

| Module | Responsibility |
| ---- | ---- |
| `login.ts` | `freebuff2api login` command; credentials saved to `~/.config/freebuff2api/credentials.json` |
| `config.ts` | Parses env / config.json / login credentials into a unified `Config` |
| `upstream.ts` | The 5 classes of upstream API calls; `DEBUG_UPSTREAM=1` prints plaintext requests |
| `session.ts` | One `SessionPool` per token; `TokenManager` handles rotation and cooldown |
| `runs.ts` | `RunManager` caches runId per (token, agent), rotates when expired |
| `models.ts` | Fetches the official `free-agents.ts` from GitHub and parses the Agent→model mapping (6h refresh) |
| `server.ts` | `/healthz`, `/v1/models`, `/v1/chat/completions`; injects the CLI marker |

## Public surface

| Method | Path | Description |
| ---- | ---- | ---- |
| GET | `/healthz` | Liveness + model registry + per-token session state |
| GET | `/v1/models` | Models currently available in free mode |
| POST | `/v1/chat/completions` | OpenAI-compatible chat (streaming supported) |

## Design notes

- **Zero dependencies**: only built-in Node/Bun capabilities; `fetch` honors
  the `HTTP_PROXY` env var natively
- **Session sharing**: concurrent requests for the same token share a single
  session refresh, so the upstream is not hammered
- **Graceful shutdown**: on SIGINT/SIGTERM, stop the server, FINISH all runs,
  then END the session
- **Fault tolerance**: an invalid session/run triggers one automatic retry
  (refresh session / rotate run); 401 puts the token into cooldown
