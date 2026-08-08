# 09 — Model Catalog & Routing

> The unified model catalog: canonical `provider/model` ids, deduplicated bare
> aliases, provider-priority routing, and image generation.
> Implementation: `src/models.ts`, `src/public-upstream.ts`, `src/handler.ts`.

## Canonical ids vs. bare aliases

Every model is exposed under two spellings at the same time:

| Form | Example | Purpose |
| ---- | ---- | ---- |
| Canonical id | `pollinations/openai`, `freebuff/deepseek-v4-flash` | Namespaced by provider; unambiguous; recommended for exact selection |
| Bare alias | `openai`, `deepseek-v4-flash` | Shortcut; deduplicated globally across all providers |

`GET /v1/models` lists every canonical id plus its bare alias (deduplicated,
sorted, OpenAI `list` shape with `owned_by: "freebuff2api"`). A prefixed id
always routes to its explicit provider. When a bare alias could belong to
multiple providers, routing follows provider priority: public providers in
`PUBLIC_UPSTREAM_PROVIDERS` order (default `opencode, pollinations, felo`),
then Freebuff last — so aliases are only a convenience and never change which
provider serves a prefixed request.

## Chat models (`POST /v1/chat/completions`)

### Freebuff (authenticated)

The full Freebuff registry (e.g. `deepseek/deepseek-v4-flash`) is listed as
`freebuff/<model>` plus its bare alias. These require a Freebuff token
(`AUTH_TOKENS` or saved login) and are the last-resort fallback.

### OpenCode Zen (no auth) — 4 models

`big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `nemotron-3-ultra-free`

OpenCode keeps its historical bare ids (`opencode/<model>` and the bare id are
the same string). Two earlier candidates (`hy3-free`, `north-mini-code-free`)
were removed after live checks returned 401 without an account token.

### Pollinations (no auth) — 8 models

`openai`, `openai-fast`, `openai-large`, `qwen-coder`, `mistral`, `deepseek`,
`grok`, `perplexity-fast`

Canonical ids are `pollinations/<model>` (e.g. `pollinations/openai`), bare
alias `openai`. `gemini-flash-lite-3.1` and `perplexity-reasoning` were removed
because anonymous calls return 401. Pollinations' anonymous chat tier
additionally returns 401 for some prompt shapes (a provider-side lottery, not a
proxy bug); the E2E probes use a benign prompt and retry transient failures.

### Felo (no auth, reverse-engineered) — 5 models

`felo-chat`, `felo-search`, `felo-scholar`, `felo-social`, `felo-document`

Canonical ids are `felo/<model>`, bare alias `felo-<model>`. Felo has no
official API; its web protocol may change at any time.

## Image models (`POST /v1/images/generations`)

Pollinations' no-auth image endpoint (`https://image.pollinations.ai`):
`flux`, `turbo`, `zimage` (canonical `pollinations/flux` etc., bare `flux` etc.).

Request (OpenAI images API shape):

```json
{
  "model": "pollinations/flux",
  "prompt": "a tiny red circle on a white background",
  "size": "256x256",
  "n": 1,
  "seed": 42,
  "response_format": "b64_json"
}
```

| Param | Meaning |
| ---- | ---- |
| `model` | Any allowlisted `pollinations/*` image model (prefixed or bare) |
| `prompt` | Required text prompt |
| `size` | `"WxH"` pixel size, forwarded as `width`/`height` |
| `n` | Number of images; each gets seed + i |
| `seed` | Optional; omitted = random |
| `response_format` | `b64_json` → only `b64_json` per item; otherwise `url` (a `data:` URI) plus `b64_json` |

Response:

```json
{ "created": 1786000000, "data": [{ "url": "data:image/jpeg;base64,...", "b64_json": "..." }] }
```

Notes: the upstream call is `GET image.pollinations.ai/prompt/<prompt>?width=…&height=…&seed=…&model=…&format=jpeg` with no credentials. `nologo` (watermark removal) requires an account token and is intentionally never sent — anonymous results carry the Pollinations logo. Images are fetched synchronously and base64-encoded before responding, so latency scales with generation time.

## Routing & fallback

- **Public chat:** when the public route is enabled and the requested model
  (prefixed or bare) matches a public provider, the public path is attempted
  first. Transient failures (`401/408/425/429/5xx` or timeout) fall through to
  other matching public providers and finally to the authenticated Freebuff
  path (if a token exists); non-retryable 4xx are returned directly.
- **Public image:** Pollinations only; a transient provider failure is surfaced
  directly (the client retries) rather than replayed against another provider.
- **Freebuff models:** `freebuff/<model>` or the bare alias is normalized to
  the canonical model id before the session/run/chat calls so the upstream
  always sees the correct model.

## Configuration knobs

| Env var | Default | Effect |
| ---- | ---- | ---- |
| `PUBLIC_UPSTREAM_ENABLED` | `true` | Disable all public providers |
| `PUBLIC_UPSTREAM_PROVIDERS` | `opencode,pollinations,felo` | Enabled provider ids and alias priority order |
| `PUBLIC_UPSTREAM_MODELS` | Aggregate allowlist | Public chat model whitelist (`provider/model` ids) |
| `PUBLIC_UPSTREAM_IMAGE_MODELS` | `pollinations/flux,pollinations/turbo,pollinations/zimage` | Image model whitelist |
| `PUBLIC_UPSTREAM_TIMEOUT` | `20s` | First-response timeout before fallback |

Full configuration reference: [07 - Configuration & Usage](07-configuration-and-usage.md).
