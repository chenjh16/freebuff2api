# tools/ — 调试与分析工具

本目录收录了逆向 Freebuff 上游协议与验证代理功能时用到的全部辅助脚本。
它们全部为**独立 Node 脚本**（`.mjs`，零依赖），直接用 `node` 运行，
不需要安装任何东西。

> 📖 **MITM 抓包工作流见 [`MITM使用指南.md`](MITM使用指南.md)**
> （含完整操作步骤、解读要点、故障排查）；抓包实录见
> [`captured/mitm-抓包实录.md`](captured/mitm-抓包实录.md)。

> ⚠️ 这些脚本会**真实消耗免费账号额度**（deepseek-v4-flash 每日约 6 次），
> 请按需使用，避免频繁跑 `all` 等组合模式。

## 环境准备

1. 确保已登录：`bun run login`（或已有 `~/.config/freebuff2api/credentials.json`）
2. 需要 Node 18+（脚本使用 `fetch` / `crypto.randomUUID`）
3. 个别脚本需要 `openssl`（仅 `mitm-ssl-proxy.mjs` 用）

## 工具一览

| 脚本 | 用途 | 消费额度 |
| ---- | ---- | -------- |
| `mitm-proxy.mjs` | HTTP 明文代理，打印 CLI 请求 | 否 |
| `mitm-ssl-proxy.mjs` | **TLS 中间人代理**，抓取 CLI 的 HTTPS 请求（核心工具） | 否 |
| `MITM使用指南.md` | MITM 完整操作流程与解读方法 | — |
| `e2e-test.mjs` | 会话→运行→chat 全链路 + 请求头/体变体 | 是 |
| `discover-gate.mjs` | 免费模式网关二分探索（破解 free_mode_cli_required） | 是 |
| `replay-captured.mjs` | 重放官方 CLI 捕获请求（细粒度 system 变体） | 是 |
| `prodlike-test.mjs` | 验证代理注入后的请求形状（流式 + 非流式） | 是 |
| `captured/` | 官方 CLI 捕获产物（请求 body、Agent 定义） | — |

---

## 1. mitm-proxy.mjs — HTTP 明文代理

只对明文 HTTP 流量有效；CLI 走 HTTPS 时请用 SSL 版。

```bash
node tools/mitm-proxy.mjs          # 监听 18099，转发到 www.codebuff.com
# 另开终端：
export HTTP_PROXY=http://127.0.0.1:18099
freebuff
```

## 2. mitm-ssl-proxy.mjs — TLS 中间人代理（核心）

**这是逆向成功的关键工具**：官方 CLI 的所有请求都是 HTTPS，只有解密后
才能看到真实请求内容（最终借此破解了免费模式网关）。

```bash
# 终端 1：启动代理（首次会自动生成本地 CA）
node tools/mitm-ssl-proxy.mjs      # 监听 18100

# 终端 2：让 CLI 走代理并信任本地 CA
export HTTPS_PROXY=http://127.0.0.1:18100
export SSL_CERT_FILE=/tmp/fb-ca.crt
freebuff                             # 正常使用 CLI，触发一次对话

# 终端 1 会打印每个请求的头与 body（token 已脱敏）
```

要点：

- 依赖 `openssl` 为每个域名签发临时证书
- 捕获到 chat 请求后，可把完整 body 存为
  `tools/captured/chatbody-official.json` 备后续重放
- 只用于调试自己的账号，勿用于攻击他人流量

## 3. e2e-test.mjs — 全链路请求格式探索

```bash
node tools/e2e-test.mjs              # baseline：普通 chat（会 403，见 docs/04）
node tools/e2e-test.mjs fullclone    # 复刻官方 CLI 完整流程（应 200）
node tools/e2e-test.mjs delete       # 仅删除当前会话
```

其他模式：`official`、`compact-get`、`noactinguser`、`bunua`（切换 chat 的
UA 与头）。每个模式都会创建会话 → 启动运行 → 发 chat，并打印每一步状态。

## 4. discover-gate.mjs — 网关二分探索

**破解 `free_mode_cli_required` 的核心实验脚本**。逐个关掉请求体中的字段
（system / tools / stop / provider），观察网关放行还是拒绝。

```bash
node tools/discover-gate.mjs exact      # 完整复刻官方请求（应 200）
node tools/discover-gate.mjs nosystem   # 去掉 system 消息（应 403）
node tools/discover-gate.mjs all        # 跑全部 8 个变体（耗 8 次额度，慎用）
```

可用变体：`exact` `nosystem` `notools` `nostop` `noprovider` `mint`
`shortbuffy` `buffyname` `freebuffonly` `buffyfb` `firstsent` `climarker`
`ourua` `all`。完整结果表见 [docs/04-请求格式破解.md](../docs/04-请求格式破解.md)。

## 5. replay-captured.mjs — 捕获请求重放

用最新 session/run 重放官方捕获的 chat 请求，支持细粒度 system 提示编辑：

```bash
node tools/replay-captured.mjs              # exact：原样重放
node tools/replay-captured.mjs shortsys     # 换成 "You are a helpful assistant"
node tools/replay-captured.mjs firstsentence
node tools/replay-captured.mjs nocache      # 去掉 cache_control
```

变体列表见脚本头注释。

## 6. prodlike-test.mjs — 代理形状回归验证

模拟 `src/server.ts` 的 `injectCliSystemMarker()` 注入后的请求形状，
分别以流式 / 非流式验证网关放行并拿到真实回复：

```bash
node tools/prodlike-test.mjs
# stream=true: 200 : connected … data: {"object":"chat.completion.chunk",…}
# stream=false: 200 { "choices": [ { "message": { "content": "PONG", … } } ] }
```

**建议在修改了 `injectCliSystemMarker` 或 `upstream.ts` 后跑一次做回归。**

## 7. captured/ — 官方 CLI 捕获产物

| 文件 | 内容 | 用途 |
| ---- | ---- | ---- |
| `chatbody-official.json` | 官方 CLI 一次成功 chat 的完整请求体（64KB，含完整 system 提示、24 个 tools、codebuff_metadata） | `replay-captured.mjs`、`discover-gate.mjs` 的基准 |
| `agentdefs-full.json` | 官方 CLI POST `/api/agents/validate` 发送的全部 Agent 定义（460KB，含每个 agent 的 systemPrompt/toolNames/spawnableAgents） | 查阅免费 Agent 结构、system 标记来源 |
| `agentdefs.json` | 精简版 Agent 定义示例（6KB） | 快速查阅 |
| `mitm-抓包实录.md` | MITM 抓取的官方 CLI 关键请求（脱敏精选 + 时序 + 解读） | 对照协议文档 |

```bash
# 快速查看某个 Agent 的定义（以 base2-free-deepseek-flash 为例）
node -e "const j=require('./tools/captured/agentdefs-full.json'); \
  console.log(JSON.stringify(j.agentDefinitions.find(d=>d.id==='base2-free-deepseek-flash'),null,1).slice(0,1500))"
```

## MITM 抓包流程（速览）

```bash
# 终端 1：启动 TLS 中间人代理
node tools/mitm-ssl-proxy.mjs

# 终端 2：让官方 CLI 走代理并信任本地 CA
export HTTPS_PROXY=http://127.0.0.1:18100
export SSL_CERT_FILE=/tmp/fb-ca.crt
freebuff

# 在 CLI 里发一条消息 → 终端 1 打印全部请求（token 脱敏）
```

完整步骤、解读要点、故障排查见 [MITM使用指南.md](MITM使用指南.md)；
抓到的请求样本见 [captured/mitm-抓包实录.md](captured/mitm-抓包实录.md)。

## 典型排查流程

遇到上游报错时按此顺序排查：

1. `node tools/e2e-test.mjs` — 确认会话/运行是否正常
2. 看 `DEBUG_UPSTREAM=1 bun run src/index.ts` 的代理日志，确认注入内容
3. 网关类错误（403 free_mode_cli_required）：跑 `discover-gate.mjs`
   复现 docs/04 的对照表，确认 system 标记仍在
4. 改了注入逻辑：跑 `prodlike-test.mjs` 回归
5. 需要看官方 CLI 到底怎么发的：用 `mitm-ssl-proxy.mjs` 抓包对照
   （见 [MITM使用指南.md](MITM使用指南.md)）
