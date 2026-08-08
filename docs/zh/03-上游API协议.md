# 03 上游 API 协议

> 本文记录 Freebuff 上游后端（`https://www.codebuff.com`）的完整协议，
> 均经官方 CLI 抓包 + 真实请求验证。实现见 `src/upstream.ts`。

## 通用约定

- Base URL：`https://www.codebuff.com`（可用 `UPSTREAM_BASE_URL` 覆盖）
- 认证：`Authorization: Bearer <token>`（即登录拿到的 `authToken`）
- 用户身份：非 SDK 请求携带 `x-freebuff-acting-user-id: <用户id>`
- **User-Agent 分流**（免费档网关据此区分"CLI 创建"的会话与直接调用）：
  - 会话 / Agent 运行 / 其他非 SDK 请求：`Bun/1.3.14`
    （官方 CLI 是 Bun 运行时）
  - chat 请求：`ai-sdk/openai-compatible/<ver>/codebuff ai-sdk/provider-utils/<ver> runtime/browser`
- 调试：`DEBUG_UPSTREAM=1` 时打印每个上游请求的头与 body（token 脱敏）

## 固定公共/免认证上游

代理同时提供认证 Freebuff 链路与默认开启的三个固定公共链路：OpenCode Zen、免
key 的 Pollinations，以及 Felo 逆向网页协议。模型 ID 一律使用 `provider/model`
前缀规范形式（`freebuff/`、`opencode/`、`pollinations/`、`felo/`），不带前缀
的裸 ID 不会被列出也不可路由，因此模型 ID 总是标明其供应商。请求匹配到多个
公共 provider 时，按 `PUBLIC_UPSTREAM_PROVIDERS` 的优先级顺序尝试与回退
（公共优先，最后才回退 Freebuff）。`PUBLIC_UPSTREAM_BASE_URL` 只允许覆盖 HTTPS 的 `opencode.ai`；
Pollinations（`https://gen.pollinations.ai/v1`）与 Felo（`https://felo.ai`）
地址固定。`PUBLIC_UPSTREAM_PROVIDERS`、`PUBLIC_UPSTREAM_MODELS` 与
`PUBLIC_UPSTREAM_IMAGE_MODELS` 可缩小白名单，`PUBLIC_UPSTREAM_ENABLED=false`
可关闭全部公共链路。完整模型目录与路由规则见 [09-模型目录](09-模型目录.md)。

除 chat 外，代理还通过 Pollinations 的免认证图片端点
`https://image.pollinations.ai/prompt/<prompt>` 提供
`/v1/images/generations`（OpenAI 兼容的 images 响应）。匿名图片结果始终带
Pollinations 水印：移除水印的 `nologo` 参数需要账号 token，代理不会发送。

每个适配器自行构造 headers，只发送转换后的请求 body，不会发送下游
`Authorization`、`x-api-key`、Cookie 或 Freebuff 账号 token。超时以及瞬态
`401/408/425/429/5xx` 会先尝试其他匹配的公共 provider，再回退 Freebuff 认证链路；
普通 `4xx` 直接返回。Pollinations 的匿名 chat 层对部分提示词形态会返回 401
（匿名抽签路由，与请求内容相关），白名单只保留实测可匿名调用的模型。Felo
没有官方 API，面向网页的协议可能随时变化。由于提示词和代码会发送给选中的
公共提供商，部署前请确认各服务条款与隐私要求。

## 端点一览

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/healthz` | 存活检查 |
| GET | `/api/v1/me?fields=id,email` | 当前用户信息 |
| POST | `/api/v1/ads` | 广告位（官方 CLI 调用，非必需） |
| POST | `/api/agents/validate` | 上报完整 Agent 定义（官方 CLI 发送 460KB payload） |
| POST | `/api/v1/freebuff/session` | 创建/刷新免费会话 |
| GET | `/api/v1/freebuff/session` | 轮询（等待室）或压缩会话 |
| DELETE | `/api/v1/freebuff/session` | 结束会话 |
| POST | `/api/v1/agent-runs` | 启动 / 结束 Agent 运行 |
| POST | `/api/v1/chat/completions` | OpenAI 兼容 chat（流式/非流式） |
| POST | `/api/logs` | 客户端日志上报（官方 CLI 调用，非必需） |

## 1. 免费会话（session）

### 创建 / 刷新

```
POST /api/v1/freebuff/session
Authorization: Bearer <token>
User-Agent: Bun/1.3.14
x-freebuff-model: deepseek/deepseek-v4-flash   # 可选，指定模型

# 官方 CLI 不发送请求体，也不依赖显式 Accept；代理应保持空 body
body: <empty>
```

成功（`status: active`）：

```json
{
  "status": "active",
  "accessTier": "full",
  "instanceId": "57e9bd9e-…",
  "model": "deepseek/deepseek-v4-flash",
  "admittedAt": "2026-08-06T17:35:38.571Z",
  "expiresAt": "2026-08-06T18:35:38.571Z",
  "remainingMs": 3011763,
  "rateLimit": { "model": "…", "limit": 6, "period": "pacific_day", … }
}
```

等待室（`status: queued`，带 `instanceId`、`position`、`queueDepth`、
`estimatedWaitMs`）：代理返回 `503 + Retry-After` 并在后台轮询。

其他状态：`disabled`（免费档不可用，404）、`none`/`ended`/`superseded`
（需重新创建）、`country_blocked`/`banned`（403）、`model_locked`/
`model_unavailable`（409）、429（限流）。

> 404 语义：官方 CLI 把 404 映射为 `{status: "none"}`（免费档不可用），
> freebuff2api 映射为 `{status: "disabled"}` —— 两者都会停止轮询。

模型被锁定（`409`，实测——一个账号同时只有一个固定模型的一小时 session）：

```json
{
  "status": "model_locked",
  "currentModel": "openai/gpt-5.6-luna",       // 当前 session 固定的模型
  "requestedModel": "deepseek/deepseek-v4-flash", // 本次请求的模型
  "accessTier": "full"
}
```

> 官方 CLI 对 `model_locked` 的处理（来自其打包源码）：用户切换模型时先
> `DELETE` 当前 session 再重新 `POST`（自动切换）；DELETE 失败则提示运行
> `/end-session`。它还对 session POST 的 `408/429/503` 做指数退避重试
> （基准 20s、上限 300s），其余 4xx 直接停止。freebuff2api 会上抛 `409
> model_locked`（带锁定模型名），并把其他准入失败（`429`/`500`/`503`/`401`）
> 连同真实状态码、`Retry-After` 与消息透传，不再屏蔽为笼统 503。

### 轮询等待室

```
GET /api/v1/freebuff/session
x-freebuff-instance-id: <instanceId>
x-freebuff-compact-session: 1
User-Agent: Bun/1.3.14
```

### 结束

```
DELETE /api/v1/freebuff/session
User-Agent: Bun/1.3.14
```

## 2. Agent 运行（agent-runs）

### 启动（START）

```
POST /api/v1/agent-runs
Authorization: Bearer <token>
x-freebuff-acting-user-id: <用户id>
User-Agent: Bun/1.3.14

{ "action": "START", "agentId": "base2-free-deepseek-flash", "ancestorRunIds": [] }
```

> `ancestorRunIds: []` 与官方 CLI 完全一致（实测必填格式）。
> `agentId` 必须与 session 的 model 匹配，否则可能报
> `free_mode_invalid_agent_hierarchy`。

响应：`{ "runId": "26a22543-…" }`

### 结束（FINISH）

```
POST /api/v1/agent-runs
{ "action": "FINISH", "runId": "…", "status": "completed",
  "totalSteps": 0, "directCredits": 0, "totalCredits": 0 }
```

响应：`{ "success": true }`（best-effort，失败不致命）

## 3. Chat Completions（核心）

```
POST /api/v1/chat/completions
Authorization: Bearer <token>
x-freebuff-acting-user-id: <用户id>
Content-Type: application/json
User-Agent: ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser
Accept: */*
```

请求体 = OpenAI 载荷 + 两个注入块：

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "You are Buffy, the strategic coding assistant. …" },
    { "role": "user", "content": "Reply with exactly: PONG" }
  ],
  "codebuff_metadata": {
    "run_id": "26a22543-…",
    "client_id": "d3jy2o9a54e",
    "cost_mode": "free",
    "trace_session_id": "3d370235-…",
    "llm_step_number": "1",
    "freebuff_instance_id": "57e9bd9e-…"
  },
  "provider": { "data_collection": "deny" }
}
```

**关键**：system 消息必须包含 `You are Buffy, the strategic coding assistant`
（免费档 CLI 网关），详见 [04-请求格式破解](04-请求格式破解.md)。

支持 `stream: true`（SSE，`chat.completion.chunk`）与非流式
（`chat.completion`，带 `usage`）。

响应特征：
- `Content-Type: text/event-stream`（流式）或 `application/json`
- `reasoning_content`：DeepSeek 系列返回思考过程
- `provider: "DeepSeek"` 等标识

公共上游流在转发前会做规范化：保证终结 `finish_reason: "stop"`（上游未发
或发出 `"other"` 等非标准 reason 时重写/补发），丢弃垃圾尾随 chunk，并始终
以唯一的 `data: [DONE]` 收尾——严格客户端（如 Cherry Studio 的 AI SDK）不会
再遇到 `finish reason "other"`（`AI_FinishReasonError`）。渠道清单、实测的
供应商行为与排查方法见 [10-公共上游渠道](10-公共上游渠道.md)。

## 4. 其他

- `/api/agents/validate`：官方 CLI 在每次启动时把全部 Agent 定义
  （含 systemPrompt、toolNames、spawnableAgents）POST 给上游做校验。
  freebuff2api 不需要调用它也能通过网关（已实测）。
- `/api/v1/ads`：等待室广告，`Freebuff-CLI/<ver>` UA，非必需。

## 状态码速查（chat 端点）

| 状态 | 含义 | 代理处理 |
| ---- | ---- | -------- |
| 200 | 成功（流式/非流式） | 透传 |
| 400 | 请求错误；含 `runId not found` 等 | 轮换 run 重试一次 |
| 401 | token 失效 | 冷却 30 分钟，换令牌 |
| 403 `free_mode_cli_required` | 缺少 CLI system 标记 | 注入标记后重试 |
| 403 `free_mode_invalid_agent_hierarchy` | run agent 与 model 不匹配 | 修正 agentId |
| 429 | 限流 | 按 Retry-After 返回 |
| 409 `model_unavailable` / `model_locked` | 当前模型无法入场或被锁定 | 保留 409 与错误 code，不伪装成 503 |
| 503 | 等待室 / 无健康令牌 | 带 Retry-After 返回 |

会话准入（`POST /api/v1/freebuff/session`）失败语义：`409
model_unavailable` / `model_locked` 对该模型是终态——保留 409 与 `error.code`
（绝不循环刷新成超时或笼统 503）；其余状态（`429`、`401`、`500`、`503`）
连同 `Retry-After` 与上游消息透传，便于客户端像官方 CLI 一样重试。
