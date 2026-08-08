<div align="center">

# freebuff2api

[![CI](https://github.com/chenjh16/freebuff2api/actions/workflows/ci.yml/badge.svg)](https://github.com/chenjh16/freebuff2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/freebuff2api.svg)](https://www.npmjs.com/package/freebuff2api)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.0-black.svg)](https://bun.sh)

**OpenAI-compatible reverse proxy for the Freebuff coding API**
**OpenAI 兼容的 Freebuff 编码 API 反向代理**

[**English**](#english) · [**中文**](#中文)

</div>

---

# English

## What it is

freebuff2api is an **OpenAI-compatible reverse proxy** for the
**Freebuff** coding API ([freebuff.com](https://freebuff.com), the free AI
coding agent). It exposes a standard OpenAI `/v1` surface and relays requests
to the Freebuff backend using a free account's auth token — so any
OpenAI-compatible client (Claude Code, Cline, LobeChat, curl, …) can drive
Freebuff's free models.

You can use it two ways:

- **Hosted web console + API** — the repository ships a Next.js web app that
  is deployed to a public URL (`https://open.freebuff.app`): sign in with your
  Freebuff account in the browser, get your own `sk-fb-*` API key, and point
  any OpenAI-compatible client at the public `/v1` endpoint. No VPS needed
  (see [Quick start](#quick-start) and
  [Hosted deployment](#hosted-deployment-freebuff)).
- **Standalone local proxy** — run the CLI server on your own machine
  (`bun run dev:cli`) and point clients at `http://localhost:23333/v1`.
  The default OpenCode public models work without an account token; add
  `AUTH_TOKENS` (or run login) for Freebuff-only models and authenticated
  fallback.

Zero runtime dependencies for the core proxy. Written in TypeScript for
[Bun](https://bun.sh) (also runs on Node 22+ with
`node --experimental-strip-types` or after `bun run build:cli`).

> 📖 Full documentation: [`docs/`](docs/README.md) (bilingual by directory,
> semantically identical). English: [`docs/en/`](docs/en/README.md) —
> Chinese: [`docs/zh/`](docs/zh/README.md). Debugging & analysis tools in
> [`tools/`](tools/README.md).
>
> This project was implemented against the live Freebuff backend protocol
> (verified against the official
> [`CodebuffAI/freebuff`](https://github.com/CodebuffAI/freebuff) client
> source). It is a third-party tool, not affiliated with Freebuff. Free
> access can be gated by the service at any time — use responsibly.

## Quick start

### Option A — hosted web console (recommended, no local setup)

The hosted app is already deployed at **`https://open.freebuff.app`**:

1. Open the site and **sign in with your Freebuff account** (browser
   device-code flow, same as the official CLI).
2. If you don't have an API key yet, one is generated for you
   automatically (`sk-fb-…`). The console shows your **Base URL** and ready
   **curl** test commands (Windows & UNIX) with one-click copy.
3. Point any OpenAI-compatible client at the public endpoint:

```bash
curl https://open.freebuff.app/v1/chat/completions \
  -H "Authorization: Bearer <your sk-fb-... API key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"freebuff/deepseek/deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

The console also includes a built-in **model playground** (streaming replies +
Thinking output) so you can try models right in the browser.

> The site may be protected by a **gate token** (`SITE_ACCESS_TOKEN`): if you
> see a lock screen, enter the token or open the site with
> `https://open.freebuff.app/?token=…`. The gate is only the console's front
> door — the `/v1` API is always protected by your API key.

### Option B — standalone local proxy (CLI)

```bash
bun install

# Option B1 (recommended): sign in with a device-code login flow.
# Prints a URL to open in your browser; credentials are stored at
# ~/.config/freebuff2api/credentials.json.
bun run login

# Option B2: provide a token directly
# export AUTH_TOKENS="<your freebuff.com token>"

bun run dev:cli    # standalone proxy server (was `bun run dev` in older versions)
```

```bash
curl http://localhost:23333/v1/models
curl http://localhost:23333/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"freebuff/deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

Point any OpenAI-compatible client at `http://localhost:23333/v1`.

## How it works

Every model id is provider-namespaced (`freebuff/…`, `opencode/…`,
`pollinations/…`, `felo/…`); unprefixed ids are neither listed nor routable, so
a model id always names its provider. Public models are sent to the selected
fixed provider without forwarding client credentials; set
`PUBLIC_UPSTREAM_ENABLED=false` to disable all public routes. Requests that use
Freebuff-only models, or transient public-provider failures, use the
authenticated Freebuff session path:

1. **Acquires a free session** — `POST /api/v1/freebuff/session` with your
   token. If the service is under load it returns `queued` (the "waiting
   room"); the proxy answers the client with `503` + `Retry-After` and keeps
   polling so retries succeed.
2. **Starts an agent run** — `POST /api/v1/agent-runs` (`action: START`) for
   the agent that owns the requested model. Runs are reused across requests
   and rotated/finished automatically.
3. **Forwards the request** — `POST /api/v1/chat/completions` with your
   OpenAI payload plus the `codebuff_metadata` block the backend expects
   (`run_id`, `client_id`, `cost_mode: "free"`, `freebuff_instance_id`).
   Streaming (SSE) passes straight through.

   > **CLI gate (verified against the live backend):** the free-tier endpoint
   > rejects requests that don't look like they came from the official CLI
   > (`403 free_mode_cli_required`). The check is the **system message**: it
   > must contain the exact phrase `You are Buffy, the strategic coding
   > assistant` (the official agent's system-prompt opening). The proxy
   > automatically prepends/merges this marker into the client's messages, so
   > ordinary OpenAI clients don't need to know about it.
4. **Rotates tokens** — with multiple `AUTH_TOKENS`, requests round-robin
   across tokens; a token that gets rejected upstream (401) is cooled down for
   30 minutes instead of poisoning every request.

## Login

`freebuff2api login` implements the same device-code login flow as the
official Freebuff CLI (verified against the `CodebuffAI/freebuff` client
source):

1. `POST /api/auth/cli/code` with a persistent install fingerprint
2. prints a one-time URL (`freebuff.com/login?auth_code=…`) to open in your
   browser — no need to hand the token around manually
3. polls `GET /api/auth/cli/status` until you complete the sign-in, then saves
   the account record to `~/.config/freebuff2api/credentials.json`

```bash
bun run login                       # start login and wait for the browser sign-in
bun run login -- --resume           # keep waiting on an interrupted login
bun run login -- --force            # fresh login, ignoring saved credentials
```

The saved token is picked up automatically by the server when `AUTH_TOKENS`
is not set. Use `--force` later to refresh it. (Login uses `LOGIN_BASE_URL`,
which defaults to `https://freebuff.com`.)

## Configuration

General priority is **environment variables** → auto-detected `config.json` → saved
`login` credentials → defaults. `HTTP_PROXY` is the exception: **`--http-proxy`
CLI option > `config.json` > environment variable**.

| Env var             | Default                   | Description                                             |
| ------------------- | ------------------------- | ------------------------------------------------------- |
| `AUTH_TOKENS`       | *(optional when public provider is enabled)* | Comma-separated Freebuff auth tokens; needed for Freebuff-only models, authenticated fallback, or when public provider is disabled |
| `UPSTREAM_BASE_URL` | `https://www.codebuff.com`| Freebuff backend base URL                              |
| `LOGIN_BASE_URL`    | `https://freebuff.com`    | Base URL used by `freebuff2api login`                   |
| `LISTEN_ADDR`       | `:23333`                 | Listen address (`PORT` env wins in managed workspaces) |
| `REQUEST_TIMEOUT`   | `15m`                     | Upstream request timeout (Go-style durations)          |
| `ROTATION_INTERVAL` | `6h`                      | How long an agent run lives before rotation            |
| `API_KEYS`          | *(empty = open in standalone; hosted empty = fail closed)* | Comma-separated keys clients must present to the proxy |
| `SITE_ACCESS_TOKEN`| *(empty = gate off)*      | Hosted web console gate: visitors must enter this token (or open the site with `?token=…`) to use the console |
| `HTTP_PROXY`        | *(empty)*                 | Optional upstream HTTP(S) proxy; `--http-proxy` > `config.json` > environment |
| `MAX_BODY_SIZE`     | `16MB`                    | Maximum `/v1/chat/completions` body (16,000,000 bytes) |
| `MAX_CONCURRENT_REQUESTS` | `32`                | Maximum concurrent chat requests                  |
| `PUBLIC_UPSTREAM_ENABLED` | `true`              | Fixed anonymous providers before Freebuff; set `false` to disable all public routes |
| `PUBLIC_UPSTREAM_PROVIDERS` | `opencode,pollinations,felo` | Enabled fixed providers; arbitrary providers/URLs are rejected |
| `PUBLIC_UPSTREAM_BASE_URL` | `https://opencode.ai/zen/v1` | OpenCode-only HTTPS base URL override; Pollinations/Felo endpoints remain fixed |
| `PUBLIC_UPSTREAM_MODELS` | aggregated allowlist | Chat model allowlist (canonical `provider/model` ids); never arbitrary model ids |
| `PUBLIC_UPSTREAM_IMAGE_MODELS` | `pollinations/flux,pollinations/turbo,pollinations/zimage` | Image models for `POST /v1/images/generations` (Pollinations, anonymous) |
| `PUBLIC_UPSTREAM_TIMEOUT` | `20s`              | Initial response timeout before trying another public provider or Freebuff |

See [`config.example.json`](config.example.json) and [`env.example`](env.example).

With the default public provider enabled, standalone CLI mode can serve
allowlisted OpenCode models without `AUTH_TOKENS`. Configure `AUTH_TOKENS` or
run `freebuff2api login` for Freebuff-only models and authenticated fallback;
if `PUBLIC_UPSTREAM_ENABLED=false`, a token is required. In hosted web-login
mode `AUTH_TOKENS` remains optional because each visitor can sign in and receive
a personal `sk-fb-*` key.

The token is a freebuff.com account token (the same one your browser session
uses). Keep it secret — it grants API usage on your account.

## Endpoints

| Method | Path                     | Description                                  |
| ------ | ------------------------ | -------------------------------------------- |
| GET    | `/healthz`               | Public liveness status                       |
| GET    | `/v1/models`             | Models currently available in free mode      |
| POST   | `/v1/chat/completions`   | OpenAI chat completions (streaming supported)|
| POST   | `/v1/images/generations` | OpenAI image generation (Pollinations, anonymous, base64 results) |

By default, the proxy aggregates four explicitly reviewed public capabilities: OpenCode Zen, keyless Pollinations (chat **and** image generation), and Felo's reverse-engineered web protocol. Every model id is provider-namespaced (`opencode/big-pickle`, `pollinations/openai`, `felo/felo-chat`, `freebuff/<model>`); unprefixed ids are neither listed nor routable. Set `PUBLIC_UPSTREAM_ENABLED=false` to use the authenticated Freebuff path only, or narrow `PUBLIC_UPSTREAM_PROVIDERS` / `PUBLIC_UPSTREAM_MODELS` / `PUBLIC_UPSTREAM_IMAGE_MODELS`. `PUBLIC_UPSTREAM_BASE_URL` can override only the allowlisted OpenCode host; Pollinations and Felo always use their fixed HTTPS endpoints. No downstream API keys, cookies, or Freebuff account tokens are forwarded. Timeout, 401, 408, 425, 429, and 5xx responses try another matching public route and then authenticated Freebuff; a normal 4xx is returned directly. The public routes receive prompts and code, and Felo has no official API, so review each provider's terms and privacy posture before deployment.

Models are kept in sync with the official client by fetching
`CodebuffAI/freebuff`'s `free-agents.ts` every 6 hours; a curated fallback
keeps the proxy working if the fetch fails.

## Hosted deployment (Freebuff)

The repository ships a Next.js App Router app (`app/`) that mounts the
exact same proxy handler behind `/v1`, so the project can be deployed to
Freebuff hosting without a VPS:

- **Domain:** `https://open.freebuff.app`
- **Base URL:** `https://open.freebuff.app/v1`
- **Endpoints:** `GET /healthz` · `GET /v1/models` · `POST /v1/chat/completions` · `POST /v1/images/generations`
- **Auth:** `Authorization: Bearer <API_KEYS entry>` (or `x-api-key`)

Deployment environment:

| Var           | Required | Meaning                                                                 |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `AUTH_TOKENS` | no       | Optional shared Freebuff auth token pool; hosted web login works without it |
| `PROXY_SECRET`| no       | Stable secret that encrypts web-login API keys (`sk-fb-…`); set a fixed value so keys survive redeploys |
| `API_KEYS`    | no       | Explicit client keys; hosted deployments fail closed when unset       |
| `SITE_ACCESS_TOKEN`| no    | Locks the web console: visitors must enter this token (or arrive via `?token=…`) before the page unlocks; unset = console open |

Every other variable from the configuration table above
(`UPSTREAM_BASE_URL`, `REQUEST_TIMEOUT`, …) works the same in the hosted app.

```bash
# after the first deploy (Deploy button), later redeploys are one command
freebuff-deploy start

# point any OpenAI-compatible client at the public URL
curl https://open.freebuff.app/v1/chat/completions \
  -H "Authorization: Bearer <your-explicit-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"freebuff/deepseek/deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

Notes:

- Hosting runs `next build` automatically; `build:web` only produces the
  build output and never starts a server.
- `/` serves a small live console (health, model list, try-a-chat).
- **Site gate:** set `SITE_ACCESS_TOKEN` and the console shows a lock screen
  until the visitor enters the token (or opens the site with
  `https://…/?token=…`); the browser then remembers it. Unset = console open.
  The gate is the console's front door only — `/v1` stays protected by
  `API_KEYS`.
- `/healthz` is public and liveness-only; it does not expose account ids,
  token fragments, queue state, or model registry details. Hosted web login can
  operate without `AUTH_TOKENS`; if the runtime cannot initialize, it answers
  `200 {ok:false, configured:false}` while other proxy endpoints return a clear 503.
- CORS is open on `/v1/*` so browser clients can call the endpoint directly.
- The Freebuff account limit still applies: one session (1 hour) per account,
  locked to a single model. The proxy returns `409 model_locked` with the
  locked model name instead of masking it as a 503.

Full guide: [`docs/en/08-hosted-deployment.md`](docs/en/08-hosted-deployment.md).

## Development

```bash
bun run typecheck   # tsc -b --noEmit
bun run build       # next build — hosted deployment artifact (what hosting runs)
bun run build:cli   # bundles to dist/index.js (node target; bin: freebuff2api)
bun run start       # run the built CLI bundle
bun run login       # device-code login (see above)
bun run check       # typecheck + build
```

## Documentation

- [`docs/`](docs/README.md) — full documentation (bilingual by directory,
  semantically identical): protocol reverse-engineering, the free-tier CLI
  gate crack, e2e test records
- [`docs/en/`](docs/en/README.md) — English documentation
- [`docs/zh/`](docs/zh/README.md) — Chinese documentation
- [`tools/`](tools/README.md) — debugging scripts (TLS MITM proxy, gate
  discovery, replay, production-shape verification, per-model session/CLI
  probes) and captured artifacts
- [`docs/en/04-request-format-gate.md`](docs/en/04-request-format-gate.md) — **the core
  finding**: how the free-tier gate works and the exact request format
- [`docs/en/06-e2e-test-records.md`](docs/en/06-e2e-test-records.md) — stage 9:
  dual-model re-verification (proxy + official CLI, MITM captured) and the
  503 root-cause analysis
- [`docs/en/10-public-upstream-channels.md`](docs/en/10-public-upstream-channels.md) — the
  fixed public channels (OpenCode / Pollinations / Felo), their verified
  quirks, streaming normalization, and Cherry Studio compatibility

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report bugs / request features via
[GitHub Issues](https://github.com/chenjh16/freebuff2api/issues).

## License

[MIT](LICENSE) © 2026 chenjh16

## Roadmap / not yet implemented

- Claude-compatible `/v1/messages` + `/v1/messages/count_tokens` endpoints
- Tool-schema normalization for chat clients that emit complex JSON Schema
- Per-key rate limiting / usage stats

---

# 中文

## 项目作用

**freebuff2api** 是 **Freebuff**（[freebuff.com](https://freebuff.com)，免费的
AI 编码助手）编码 API 的 **OpenAI 兼容反向代理**。它在本地暴露标准的 OpenAI
`/v1` 接口，用免费账号的 auth token 把请求转发到 Freebuff 后端——让任何
OpenAI 兼容客户端（Claude Code、Cline、LobeChat、curl…）都能驱动 Freebuff
的免费模型。

有两种使用方式：

- **托管 Web 控制台 + API** —— 仓库内置 Next.js 应用，已部署到公网域名
  （`https://open.freebuff.app`）：在浏览器里用 Freebuff 账号登录，自动获得
  专属 `sk-fb-*` API Key，再把任意 OpenAI 兼容客户端指向公网 `/v1` 端点。
  无需 VPS（见[快速开始](#快速开始)与[托管部署](#托管部署freebuff)）。
- **独立本地代理** —— 在自己机器上运行 CLI 服务器（`bun run dev:cli`），
  默认无需 auth token 即可使用白名单 OpenCode 公共模型；配置 token 后还可使用
  Freebuff 专属模型和认证回退，把客户端指向 `http://localhost:23333/v1` 即可。

核心代理零运行时依赖。TypeScript 编写，面向 [Bun](https://bun.sh)（也可在
Node 22+ 上用 `node --experimental-strip-types` 或先 `bun run build:cli` 后运行）。

> 📖 完整中文文档见 [`docs/zh/`](docs/zh/README.md)，英文版见
> [`docs/en/`](docs/en/README.md)（中英内容语义一致）。文档包含上游协议
> 逆向分析、免费模式网关破解过程、端到端测试记录。调试与分析工具见
> [`tools/`](tools/README.md)。
>
> 本项目基于对线上 Freebuff 后端协议的实际逆向实现（已对照官方
> [`CodebuffAI/freebuff`](https://github.com/CodebuffAI/freebuff) 客户端源码
> 验证）。这是第三方工具，与 Freebuff 无关联。免费通道随时可能被官方
> 收紧——请合理使用。

## 快速开始

### 方式 A — 托管 Web 控制台（推荐，无需本地环境）

托管应用已部署在 **`https://open.freebuff.app`**：

1. 打开网站，用 **Freebuff 账号登录**（浏览器设备码流程，与官方 CLI 相同）。
2. 如果还没有 API Key，会自动为你生成一个（`sk-fb-…`）。控制台会显示你的
   **Base URL** 和现成的 **curl** 测试命令（Windows / UNIX，一键复制）。
3. 把任意 OpenAI 兼容客户端指向公网端点：

```bash
curl https://open.freebuff.app/v1/chat/completions \
  -H "Authorization: Bearer <你的 sk-fb-... API Key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"freebuff/deepseek/deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

控制台还内置**模型测试界面**（流式回复 + Thinking 输出），可以直接在浏览器
里试用模型。

> 网站可能受**门禁 token**（`SITE_ACCESS_TOKEN`）保护：如果看到锁屏，输入
> token，或直接打开 `https://open.freebuff.app/?token=…`。门禁只是控制台的
> "前门"——`/v1` API 始终由你的 API Key 保护。

### 方式 B — 独立本地代理（CLI）

```bash
bun install

# 方式 B1（推荐）：设备码登录，凭证存 ~/.config/freebuff2api/credentials.json
bun run login

# 方式 B2：直接提供 token
# export AUTH_TOKENS="<你的 freebuff.com token>"

bun run dev:cli    # 独立代理服务器（旧版本为 `bun run dev`）
```

```bash
curl http://localhost:23333/v1/models
curl http://localhost:23333/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"freebuff/deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

把任何 OpenAI 兼容客户端指向 `http://localhost:23333/v1` 即可。

## 工作原理

所有模型 ID 都使用带供应商命名空间的 `provider/model` 规范形式（`freebuff/…`、`opencode/…`、`pollinations/…`、`felo/…`），不带前缀的裸 ID 不会被列出也不可路由，因此模型 ID 总是标明其供应商。默认启用固定 HTTPS 公共上游集合（OpenCode Zen、免 key 的 Pollinations——含 chat 与图片生成、Felo 逆向网页协议适配），不转发下游凭证；设置 `PUBLIC_UPSTREAM_ENABLED=false` 可关闭全部公共链路。公共提供商按匹配模型尝试并在瞬态失败时回退认证链路。

Freebuff 的免费档按**会话（session）**发放。认证链路对每次 chat 请求：

1. **获取免费会话** — 用你的 token 调 `POST /api/v1/freebuff/session`。
   服务繁忙时返回 `queued`（"等待室"）；代理向客户端返回 `503 +
   Retry-After` 并持续轮询，让重试能够成功。
2. **启动 Agent 运行** — 按请求的 model 选择对应的 Agent，调
   `POST /api/v1/agent-runs`（`action: START`）。run 在请求间复用，并按
   间隔自动轮换 / 结束时自动结束。
3. **转发请求** — 把你的 OpenAI 载荷加上后端需要的 `codebuff_metadata`
   块（`run_id`、`client_id`、`cost_mode: "free"`、`freebuff_instance_id`）
   后调 `POST /api/v1/chat/completions`。流式（SSE）直接透传。

   > **CLI 网关（已对照线上后端验证）**：免费档端点会拒绝看起来不像来自
   > 官方 CLI 的请求（`403 free_mode_cli_required`）。检查点是 **system
   > 消息**：必须包含精确短语 `You are Buffy, the strategic coding
   > assistant`（官方 agent 系统提示的开头）。代理会自动在客户端的
   > messages 中前置/合并该标记，普通 OpenAI 客户端无需感知。
4. **轮换令牌** — 配置多个 `AUTH_TOKENS` 时轮询使用；被上游 401 拒绝的
   token 冷却 30 分钟，避免污染所有请求。

## 登录

`freebuff2api login` 实现了与官方 Freebuff CLI 相同的设备码（device-code）
登录流程（已对照 `CodebuffAI/freebuff` 客户端源码验证）：

1. 用持久安装指纹调 `POST /api/auth/cli/code`
2. 打印一次性链接（`freebuff.com/login?auth_code=…`）供浏览器打开——
   无需手动传递 token
3. 轮询 `GET /api/auth/cli/status` 直到你完成登录，然后把账号记录保存到
   `~/.config/freebuff2api/credentials.json`

```bash
bun run login                       # 开始登录并等待浏览器确认
bun run login -- --resume           # 继续等待被中断的登录
bun run login -- --force            # 忽略已存凭证，重新登录
```

`AUTH_TOKENS` 未设置时，服务器自动使用登录保存的 token；之后可用
`--force` 刷新。（登录使用 `LOGIN_BASE_URL`，默认 `https://freebuff.com`。）

## 配置

通用配置优先级：**环境变量** → `config.json`（工作目录自动检测）→ 登录凭证 → 默认值。
`HTTP_PROXY` 例外按 **命令行参数 `--http-proxy` > `config.json` > 环境变量** 解析。

| 环境变量             | 默认值                       | 说明                                        |
| ------------------- | ---------------------------- | ------------------------------------------- |
| `AUTH_TOKENS`       | *(公共上游开启时可选)*       | 逗号分隔的 Freebuff auth token；使用 Freebuff 专属模型、认证回退或关闭公共上游时需要 |
| `UPSTREAM_BASE_URL` | `https://www.codebuff.com`   | Freebuff 后端地址                           |
| `LOGIN_BASE_URL`    | `https://freebuff.com`       | `freebuff2api login` 使用的 base URL        |
| `LISTEN_ADDR`       | `:23333`                    | 监听地址（托管环境以 `PORT` 优先）           |
| `REQUEST_TIMEOUT`   | `15m`                        | 上游请求超时（Go 风格时长）                 |
| `ROTATION_INTERVAL` | `6h`                         | run 轮换间隔                                |
| `API_KEYS`          | *(独立模式空 = 开放；托管空值 = fail closed)* | 客户端访问本代理需携带的 key                 |
| `SITE_ACCESS_TOKEN`| *(空 = 不启用)*             | 托管 Web 控制台门禁：访客须输入该 token（或用 `?token=…` 打开站点）才能使用控制台 |
| `HTTP_PROXY`        | *(空)*                       | 可选的上游 HTTP(S) 代理；优先级为 `--http-proxy` > `config.json` > 环境变量 |
| `MAX_BODY_SIZE`     | `16MB`                       | `/v1/chat/completions` 请求体上限（16,000,000 字节） |
| `MAX_CONCURRENT_REQUESTS` | `32`                   | 最大并发 chat 请求数                         |
| `PUBLIC_UPSTREAM_ENABLED` | `true`                 | 默认启用固定公共上游（优先于 Freebuff）；设为 `false` 可关闭 |
| `PUBLIC_UPSTREAM_PROVIDERS` | `opencode,pollinations,felo` | 允许的固定公共提供商；不接受任意 URL |
| `PUBLIC_UPSTREAM_MODELS` | 聚合免认证模型白名单       | chat 模型白名单（规范 `provider/model` ID），不接受任意模型 ID |
| `PUBLIC_UPSTREAM_IMAGE_MODELS` | `pollinations/flux,pollinations/turbo,pollinations/zimage` | `POST /v1/images/generations` 的图片模型（Pollinations，匿名） |
| `PUBLIC_UPSTREAM_TIMEOUT` | `20s`                 | 免认证上游首响应超时，之后回退 Freebuff |

参见 [`config.example.json`](config.example.json) 与
[`env.example`](env.example)。

默认公共上游开启时，独立 CLI 可以不配置 `AUTH_TOKENS` 直接使用白名单公共模型（例如 `opencode/big-pickle`、`pollinations/openai`、`felo/felo-chat`）；使用 Freebuff 专属模型、认证回退或设置
`PUBLIC_UPSTREAM_ENABLED=false` 时，需要 `AUTH_TOKENS` 或已保存的登录凭证。
托管网页登录模式可以不设置它，访客登录后使用自己的 `sk-fb-*` key。

token 是 freebuff.com 账号令牌（与浏览器会话一致）。请保密——它代表你
账号的 API 使用权。

## 端点

| 方法 | 路径                     | 说明                                       |
| ---- | ------------------------ | ------------------------------------------ |
| GET  | `/healthz`               | 公开存活状态（仅 liveness）                 |
| GET  | `/v1/models`             | 免费模式当前可用的模型                     |
| POST | `/v1/chat/completions`   | OpenAI chat completions（支持流式）        |
| POST | `/v1/images/generations` | OpenAI 图片生成（Pollinations，匿名，返回 base64） |

默认情况下，代理聚合四个经过实测的公共能力：OpenCode Zen、免 key 的 Pollinations（chat 与图片生成）、Felo 逆向网页协议适配。每个模型 ID 都是带供应商命名空间的 `provider/model` 形式（`opencode/big-pickle`、`pollinations/openai`、`felo/felo-chat`、`freebuff/<model>`），不带前缀的裸 ID 不会被列出也不可路由。设置 `PUBLIC_UPSTREAM_ENABLED=false` 可关闭并只使用 Freebuff 认证链路；也可以用 `PUBLIC_UPSTREAM_PROVIDERS`、`PUBLIC_UPSTREAM_MODELS` 与 `PUBLIC_UPSTREAM_IMAGE_MODELS` 缩小范围。不会向公共上游转发下游 API Key、Cookie 或 Freebuff 账号 token；公共提供商按匹配模型尝试，超时、401、408、425、429、5xx 等瞬态失败才继续尝试其他公共 provider 或回退到 Freebuff，普通 4xx 直接返回。Pollinations 白名单只包含实测无 key 可调用的模型（2026-08-08 实测：`gemini-flash-lite-3.1`、`perplexity-reasoning` 即使最简 prompt 也 401，已排除；其余模型对部分 prompt 形状也会返回 401，建议配合重试与 Freebuff 回退）。Felo 是无官方 API 的逆向网页协议，可能随时变化。所有公共上游都会接收请求中的提示词和代码，部署前请确认服务条款与隐私要求。

模型列表与官方客户端保持同步：每 6 小时抓取 `CodebuffAI/freebuff` 的
`free-agents.ts`；抓取失败时使用内置兜底映射，保证代理可用。

## 托管部署（Freebuff）

仓库内置一个 Next.js App Router 应用（`app/`），把完全相同的代理
handler 挂到 `/v1` 上——无需 VPS，可直接部署到 Freebuff 托管：

- **域名：** `https://open.freebuff.app`
- **Base URL：** `https://open.freebuff.app/v1`
- **端点：** `GET /healthz` · `GET /v1/models` · `POST /v1/chat/completions` · `POST /v1/images/generations`
- **鉴权：** `Authorization: Bearer <API_KEYS 中的某个 key>`（或 `x-api-key`）

部署环境变量：

| 变量           | 必需 | 说明                                                                    |
| ------------- | ---- | ----------------------------------------------------------------------- |
| `AUTH_TOKENS` | 否   | 可选的共享 Freebuff auth token 池；托管网页登录无需设置                 |
| `PROXY_SECRET`| 否   | 加密网页登录 API Key（`sk-fb-…`）的稳定密钥；设置固定值可让 key 跨重新部署保持有效 |
| `API_KEYS`    | 否   | 客户端显式高熵 key；未配置时托管 `/v1` fail closed                       |
| `SITE_ACCESS_TOKEN`| 否 | 网页控制台门禁：访客须输入该 token（或带 `?token=…` 访问）才能解锁页面；未设置 = 控制台开放 |

配置表中的其它变量（`UPSTREAM_BASE_URL`、`REQUEST_TIMEOUT` …）在托管环境
中同样生效。

```bash
# 首次部署在 Deploy 面板完成；之后可用一条命令重新部署
freebuff-deploy start

# 把任何 OpenAI 兼容客户端指向公开地址
curl https://open.freebuff.app/v1/chat/completions \
  -H "Authorization: Bearer <your-explicit-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"freebuff/deepseek/deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

注意事项：

- 托管环境会自动执行 `next build`；`build:web` 只产出构建结果，绝不会
  启动服务器。
- `/` 是一个小型在线控制台（健康状态、模型列表、试聊）。
- **站点门禁：** 设置 `SITE_ACCESS_TOKEN` 后，控制台显示锁屏，访客必须
  输入 token（或通过 `https://…/?token=…` 打开）才能进入；浏览器会记住
  该 token。未设置则控制台保持开放。门禁只是控制台的"前门"——`/v1`
  接口仍由 `API_KEYS` 保护。
- `/healthz` 始终公开；托管网页登录可以不配置 `AUTH_TOKENS`。若运行时无法
  建立处理器，则返回 `200 {ok:false, configured:false}`，其它代理端点返回明确
  的 503。
- `/v1/*` 开放 CORS，浏览器客户端可直接调用。
- Freebuff 账号限制仍然适用：每个账号同一时间只有一个会话（1 小时）且
  锁定单一模型；代理返回 `409 model_locked` 并附上锁定模型名，而不是
  把它掩盖成 503。

完整指南见 [`docs/zh/08-托管部署.md`](docs/zh/08-托管部署.md)。

## 开发

```bash
bun run typecheck   # tsc -b --noEmit
bun run build       # next build —— 托管部署产物（托管执行的构建命令）
bun run build:cli   # 打包到 dist/index.js（node 目标；bin: freebuff2api）
bun run start       # 运行打包产物（CLI 服务器）
bun run login       # 设备码登录（见上文）
bun run check       # typecheck + build
```

## 文档

- [`docs/`](docs/README.md) — 完整文档（中英双语，按目录区分）：
  协议逆向、免费档 CLI 网关破解、端到端测试记录
- [`docs/zh/`](docs/zh/README.md) — 中文文档
- [`docs/en/`](docs/en/README.md) — English documentation
- [`tools/`](tools/README.md) — 调试脚本（TLS MITM 代理、网关探索、重放、
  生产形状验证、逐模型会话/CLI 探针）与抓包产物
- [`docs/zh/04-请求格式破解.md`](docs/zh/04-请求格式破解.md) — **核心发现**：
  免费档网关机制与正确请求格式
- [`docs/zh/06-端到端测试记录.md`](docs/zh/06-端到端测试记录.md) — 阶段 9：
  双模型复测（代理 + 官方 CLI，MITM 抓包）与 503 根因分析
- [`docs/zh/10-公共上游渠道.md`](docs/zh/10-公共上游渠道.md) — 固定公共渠道
  （OpenCode / Pollinations / Felo）、实测行为、流式规范化与 Cherry Studio
  兼容性

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。报告 bug / 请求功能请走
[GitHub Issues](https://github.com/chenjh16/freebuff2api/issues)。

## 许可证

[MIT](LICENSE) © 2026 chenjh16

## 路线图 / 未实现

- Claude 兼容的 `/v1/messages` + `/v1/messages/count_tokens` 端点
- 面向发出复杂 JSON Schema 的 chat 客户端的工具 schema 归一化
- 按 key 的限流 / 用量统计
