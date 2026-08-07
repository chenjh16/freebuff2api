# MITM 抓包实录（脱敏）

> 本文是 2026-08-06 用 `tools/mitm-ssl-proxy.mjs`（TLS 中间人代理）抓取
> 官方 freebuff CLI（v0.0.141，Bun 1.3.14 运行时）发往
> `www.codebuff.com` 的关键请求实录。token 与用户 id 已脱敏
> （`796...<redacted>` / `280d0ec6-b...<redacted>`）。
>
> 原始日志保存在本机 `/tmp/mitmssl.log`（约 31KB，含 SSE 流式响应片段），
> 下文摘录对协议逆向最有价值的请求。

## 请求时序（一次完整对话）

官方 CLI 启动 → 对话 → 得到回复的完整请求序列：

```
1. POST /api/v1/ads                    广告位（Freebuff-CLI/0.0.141 UA）
2. GET  /api/v1/freebuff/session       查询当前会话状态
3. GET  /api/v1/me?fields=id,email     获取用户 id
4. POST /api/v1/freebuff/session       创建免费会话（空 body + x-freebuff-model）
5. POST /api/v1/ads                    对话前再取一次广告
6. POST /api/agents/validate           上报全部 Agent 定义（460KB）
7. POST /api/v1/agent-runs             启动 Agent 运行（START）
8. POST /api/v1/chat/completions       发送对话（成功，SSE 流式回复）
```

## 关键请求详情

### ① 创建会话（POST /api/v1/freebuff/session）

```
POST /api/v1/freebuff/session HTTP/1.1
authorization: Bearer 796...<redacted>
x-freebuff-model: deepseek/deepseek-v4-flash
user-agent: Bun/1.3.14
accept: */*
content-length: 0        ← 空 body（无 Content-Type）
```

> 对比：freebuff2api 用 `body: "{}"` + `Accept: application/json` 也可以
> （实测均可，上游不挑剔）。

### ② 启动运行（POST /api/v1/agent-runs）

```
POST /api/v1/agent-runs HTTP/1.1
authorization: Bearer 796...<redacted>
x-freebuff-acting-user-id: 280d0ec6-b...<redacted>
user-agent: Bun/1.3.14
accept: */*

{"action":"START","agentId":"base2-free-deepseek-flash","ancestorRunIds":[]}
```

### ③ 对话（POST /api/v1/chat/completions）— 核心

```
POST /api/v1/chat/completions HTTP/1.1
authorization: Bearer 796...<redacted>
content-type: application/json
user-agent: ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser
x-freebuff-acting-user-id: 280d0ec6-b...<redacted>
accept: */*
content-length: 69338

{
  "model": "deepseek/deepseek-v4-flash",
  "stop": ["\"cb_easp\""],
  "codebuff_metadata": {
    "freebuff_instance_id": "557b364e-…",
    "trace_session_id": "710c263d-…",
    "llm_step_number": "1",
    "run_id": "ee5ffc72-…",
    "client_id": "ojqb6gjb129",
    "cost_mode": "free"
  },
  "provider": { "data_collection": "deny" },
  "messages": [
    { "role": "system", "content": "You are Buffy, the strategic coding assistant. …",
      "cache_control": { "type": "ephemeral" } },
    { "role": "user", "content": [{ "type": "text", "text": "<user_message>…</user_message>" }] },
    { "role": "user", "content": [{ "type": "text", "text": "…（用户完整上下文）" }] }
  ],
  "tools": [ /* 24 个工具定义 */ ],
  "tool_choice": "auto",
  "stream": true
}
```

响应（HTTP 200，SSE）：

```
Content-Type: text/event-stream
Transfer-Encoding: chunked

: connected 2026-08-06T16:38:12.785Z
data: {"id":"16389efa-…","object":"chat.completion.chunk","model":"deepseek/deepseek-v4-flash",
       "choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":""},…}],
       "provider":"DeepSeek"}
data: …
```

## 这份实录的结论

1. **system 消息**是免费模式网关的关键（见 `docs/04-请求格式破解.md`）：
   必须包含 `You are Buffy, the strategic coding assistant`
2. `agent-runs` START body 固定为 `{action, agentId, ancestorRunIds: []}`
3. chat 请求的 User-Agent 与 session/run 的 User-Agent **不同**：
   chat 用 `ai-sdk/openai-compatible/…/codebuff …`，其余用 `Bun/1.3.14`
4. `codebuff_metadata` 必须携带 `run_id` / `freebuff_instance_id` /
   `cost_mode: "free"` 等字段

## 完整产物引用

| 文件 | 内容 |
| ---- | ---- |
| `chatbody-official.json` | ③ 请求的完整 body（64KB） |
| `agentdefs-full.json` | ⑥ /api/agents/validate 的完整 payload（460KB） |
| `agentdefs.json` | Agent 定义精简版 |

## 2026-08-07 补充：双模型复测抓包（v0.0.142）

用 `tools/cli-probe.mjs`（`script` PTY，无需 tmux）驱动官方 CLI，经
`mitm-ssl-proxy.mjs` 抓取，模型通过 `~/.config/manicode/settings.json` 的
`freebuffModel` 切换（首次启动的模型选择器上直接按 Enter）。两个模型均
完成一次最小对话，全部响应 200。原始日志在本机
`/tmp/cli-probe-ds.mitm.log` / `/tmp/cli-probe-luna3.mitm.log`（约 60KB），
本文仅摘录对比要点（token/用户 id/正文已脱敏）。

### deepseek/deepseek-v4-flash

```
POST /api/v1/freebuff/session
  authorization: Bearer 796...<redacted>
  x-freebuff-model: deepseek/deepseek-v4-flash
  user-agent: Bun/1.3.14
  accept: */*
  content-length: 0
→ 200
POST /api/v1/agent-runs   {action:START, agentId:base2-free-deepseek-flash, ancestorRunIds:[]} → 200
POST /api/v1/chat/completions  (99,383B：完整 system 提示 + 24 tools + stop + tool_choice) → 200
  回复：MODEL_PROBE_OK
```

### openai/gpt-5.6-luna

```
POST /api/v1/freebuff/session
  x-freebuff-model: openai/gpt-5.6-luna
  （其余同 deepseek，无 acting-user-id）
→ 200（TUI 徽章：GPT-5.6 Luna · 59m left）
POST /api/v1/agent-runs   {action:START, agentId:base2-free-luna, ancestorRunIds:[]} → 200
POST /api/v1/chat/completions  (101,668B) → 200
  回复：MODEL_PROBE_OK（约 10s）
```

### 与代理请求形状的差异（结论，详见 docs/06 阶段 9）

- session POST：官方 CLI 不带 `x-freebuff-acting-user-id`；freebuff2api 会带，
  上游均接受。
- chat：官方 CLI 发送完整 system 提示 + 24 个 tools；freebuff2api 只注入
  `Buffy` 标记短语 + 最小载荷，网关均放行（检查点只是 system 短语）。
- 模型锁定：另一模型会话活跃时 POST 返回 `409 model_locked`（含
  `currentModel`/`requestedModel`）；官方 CLI 会先 DELETE 再重试，freebuff2api
  上抛 409 + 锁定模型名。
