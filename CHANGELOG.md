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
- **配置路径与默认模型对齐**：`config.json` 自动发现新增
  `~/.config/freebuff2api/config.json`（与 `freebuff2api login` 的凭证目录一致），
  并保留旧位置 `~/.freebuff2api/` 兜底；`env.example` 与 `config.example.json` 的
  公共模型白名单示例统一为 `provider/model` 前缀 ID，移除“裸别名可达”的过期表述；
  托管页面默认模型改为公共渠道 `opencode/deepseek-v4-flash-free`（免登录即可体验）。
- **排队超载与关闭区分**：server 等待队列打满时返回 `503 request_queue_full`
  （此前误报 `server_closing`）；未配置上游 token 时 `TokenManager` 明确报
  “未配置 token”而不是“全部冷却”。
- **清理**：移除死代码（`resolveApiKeys`、`QUEUED_STATUSES` 不可达分支、
  `parseArgs` 的 help 空分支）；`BodyTooLargeError` 收敛为 `src/handler.ts` 单一
  定义；`/api/auth/register` 复用 `clearLoginCookie()`；`injectUpstreamMetadata`
  不再原地改写客户端 messages 数组。
- **模型目录变更告警**：`ModelRegistry` 远程刷新后若模型集合发生变化，日志输出
  增减明细，便于发现上游常量解析的静默漂移。
- **会话重建循环加限**：`SessionPool.refresh()` 对上游持续返回
  `ended/none/superseded` 的重建次数加限（最多 3 次），避免后端异常时无限
  POST 往返（此前只能靠请求超时中断）；新增单元测试。

### Fixed

- **`GET /api/auth/status` 补充 `maxDuration`**：每次轮询最长约 9s，显式设置
  路由超时上限（chat/images 路由已设置），避免部分托管平台默认限制截断轮询。
- **试玩面板清理**：登录成功后移除对过期闭包 `refreshModels()` 的无效果调用
  （模型列表改由 `session` 变化 effect 刷新）；`DEFAULT_MODEL` 注释改为准确
  的“公共渠道模型、无需上游 token”；登录事务轮询保留原始 `createdAt`。
- **文档与示例对齐**：docs/en/01 的 `handler.ts` 模块表补
  `/v1/images/generations`（与 zh 版一致）；docs 07（en/zh）图片参数列表补
  `image` 参考图 / img2img（POST）；根 README 试玩面板描述补图片生成与图片
  上传；`env.example` 补 `PROXY_SECRET_FILE` 说明；合并 CHANGELOG Unreleased
  中重复的 `### Changed` 标题。
- **CLI 标记注入不再清空多模态 system 消息**：当客户端 system 消息的
  `content` 是数组（多模态 parts）时，标记注入此前会把整个 content 替换成
  标记文本、丢失客户端指令；现在改为在数组头部追加一个 `text` part，原有
  parts 完整保留（检测逻辑同样覆盖数组内的文本 part）。新增单元测试。
- **API Key 铸造缓存加限**：`account.ts` 的 `token→key` 缓存超过 10000 条后
  剪除最旧条目（key 为无状态 AES 密文，剪除只影响“同 token 重新注册返回同
  key”的去重，已签发 key 始终可解密），防止托管长运行进程内存无界增长；
  移除页面中未使用的 `accountName` 局部变量。新增单元测试。
- **文档补充**：docs/en/07 快速开始补图片生成 curl 示例（与 zh 版一致）；
  docs 08（en/zh）流式说明明确 chat 与图片生成路由均为 300s 长连接上限。
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
- **公共上游 URL 校验仅在启用时执行**：`PUBLIC_UPSTREAM_ENABLED=false` 时不再
  校验（也不再因残留的非 opencode.ai 地址）阻塞启动
- **托管冷启动不阻塞**：Web 部署的 `ModelRegistry` 先加载兜底目录、远程目录在
  后台刷新（首请求不再等待上游抓取）；server 对已写 413 响应的
  `ResponseSentError` 静默返回，不再刷误导性错误日志
- **文档与实现对齐**：修正 docs 02/06 的凭证表述（token 走
  `Authorization: Bearer`，`x-freebuff-acting-user-id` 携带用户 id）、
  zh README 的 E2E 门控表述、docs 08 的 `API_KEYS` fail-closed 范围与登录事务
  进程本地性说明；docs 07 补 `PROXY_SECRET`/`PROXY_SECRET_FILE` 环境变量行；
  docs 05 标注 fable 仅远程可用；移除 `session.refresh()` 空 try/catch；
  `DEFAULT_MAX_BODY_BYTES` 收敛到 `config.ts` 单一来源并抽取共享
  `readJsonBody` 助手；新增 3 个单元测试（URL 校验门控 ×2、兜底先行 ×1）
- **Web 模型试玩面板完整支持图片**：`/v1/models` 新增 `type` 能力字段（图片
  模型为 `image`，其余为 `chat`）；试玩面板按能力分组展示模型，选中图片模型
  时自动走 `/v1/images/generations` 并在面板内渲染生成的图片（可下载）。输入
  框新增图片上传按钮（客户端压缩至 ≤1024px、最多 4 张）：chat 模型以 OpenAI
  `image_url` content 数组做多模态输入；图片模型可附参考图做 img2img / 编辑
  （`PollinationsImageClient` 支持 `image` 字段，有参考图时改用 POST 携带，
  已对线上上游实测验证）。新增 2 个单元测试（img2img POST、多图/超限拒绝）

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
