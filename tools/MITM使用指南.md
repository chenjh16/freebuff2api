# MITM 工具使用指南

本指南介绍如何用 `tools/` 下的两个中间人代理抓取官方 freebuff CLI 的
真实请求，以及如何解读抓包结果。**这是本仓库逆向分析的核心工作流**
（成果见 [docs/zh/04-请求格式破解.md](../docs/zh/04-请求格式破解.md)，
英文版 [docs/en/04-request-format-gate.md](../docs/en/04-request-format-gate.md)）。

## 工具选型

| 工具 | 适用场景 | 局限 |
| ---- | -------- | ---- |
| `mitm-proxy.mjs` | 只能看到明文 HTTP 流量 | 官方 CLI 走 HTTPS，基本用不上 |
| `mitm-ssl-proxy.mjs` | **HTTPS 解密**（本仓库实际使用） | 需要 openssl + 让 CLI 信任本地 CA |

## 前提

- 已安装官方 CLI：`npm i -g freebuff`
- 已登录：`freebuff login`（或在代理下运行后手动登录）
- Node 18+、openssl

## 完整流程

### 第 1 步：启动 TLS MITM 代理

```bash
node tools/mitm-ssl-proxy.mjs
```

首次运行会自动生成本地 CA：

- 私钥：`/tmp/fb-ca.key`
- 证书：`/tmp/fb-ca.crt`

并监听 `127.0.0.1:18100`，等待 CONNECT 隧道。每个目标域名会用该 CA
签发临时证书（缓存在 `/tmp/fbcert-<host>.*`）。

### 第 2 步：让 CLI 走代理并信任 CA

```bash
# 另开一个终端
export HTTPS_PROXY=http://127.0.0.1:18100
export SSL_CERT_FILE=/tmp/fb-ca.crt     # 关键：否则 CLI 拒绝中间人证书
freebuff
```

- CLI 的 npm 安装/更新流量（registry.npmjs.org）也会经过代理，
  代理同样为它签证书，不影响。
- 首次在代理下运行可能需要重新登录一次（会话已在别处被占用时）。

### 第 3 步：触发一次真实对话

在 CLI 里正常发起一条消息（例如 `Reply with exactly: hello`），等待回复。

### 第 4 步：观察抓包输出

代理终端会打印每个请求：

```
===== OFFICIAL REQUEST =====
POST /api/v1/chat/completions HTTP/1.1
{ "authorization": "Bearer 796...<redacted>", … }
BODY(69338): {"model":"deepseek/deepseek-v4-flash",…}
-----
===== RESPONSE =====
HTTP/1.1 200 OK
Content-Type: text/event-stream
…
RESP BODY: : connected … data: {"id":"…","object":"chat.completion.chunk",…}
===== END RESPONSE =====
```

- token（`authorization`）、`cookie`、`x-freebuff-acting-user-id` 自动脱敏
- 大于 6000 字符的 body 会被截断（`...[truncated]`）

### 第 5 步：保存产物（可选）

```bash
# 保存 chat 请求完整 body（用于 tools/replay-captured.mjs 重放）
# 把终端里打印的 BODY(69338): 之后的 JSON 存为
# tools/captured/chatbody-official.json

# 保存 /api/agents/validate 的完整 payload
# tools/captured/agentdefs-full.json
```

> 抓包日志可重定向保存：`node tools/mitm-ssl-proxy.mjs > /tmp/mitmssl.log 2>&1`

## 解读要点

1. **请求序列**：ads → session GET → me → session POST → ads →
   agents/validate → agent-runs → chat/completions
2. **UA 分流**：chat 请求用 `ai-sdk/openai-compatible/…/codebuff …`，
   其他请求用 `Bun/1.3.14` —— 免费档网关据此区分 CLI 会话
3. **system 消息**：官方 CLI 的 system 提示开头是
   `You are Buffy, the strategic coding assistant` —— 这就是网关检查的短语
4. **agent-runs body**：`{action:"START",agentId:"…",ancestorRunIds:[]}`

完整实录见 [captured/mitm-抓包实录.md](captured/mitm-抓包实录.md)。

## 安全与合规

- 只用于分析**自己账号**的流量
- 中间人证书仅存在于 `/tmp`，用完可清理：
  `rm -f /tmp/fb-ca.* /tmp/fbcert-*`
- 切勿用此类工具抓取他人流量
- 免费档条款可能禁止直接调 API，请自行评估使用风险

## 故障排查

| 现象 | 原因 / 解决 |
| ---- | ----------- |
| CLI 报证书错误 | 未设置 `SSL_CERT_FILE=/tmp/fb-ca.crt` |
| 代理无输出 | `HTTPS_PROXY` 未生效；或 CLI 直连失败（确认 CONNECT 日志） |
| `Another instance of freebuff has taken over this session` | 会话被占用，重新登录 |
| 响应乱码 | brotli/gzip 压缩，正文在终端里仍可见可读部分即可 |
