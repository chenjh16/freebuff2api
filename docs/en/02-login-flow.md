# 02 Login Flow (device-code)

> This document records how `freebuff2api login` reverse-engineered the login
> flow of the official Freebuff CLI
> ([CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff)).
> Implementation lives in `src/login.ts`.

## Background

Why a login link and stored credentials? Free mode requires the account's
auth token (the same one the browser session uses). Copying the token by hand
is tedious and easy to leak, so we replicated the official CLI's
"device-code" login: print a one-time link, the user signs in in the browser,
and the CLI polls until it receives the credentials.

## The official CLI's login flow

### 1. Request a one-time login code

```
POST {base}/api/auth/cli/code
Content-Type: application/json

{ "fingerprintId": "<install fingerprint>" }
```

Response (HTTP 200):

```json
{
  "loginUrl": "https://freebuff.com/login?auth_code=…",
  "fingerprintHash": "<64-char hex>",
  "expiresAt": 1786030…
}
```

### 2. The user opens `loginUrl` and signs in in the browser

No manual token copying — safer.

### 3. Poll the login status until it succeeds

```
GET {base}/api/auth/cli/status?fingerprintId=…&fingerprintHash=…&expiresAt=…
```

- Before sign-in completes it returns `401 "Authentication failed"` — this
  must be **retried silently** (matching the official client)
- After sign-in it returns:

```json
{
  "user": {
    "id": "280d0ec6-…",
    "name": "Never More",
    "email": "nevermore.thu@example.com",
    "authToken": "<token>",
    "fingerprintId": "…",
    "fingerprintHash": "…",
    "credits": …
  }
}
```

### 4. Save the credentials

Saved to `~/.config/freebuff2api/credentials.json` (same shape as the
official CLI, under the `default` key):

```json
{
  "default": {
    "id": "…",
    "name": "…",
    "email": "…",
    "authToken": "…",
    "fingerprintId": "…",
    "fingerprintHash": "…"
  }
}
```

## Install fingerprint

- The official CLI identifies the "device" with a persistent,
  hardware-derived fingerprint
- freebuff2api persists a random ID to
  `~/.config/freebuff2api/fingerprint`, formatted `codebuff-cli-<random>`
- Purpose: a stable cross-process device identity, also used to correlate
  later logins and sessions

## Implementation details (`src/login.ts`)

| Function | Responsibility |
| ---- | ---- |
| `requestLoginCode()` | Step 1: POST the login code request, validate the response shape |
| `pollLoginStatus()` | Step 3: poll with timeout (default 5 minutes), tolerating 401 |
| `runLoginCommand()` | Orchestration: resume / new / force login, persist credentials |
| `getFingerprintId()` | Read or generate the persistent fingerprint |

### Commands

```bash
bun run login                     # start login and wait for browser confirmation
bun run login -- --resume         # resume an interrupted login (same link)
bun run login -- --force          # ignore saved credentials, log in fresh
```

An interrupted login is saved to `~/.config/freebuff2api/pending-login.json`
and can be continued with `--resume`.

## Notes from real-world testing

- **One account has only one active session at a time.** If a session was
  created elsewhere (e.g. in the official CLI), you'll see
  `Another instance of freebuff has taken over this session` — you need to
  log in again (switch accounts or use `--force`).
- Credentials are the token: when `AUTH_TOKENS` is not set, the server
  automatically uses the token saved by login.
- The login base URL can be overridden with `LOGIN_BASE_URL`
  (default `https://freebuff.com`).

## Verification conclusions

- ✅ Full flow works: generate link → user signs in in browser → poll returns
  the user record → credentials persisted
- ✅ Resume flow: after an interruption, `--resume` continues waiting on the
  same link
- ✅ The server automatically uses the saved token (`acting_user_id` in
  `/healthz` is correct)
