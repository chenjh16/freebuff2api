# 09 — Model Catalog & Routing

> The unified model catalog: provider-namespaced `provider/model` ids,
> provider-priority routing, and image generation.
> Implementation: `src/models.ts`, `src/public-upstream.ts`, `src/handler.ts`.

## Provider-namespaced ids

Every model is exposed under exactly one spelling: a provider-prefixed
`provider/model` id. There are **no bare (unprefixed) aliases** — unprefixed
ids are neither listed by `GET /v1/models` nor routable, so a model id always
names its provider explicitly.

| Provider | Model id form | Example |
| ---- | ---- | ---- |
| Freebuff (authenticated) | `freebuff/<registry-model>` | `freebuff/deepseek/deepseek-v4-flash` |
| OpenCode Zen | `opencode/<model>` | `opencode/big-pickle` |
| Pollinations chat | `pollinations/<model>` | `pollinations/openai` |
| Pollinations image | `pollinations/<model>` | `pollinations/flux` |
| Felo | `felo/<model>` | `felo/felo-chat` |

`GET /v1/models` lists every prefixed id (deduplicated, sorted, OpenAI `list`
shape). `owned_by` reports the owning provider: `freebuff2api` for Freebuff
registry models, and `opencode` / `pollinations` / `felo` for the public
channels. A prefixed id always routes to its explicit provider. When a request
fails transiently, it falls through the remaining matching public providers in
`PUBLIC_UPSTREAM_PROVIDERS` order (default `opencode, pollinations, felo`),
then the authenticated Freebuff path last.

## Chat models (`POST /v1/chat/completions`)

### Freebuff (authenticated)

The full Freebuff registry (e.g. `deepseek/deepseek-v4-flash`) is listed as
`freebuff/<model>` (e.g. `freebuff/deepseek/deepseek-v4-flash`). These require
a Freebuff token (`AUTH_TOKENS` or saved login) and are the last-resort
fallback.

### OpenCode Zen (no auth) — 4 models

`opencode/big-pickle`, `opencode/deepseek-v4-flash-free`,
`opencode/mimo-v2.5-free`, `opencode/nemotron-3-ultra-free`

Two earlier candidates (`hy3-free`, `north-mini-code-free`) were removed after
live checks returned 401 without an account token.

### Pollinations (no auth) — 8 models

`pollinations/openai`, `pollinations/openai-fast`, `pollinations/openai-large`,
`pollinations/qwen-coder`, `pollinations/mistral`, `pollinations/deepseek`,
`pollinations/grok`, `pollinations/perplexity-fast`

`gemini-flash-lite-3.1` and `perplexity-reasoning` were removed because
anonymous calls return 401. Pollinations' anonymous chat tier additionally
returns 401 for some prompt shapes (a provider-side lottery, not a proxy bug);
the E2E probes use a benign prompt and retry transient failures.

### Felo (no auth, reverse-engineered) — 5 models

`felo/felo-chat`, `felo/felo-search`, `felo/felo-scholar`, `felo/felo-social`,
`felo/felo-document`

Felo has no official API; its web protocol may change at any time.

## Image models (`POST /v1/images/generations`)

Pollinations' no-auth image endpoint (`https://image.pollinations.ai`):
`pollinations/flux`, `pollinations/turbo`, `pollinations/zimage`.

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
| `model` | Any allowlisted `pollinations/*` image model (prefixed) |
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

## Streaming compatibility (strict clients)

All public chat streams are normalized before being relayed so that strict
parsers (the Vercel AI SDK used by Cherry Studio, which aborts with
`AI_FinishReasonError` on an unknown or missing finish chunk) always receive a
well-formed stream:

- A terminal chunk with `finish_reason: "stop"` is guaranteed — if the upstream
  ends without a finish chunk (OpenCode's free tier occasionally truncates
  right after `reasoning_content`) or emits a non-standard reason such as
  `"other"`, the proxy rewrites/synthesizes `"stop"`.
- Content and `reasoning_content` deltas pass through untouched; usage chunks
  are preserved; malformed lines and junk trailers (e.g. OpenCode's
  `{"choices":[],"cost":"0"}`) are dropped; the stream always ends with a
  single `data: [DONE]`.

Known upstream behavior: `opencode/deepseek-v4-flash-free` is a free tier and
**stochastically** returns an empty final answer after streaming its reasoning
(the model thinks but does not answer). The proxy cannot invent content; with
this fix the client at least receives a clean `stop` termination instead of an
error. Retry the request (or use a different model) when that happens.

> Channel-by-channel details, provider quirks, and the Cherry Studio
> `AI_FinishReasonError` case are documented in
> [10 - Public Upstream Channels](10-public-upstream-channels.md).

## Routing & fallback

- **Public chat:** when the public route is enabled and the requested prefixed
  model matches a public provider, the public path is attempted first.
  Transient failures (`401/408/425/429/5xx` or timeout) fall through to other
  matching public providers and finally to the authenticated Freebuff path (if
  a token exists); non-retryable 4xx are returned directly.
- **Public image:** Pollinations only; a transient provider failure is surfaced
  directly (the client retries) rather than replayed against another provider.
- **Freebuff models:** `freebuff/<model>` is normalized to the canonical
  registry model id (the `freebuff/` namespace is stripped) before the
  session/run/chat calls so the upstream always sees the correct model.

## Configuration knobs

| Env var | Default | Effect |
| ---- | ---- | ---- |
| `PUBLIC_UPSTREAM_ENABLED` | `true` | Disable all public providers |
| `PUBLIC_UPSTREAM_PROVIDERS` | `opencode,pollinations,felo` | Enabled provider ids and fallback order |
| `PUBLIC_UPSTREAM_MODELS` | Aggregate allowlist | Public chat model whitelist (`provider/model` ids) |
| `PUBLIC_UPSTREAM_IMAGE_MODELS` | `pollinations/flux,pollinations/turbo,pollinations/zimage` | Image model whitelist |
| `PUBLIC_UPSTREAM_TIMEOUT` | `20s` | First-response timeout before fallback |

Full configuration reference: [07 - Configuration & Usage](07-configuration-and-usage.md).
