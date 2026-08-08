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
3. **Prefers fixed public routes** — for an allowlisted public model (OpenCode, Pollinations chat/image, or Felo), the proxy sends the translated body to the matching fixed HTTPS provider without forwarding downstream credentials. Every model id is provider-namespaced (`freebuff/<model>`, `opencode/<model>`, `pollinations/<model>`, `felo/<model>`); unprefixed ids are neither listed nor routable. On transient failure a request falls through the remaining matching public providers (Freebuff last). The aggregate is enabled by default and can be disabled with `PUBLIC_UPSTREAM_ENABLED=false`.
4. **Forwards authenticated requests** — `POST /api/v1/chat/completions`, injecting
   `codebuff_metadata` (`run_id`, `client_id`, `cost_mode: "free"`,
   `freebuff_instance_id`, …) plus the **CLI-identity system marker**
   (see [04 - Request Format & the CLI Gate](04-request-format-gate.md))
5. **Rotates tokens** — with multiple `AUTH_TOKENS`, requests round-robin
   across tokens; a token rejected with 401 upstream is cooled down for 30
   minutes so it doesn't poison every request

## Directory layout

```
src/
  index.ts      entry: argument parsing, server startup, graceful shutdown
  config.ts     config loading (env > config.json > login credentials > defaults)
  login.ts      device-code login flow (generate link, poll status, save credentials)
  upstream.ts   authenticated Freebuff HTTP client (session/run/chat endpoints + debug logging)
  public-upstream.ts  fixed-host public provider adapters, model namespaces, and fallback rules
  session.ts    session pool management (SessionPool / TokenManager / token cooldown)
  runs.ts       run management (start, reuse, rotation, finish)
  models.ts     model registry (syncs the official Agent→model mapping)
  server.ts     node:http adapter for the shared request handler
  handler.ts    shared Request→Response routing, auth, validation, and CLI marker injection
docs/            bilingual documentation (zh/ + en/)
tools/           debugging & analysis scripts (see tools/README.md)
```

## Module responsibilities

| Module | Responsibility |
| ---- | ---- |
| `login.ts` | `freebuff2api login` command; credentials saved to `~/.config/freebuff2api/credentials.json` |
| `config.ts` | Parses env / config.json / login credentials into a unified `Config` |
| `upstream.ts` | Authenticated Freebuff session/run/chat calls; `DEBUG_UPSTREAM=1` prints plaintext requests |
| `public-upstream.ts` | Fixed-host OpenCode/Pollinations/Felo adapters (chat + image), canonical id/alias catalog, model allowlist, credential isolation, timeout and fallback classification |
| `session.ts` | One `SessionPool` per token; `TokenManager` handles rotation and cooldown |
| `runs.ts` | `RunManager` caches runId per (token, agent), rotates when expired |
| `models.ts` | Fetches the official `free-agents.ts` from GitHub and parses the Agent→model mapping (6h refresh) |
| `handler.ts` | Shared `/healthz`, `/v1/models`, `/v1/chat/completions` routing, public-provider priority, auth, validation, fallback and CLI marker injection |
| `server.ts` | Adapts node:http streams to the shared web-native handler |

## Public surface

| Method | Path | Description |
| ---- | ---- | ---- |
| GET | `/healthz` | Public liveness status |
| GET | `/v1/models` | Models currently available in free mode |
| POST | `/v1/chat/completions` | OpenAI-compatible chat (streaming supported) |
| POST | `/v1/images/generations` | OpenAI-compatible image generation (Pollinations, anonymous) |

## Design notes

- **Zero dependencies**: only built-in Node/Bun capabilities; `fetch` honors
  the `HTTP_PROXY` env var natively
- **Session sharing**: concurrent requests for the same token share a single
  session refresh, so the upstream is not hammered
- **Graceful shutdown**: on SIGINT/SIGTERM, stop the server, FINISH all runs,
  then END the session
- **Fault tolerance**: an invalid session/run triggers one automatic retry
  (refresh session / rotate run); 401 puts the token into cooldown
