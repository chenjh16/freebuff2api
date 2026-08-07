<div align="center">

# freebuff2api

[![CI](https://github.com/chenjh16/freebuff2api/actions/workflows/ci.yml/badge.svg)](https://github.com/chenjh16/freebuff2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/freebuff2api.svg)](https://www.npmjs.com/package/freebuff2api)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.0-black.svg)](https://bun.sh)

**OpenAI 兼容的 Freebuff 编码 API 反向代理**
**OpenAI-compatible reverse proxy for the Freebuff coding API**

[**中文**](#中文) · [**English**](#english)

</div>

---

# 中文

**freebuff2api** 是 **Freebuff**（[freebuff.com](https://freebuff.com)，免费的
AI 编码助手）编码 API 的 OpenAI 兼容反向代理。它在本地暴露标准的 OpenAI
`/v1` 接口，用免费账号的 auth token 把请求转发到 Freebuff 后端——让任何
OpenAI 兼容客户端（Claude Code、Cline、LobeChat、curl…）都能驱动 Freebuff
的免费模型。

> 📖 完整中文文档见 [`docs/zh/`](docs/zh/README.md)，英文版见
> [`docs/en/`](docs/en/README.md)（中英内容语义一致）。文档包含上游协议
> 逆向分析、免费模式网关破解过程、端到端测试记录。调试与分析工具见
> [`tools/`](tools/README.md)。

零运行时依赖。TypeScript 编写，面向 [Bun](https://bun.sh)（也可在
Node 22+ 上用 `node --experimental-strip-types` 或先 `bun run build` 后运行）。

> 本项目基于对线上 Freebuff 后端协议的实际逆向实现（已对照官方
> [`CodebuffAI/freebuff`](https://github.com/CodebuffAI/freebuff) 客户端源码
> 验证）。这是第三方工具，与 Freebuff 无关联。免费通道随时可能被官方
> 收紧——请合理使用。

## 工作原理

Freebuff 的免费档按**会话（session）**发放。对每次 chat 请求，代理：

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

## 快速开始

```bash
bun install

# 方式 A（推荐）：设备码登录，凭证存 ~/.config/freebuff2api/credentials.json
bun run login

# 方式 B：直接提供 token
# export AUTH_TOKENS="<你的 freebuff.com token>"

bun run dev        # 或：bun run src/index.ts
```

```bash
curl http://localhost:8080/v1/models
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

把任何 OpenAI 兼容客户端指向 `http://localhost:8080/v1` 即可。

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

优先级：**环境变量** → `config.json`（工作目录自动检测）→ 登录凭证 →
默认值。

| 环境变量             | 默认值                       | 说明                                        |
| ------------------- | ---------------------------- | ------------------------------------------- |
| `AUTH_TOKENS`       | *(必需¹)*                    | 逗号分隔的 Freebuff auth token              |
| `UPSTREAM_BASE_URL` | `https://www.codebuff.com`   | Freebuff 后端地址                           |
| `LOGIN_BASE_URL`    | `https://freebuff.com`       | `freebuff2api login` 使用的 base URL        |
| `LISTEN_ADDR`       | `:8080`                      | 监听地址（托管环境以 `PORT` 优先）           |
| `REQUEST_TIMEOUT`   | `15m`                        | 上游请求超时（Go 风格时长）                 |
| `ROTATION_INTERVAL` | `6h`                         | run 轮换间隔                                |
| `API_KEYS`          | *(空 = 开放)*                | 客户端访问本代理需携带的 key                 |
| `HTTP_PROXY`        | *(空)*                       | 可选的上游 HTTP(S) 代理（Bun 原生支持）     |

参见 [`config.example.json`](config.example.json) 与
[`env.example`](env.example)。

¹ 除非已运行 `freebuff2api login`（此时使用保存的凭证），否则
`AUTH_TOKENS` 必需。

token 是 freebuff.com 账号令牌（与浏览器会话一致）。请保密——它代表你
账号的 API 使用权。

## 端点

| 方法 | 路径                     | 说明                                       |
| ---- | ------------------------ | ------------------------------------------ |
| GET  | `/healthz`               | 存活检查 + 模型注册表 + 令牌状态           |
| GET  | `/v1/models`             | 免费模式当前可用的模型                     |
| POST | `/v1/chat/completions`   | OpenAI chat completions（支持流式）        |

模型列表与官方客户端保持同步：每 6 小时抓取 `CodebuffAI/freebuff` 的
`free-agents.ts`；抓取失败时使用内置兜底映射，保证代理可用。

## 开发

```bash
bun run typecheck   # tsc -b --noEmit
bun run build       # 打包到 dist/index.js（node 目标；bin: freebuff2api）
bun run start       # 运行打包产物
bun run login       # 设备码登录（见上文）
bun run check       # typecheck + build
```

## 文档

- [`docs/`](docs/README.md) — 完整文档（中英双语，按目录区分）：
  协议逆向、免费档 CLI 网关破解、端到端测试记录
- [`docs/zh/`](docs/zh/README.md) — 中文文档
- [`docs/en/`](docs/en/README.md) — English documentation
- [`tools/`](tools/README.md) — 调试脚本（TLS MITM 代理、网关探索、重放、
  生产形状验证）与抓包产物
- [`docs/zh/04-请求格式破解.md`](docs/zh/04-请求格式破解.md) — **核心发现**：
  免费档网关机制与正确请求格式

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。报告 bug / 请求功能请走
[GitHub Issues](https://github.com/chenjh16/freebuff2api/issues)。

## 许可证

[MIT](LICENSE) © 2026 chenjh16

## 路线图 / 未实现

- Claude 兼容的 `/v1/messages` + `/v1/messages/count_tokens` 端点
- 面向发出复杂 JSON Schema 的 chat 客户端的工具 schema 归一化
- 按 key 的限流 / 用量统计

---

# English

OpenAI-compatible reverse proxy for the **Freebuff** coding API
([freebuff.com](https://freebuff.com), the free AI coding agent). It exposes
a standard OpenAI `/v1` surface and relays requests to the Freebuff backend
using a free account's auth token — so any OpenAI-compatible client (Claude
Code, Cline, LobeChat, curl, …) can drive Freebuff's free models.

> 📖 Full documentation: [`docs/`](docs/README.md) (bilingual by directory,
> semantically identical). Chinese: [`docs/zh/`](docs/zh/README.md) —
> English: [`docs/en/`](docs/en/README.md). Debugging & analysis tools in
> [`tools/`](tools/README.md).

Zero runtime dependencies. Written in TypeScript for [Bun](https://bun.sh)
(also runs on Node 22+ with `node --experimental-strip-types` or after
`bun run build`).

> This project was implemented against the live Freebuff backend protocol
> (verified against the official
> [`CodebuffAI/freebuff`](https://github.com/CodebuffAI/freebuff) client
> source). It is a third-party tool, not affiliated with Freebuff. Free
> access can be gated by the service at any time — use responsibly.

## How it works

Freebuff's free tier is session-gated. For every chat request the proxy:

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

## Quick start

```bash
bun install

# Option A (recommended): sign in with a device-code login flow.
# Prints a URL to open in your browser; credentials are stored at
# ~/.config/freebuff2api/credentials.json.
bun run login

# Option B: provide a token directly
# export AUTH_TOKENS="<your freebuff.com token>"

bun run dev        # or: bun run src/index.ts
```

```bash
curl http://localhost:8080/v1/models
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

Point any OpenAI-compatible client at `http://localhost:8080/v1`.

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

Priority: **environment variables** → `config.json` (auto-detected in the
working directory) → saved `login` credentials → defaults.

| Env var             | Default                   | Description                                             |
| ------------------- | ------------------------- | ------------------------------------------------------- |
| `AUTH_TOKENS`       | *(required*¹*)*           | Comma-separated Freebuff auth tokens                    |
| `UPSTREAM_BASE_URL` | `https://www.codebuff.com`| Freebuff backend base URL                              |
| `LOGIN_BASE_URL`    | `https://freebuff.com`    | Base URL used by `freebuff2api login`                   |
| `LISTEN_ADDR`       | `:8080`                   | Listen address (`PORT` env wins in managed workspaces) |
| `REQUEST_TIMEOUT`   | `15m`                     | Upstream request timeout (Go-style durations)          |
| `ROTATION_INTERVAL` | `6h`                      | How long an agent run lives before rotation            |
| `API_KEYS`          | *(empty = open)*          | Comma-separated keys clients must present to the proxy |
| `HTTP_PROXY`        | *(empty)*                 | Optional upstream HTTP(S) proxy (Bun honors natively)  |

See [`config.example.json`](config.example.json) and [`env.example`](env.example).

¹`AUTH_TOKENS` is required unless you have run `freebuff2api login`, in which
case the saved credentials are used.

The token is a freebuff.com account token (the same one your browser session
uses). Keep it secret — it grants API usage on your account.

## Endpoints

| Method | Path                     | Description                                  |
| ------ | ------------------------ | -------------------------------------------- |
| GET    | `/healthz`               | Liveness, model registry + token state       |
| GET    | `/v1/models`             | Models currently available in free mode      |
| POST   | `/v1/chat/completions`   | OpenAI chat completions (streaming supported)|

Models are kept in sync with the official client by fetching
`CodebuffAI/freebuff`'s `free-agents.ts` every 6 hours; a curated fallback
keeps the proxy working if the fetch fails.

## Development

```bash
bun run typecheck   # tsc -b --noEmit
bun run build       # bundles to dist/index.js (node target; bin: freebuff2api)
bun run start       # run the built bundle
bun run login       # device-code login (see above)
bun run check       # typecheck + build
```

## Documentation

- [`docs/`](docs/README.md) — full documentation (bilingual by directory,
  semantically identical): protocol reverse-engineering, the free-tier CLI
  gate crack, e2e test records
- [`docs/zh/`](docs/zh/README.md) — Chinese documentation
- [`docs/en/`](docs/en/README.md) — English documentation
- [`tools/`](tools/README.md) — debugging scripts (TLS MITM proxy, gate
  discovery, replay, production-shape verification) and captured artifacts
- [`docs/zh/04-请求格式破解.md`](docs/zh/04-请求格式破解.md) — **the core
  finding**: how the free-tier gate works and the exact request format

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report bugs / request features via
[GitHub Issues](https://github.com/chenjh16/freebuff2api/issues).

## License

[MIT](LICENSE) © 2026 chenjh16

## Roadmap / not yet implemented

- Claude-compatible `/v1/messages` + `/v1/messages/count_tokens` endpoints
- Tool-schema normalization for chat clients that emit complex JSON Schema
- Per-key rate limiting / usage stats
