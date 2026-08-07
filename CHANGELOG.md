# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

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
- 托管默认代理 key：`API_KEYS` 未配置时默认 `sk-freebuff2api-2026`
  （环境变量可覆盖），公开端点不会裸奔
- `/v1/*` 开放 CORS（预检 204），浏览器客户端可直接调用
- `AUTH_TOKENS` 未配置时 `/healthz` 保持 `200 {ok:false, configured:false}`
  以维持托管健康检查，其余端点返回明确的 503 配置错误
- `/healthz` 恒为公开端点（不受代理 key 鉴权），托管健康检查与状态探测
  始终可用；只有 `/v1/*` 才要求 `Authorization`/`x-api-key`
- 单元测试 `tests/unit/web-proxy.test.ts`：默认 key 解析、CORS 预检、
  未配置 handler 行为；`tests/unit/account.test.ts`（sk-fb-* key 加解密/
  吊销）与 server 用户 key 流程测试
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
