# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- **`/v1/models` 只暴露带供应商前缀的模型 ID，移除所有不带前缀的裸别名**：
  所有模型现在只有一种拼写——`freebuff/<model>`（如
  `freebuff/deepseek/deepseek-v4-flash`）、`opencode/<model>`（如
  `opencode/big-pickle`）、`pollinations/<model>`（如 `pollinations/openai`、
  `pollinations/flux`）、`felo/<model>`（如 `felo/felo-chat`）。裸（无前缀）ID
  既不会被 `GET /v1/models` 列出，也不再可路由（返回 `model_not_found`），因此
  模型 ID 总是标明其供应商；`/v1/models` 的 `owned_by` 按供应商返回
  （`freebuff2api` / `opencode` / `pollinations` / `felo`）。Freebuff 注册表模型
  仅在收到 `freebuff/<model>` 时路由，内部再去掉 `freebuff/` 命名空间后以规范
  注册表 ID 调用上游。已同步更新全部文档、单元测试与端到端测试。

### Fixed

- **公共上游流式响应兼容严格客户端（Cherry Studio 报
  `AI_FinishReasonError: Response ended with finish reason "other"`）**：
  OpenCode Zen 免费层在输出完 `reasoning_content` 后可能直接结束、不发送任何
  finish chunk，或发出 `"other"` 等非标准 finish reason，Felo 适配器也从不
  发送 finish chunk；原样透传会让基于 Vercel AI SDK 的客户端（如 Cherry
  Studio）在思考完成后中止并报错、且看不到（可能为空的）回复。现在公共
  chat 流在转发前统一规范化（`sanitizeOpenAIStream`）：保证终结
  `finish_reason: "stop"`（缺失或非标准时重写/补发）、丢弃畸形行与无
  choices/usage 的垃圾尾随 chunk、始终以唯一 `data: [DONE]` 收尾；Felo SSE
  同样补发终结 stop chunk。新增 8 个单元测试覆盖截断流、非标准 finish、垃圾
  chunk、usage 保留等场景，并经真实上游端到端验证。
- 统一 hosted/standalone 配置文档：明确 hosted Web 登录无需 `AUTH_TOKENS`，并修正 `config.example.json`、CLI 构建命令和 CLI 标记注入模块引用。
- 只读的 `/healthz` 与 `/v1/models` 路由现在在共享 handler 中严格拒绝非 GET 方法，并补充回归测试。
- **网页登录 API Key 跨进程/重启失效（`invalid proxy api key` 401）**：
  `sk-fb-*` key 的 AES 密钥原本在 `PROXY_SECRET`/`AUTH_TOKENS` 均未设置时
  退化为每进程随机（`ephemeral:${pid}:${Date.now()}`），导致在服务器实例
  轮换、预览与生产之间、或进程重启后 key 无法解密。现在密钥派生优先级为
  `PROXY_SECRET` 环境变量 → `AUTH_TOKENS` 哈希 → 本地持久化文件
  （`.data/proxy-secret`，首次生成后复用，无环境变量时 key 也能跨进程重启
  保持有效）→ 进程随机（最后兜底）
- 修复托管构建失败（`Next.js output directory .next was not found`）：
  `build` 脚本改为标准的 `next build`（托管框架默认构建命令），CLI 打包
  移至 `build:cli`（并加 `prepublishOnly`，npm 发布仍自动产出
  `dist/index.js`）
- 预览命令文档修正：`bun run dev - - -p 3000 -H 0.0.0.0` 中的裸 `-` 会被
  `next dev` 当作项目目录并报错，正确写法为 `bun run dev -- -H 0.0.0.0`

### Changed

- 主页头部 UI 对齐 freebuff.com：左上角改为官方 logo
  （`public/logo-icon.png`）+ 衬线 `freebuff` 字标（链接到 freebuff.com）；
  右上角端点徽标自适应当前部署域名（`window.location.host`）；新增 GitHub
  仓库链接按钮（octocat + Star 计数，风格与 freebuff.com 头部一致，链接到
  github.com/chenjh16/freebuff2api）；引导页/加载页同步更新
- 文档域名更新为线上真实域名 `open.freebuff.app`（README 中英文、docs 08
  托管部署指南），并补充 `PROXY_SECRET` 部署环境变量说明
- README 结构调整为**作用与使用方法优先**：中英文两版均把「项目作用 /
  What it is」与「快速开始 / Quick start」（托管 Web 控制台 + 本地 CLI 两种
  方式）提到最前面，工作原理、登录、配置、端点、托管部署等深入内容随后；
  docs 三个索引 README 同步补充“上手优先”指引

### Added

- **网页登录 + 每用户 API Key**：主页改为 freebuff.com 风格登录页，设备码
  登录（`/api/auth/start|status|register|revoke`）成功后自动签发 `sk-fb-*`
  key（AES-256-GCM 加密账号 token，`PROXY_SECRET` 派生密钥，无状态、可跨
  重启）；登录后进入 API Key 管理页（BaseURL + Windows/UNIX curl 一键复制
  + Toast）、模型测试（流式 + Thinking 输出）与退出登录（弹窗确认并吊销
  key）。`TokenManager.acquireUserSession` 支持按请求使用用户自己的上游
  token；托管模式下 `AUTH_TOKENS` 变为可选；`PROXY_SECRET` 固定值可让 key
  跨重新部署保持有效
- **托管部署（Next.js App Router）**：新增 `app/` 路由处理器
  （`/healthz`、`/v1/models`、`/v1/chat/completions`）与在线控制台首页，
  通过 `src/handler.ts` 与 CLI 服务器共享完全相同的请求处理路径；
  `bun run build:web`（`next build`）直接产出可部署产物
- 托管代理鉴权改为 fail closed：`API_KEYS` 未配置时拒绝 `/v1` 请求，不再
  发布或使用可预测的共享默认 key；公开前必须配置高熵客户端 key
- `/v1/*` 开放 CORS（预检 204），浏览器客户端可直接调用
- `AUTH_TOKENS` 未配置时 `/healthz` 保持 `200 {ok:false, configured:false}`
  以维持托管健康检查，其余端点返回明确的 503 配置错误；健康响应不再暴露
  token/session/model 详情
- `/healthz` 恒为公开端点（不受代理 key 鉴权），托管健康检查与状态探测
  始终可用；只有 `/v1/*` 才要求 `Authorization`/`x-api-key`
- 单元测试 `tests/unit/web-proxy.test.ts`：默认 key 解析、CORS 预检、
  未配置 handler 行为；`tests/unit/account.test.ts`（sk-fb-* key 加解密/
  吊销）与 server 用户 key 流程测试
- **站点访问门禁（`SITE_ACCESS_TOKEN`）**：托管 Web 控制台可选的前门鉴权。
- 修复网页登录凭证暴露：原始 `authToken` 仅保存在服务端短期登录事务中，浏览器只接收派生的 `sk-fb-*` key。
  在部署环境设置 `SITE_ACCESS_TOKEN`（逗号分隔，支持多个）后，访问站点
  会先显示锁屏，访客须输入有效 token（或直接用 `https://…/?token=…`
  打开站点）才能解锁；验证通过后浏览器将 token 保存在 `localStorage`，
  每次访问重新校验（刷新不再要求输入）。校验由 `POST /api/gate/verify`
  完成（SHA-256 恒定时间比较，防时序侧信道）。未设置时控制台保持开放。
  门禁只影响网页控制台，`/v1` 接口仍由 `API_KEYS` 保护。新增
  `app/lib/gate.ts`、`app/api/gate/verify/route.ts` 与单元测试
  `tests/unit/gate.test.ts`
- 文档：docs 08 托管部署指南（中英）、README 托管部署章节；
  `dev` 脚本改为 Next.js 应用（`dev:cli` 运行独立代理）

## [0.1.1] - 2026-08-07

### Fixed

- session 准入错误不再被屏蔽为笼统 503：上游返回的 `429` / `401` / `500` /
  `503` 连同真实状态码、`Retry-After` 与消息一起透传（与官方 CLI 对
  429/503 退避重试的语义一致）
- `409 model_locked` 错误消息携带锁定模型名（上游 `currentModel` /
  `requestedModel`），便于区分"会话被另一个模型占用"与真正的模型不可用

### Added

- `tools/probe-session.mjs`：逐模型会话准入探针（`--admit-only` 不耗 chat 额度）
- `tools/cli-probe.mjs`：`script` PTY 驱动官方 CLI 的最小对话探针
  （可选 MITM 抓包），解决无 TTY 执行器无法驱动 CLI TUI 的问题
- `tools/model-availability.mjs`：读取 `/v1/models` 后逐模型最小 chat 探测
  （并发受限，含 `--json` 输出；配套 opt-in 测试
  `LIVE_MODEL_TEST=1 bun test tests/e2e/model-availability.test.ts`）
- 回归测试：session 503/429 透传、model_locked 锁定模型名、409 字段解析
  （`tests/unit/{upstream,session,server}.test.ts`）
- 文档：docs/06 阶段 9（双模型经代理与官方 CLI 的全链路复测记录，含 MITM
  抓包对比）、docs/03 会话准入失败语义、tools/README、MITM 抓包实录
- 文档：README.md 结构调整为英文在前、中文在后；docs 04 端口示例统一为
  `:23333`；docs 06 复现清单与 docs 索引 README 补全新工具与测试状态

## [0.1.0] - 2026-08-06

### Added（首次发布）

- OpenAI 兼容 `/v1` 代理：`/healthz`、`/v1/models`、`/v1/chat/completions`
  （支持流式与非流式）
- 设备码登录：`freebuff2api login`（含 `--resume` / `--force`），
  凭证存 `~/.config/freebuff2api/credentials.json`
- 免费会话管理：等待室轮询、令牌轮换、401 令牌冷却 30 分钟
- Agent 运行管理：run 复用、定时轮换、优雅关闭时 FINISH
- 模型注册表：从 CodebuffAI/freebuff 同步 Agent→模型映射（6h 刷新），
  内置兜底映射
- **免费模式 CLI 网关破解**：自动注入 system 标记
  （`You are Buffy, the strategic coding assistant`），解决
  `403 free_mode_cli_required`
- 中英双语文档（`docs/zh/` 与 `docs/en/`）与调试工具集（`tools/`，含 TLS MITM 抓包工具）

### Fixed

- 上游 chat 请求 403 `free_mode_cli_required`：system 消息必须携带
  官方 CLI 身份短语
- `agent-runs` START body 对齐官方 CLI（`ancestorRunIds: []`）

[0.1.0]: https://github.com/chenjh16/freebuff2api/releases/tag/v0.1.0
[0.1.1]: https://github.com/chenjh16/freebuff2api/releases/tag/v0.1.1
