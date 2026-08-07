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
| `probe-session.mjs` | 逐模型会话准入探针（`--admit-only` 不耗 chat 额度） | 视模式 |
| `cli-probe.mjs` | PTY 驱动官方 CLI 最小对话（可选 MITM 抓包） | 是（1 次 chat） |
| `model-availability.mjs` | 读取 `/v1/models` 后逐模型最小 chat 探测（并发受限） | 是（每模型 1 次） |
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
node tools/e2e-test.mjs              # baseline：普通 chat（会 403，见 docs/zh/04）
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
`ourua` `all`。完整结果表见 [docs/zh/04-请求格式破解.md](../docs/zh/04-请求格式破解.md)（英文版：[docs/en/04-request-format-gate.md](../docs/en/04-request-format-gate.md)）。

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

## 7. probe-session.mjs — 逐模型会话准入探针

在不消耗 chat 额度的前提下确认某个模型当前能否被准入，并观察"账户已持有
另一个模型会话"时上游的真实响应（这正是 1 小时 session 固定模型约束下的
关键诊断步骤，见 [docs/zh/06-端到端测试记录.md](../docs/zh/06-端到端测试记录.md)
阶段 9）。

```bash
node tools/probe-session.mjs --delete                # 释放会话槽位
node tools/probe-session.mjs openai/gpt-5.6-luna --admit-only   # 只探测准入（0 chat 额度）
node tools/probe-session.mjs deepseek/deepseek-v4-flash        # 全链路：session→run→chat
```

## 8. cli-probe.mjs — 官方 CLI 最小对话探针（无 TTY 环境）

在 Daytona 等无可用 TTY（tmux 助手不可写 `/tmp`）的执行器里，用
`script`（util-linux）伪造 PTY 驱动官方 `freebuff` CLI 的 TUI，发送一条
最小消息，并可选在 `tools/mitm-ssl-proxy.mjs` 下运行以抓取全部请求。

```bash
node tools/cli-probe.mjs --model deepseek/deepseek-v4-flash --mitm
node tools/cli-probe.mjs --model openai/gpt-5.6-luna --mitm --out /tmp/luna
```

要点：

- 模型由 `~/.config/manicode/settings.json` 的 `freebuffModel` 决定；首次启动
  CLI 会弹出模型选择器，脚本会自动按 Enter 选中高亮模型再发消息。
- 产物：`<out>.tui.log`（TUI 原始输出）、`<out>.mitm.log`（MITM 抓包）。
- 会真实消耗 1 次目标模型的 chat 额度。

## 9. model-availability.mjs — 模型可用性全面探测

先读取代理的 `/v1/models`，再逐个发送最小 chat 请求并输出每个模型的
HTTP 状态、延迟和有限长度的错误摘要。默认最多 3 个并发，避免一次性压垮
免费额度；每个模型仍可能消耗一次上游额度。

```bash
node tools/model-availability.mjs --help
node tools/model-availability.mjs --base-url http://127.0.0.1:23333/v1
node tools/model-availability.mjs --concurrency 2 --json > model-results.json
node tools/model-availability.mjs --models deepseek/deepseek-v4-flash,openai/gpt-5.6-luna
```

如代理配置了 `API_KEYS`，使用 `--api-key` 或 `FB2API_API_KEY`；脚本不会输出
凭证。只查看模型映射而不消耗额度时，请直接调用 `GET /v1/models`，不要运行
chat 探测。

## 10. captured/ — 官方 CLI 捕获产物

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

## 模型支持与 API 验收

代理会在启动时从官方 `free-agents.ts` 同步 Agent→模型映射；网络失败时使用
`src/models.ts` 的内置兜底列表。`GET /v1/models` 是当前广告列表，不能单独
证明每个模型此刻有可用会话，因此应使用上面的探测脚本做显式可用性检查。

自动化测试默认只运行单元测试；真实 API 检查需显式设置凭证并运行
`bun test tests/e2e --timeout 120000`。模型全面检查是 opt-in：
`LIVE_MODEL_TEST=1 bun test tests/e2e/model-availability.test.ts --timeout 180000`。

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

模型对比注意事项：

- 官方 CLI 当前没有 `--model` 参数；模型由 TUI 的模型选择器和
  `~/.config/manicode/settings.json` 的 `freebuffModel` 偏好管理。
- `openai/gpt-5.6-luna` 必须对应 `base2-free-luna`；
  `deepseek/deepseek-v4-flash` 必须对应 `base2-free-deepseek-flash`。
- 一个账号只能有一个活动 session，且 session 固定模型。比较两个模型时，
  必须先退出/结束旧 session，再分别抓包；不要在同一 session 中切换模型。
- 抓包摘要应只保留 method/path/status、模型、Agent、header 名和 body 结构；
  不要把 Authorization、Cookie、完整 prompt、响应正文或原始抓包提交到仓库。
- 若 Daytona/tmux 执行器不能创建 `/tmp` 辅助脚本，这属于执行器问题，不是
  代理 503；请改用可写临时目录和真实 TTY 后重试。

完整步骤、解读要点、故障排查见 [MITM使用指南.md](MITM使用指南.md)；
抓到的请求样本见 [captured/mitm-抓包实录.md](captured/mitm-抓包实录.md)。

## 典型排查流程

遇到上游报错时按此顺序排查：

1. `node tools/e2e-test.mjs` — 确认会话/运行是否正常
2. 看 `DEBUG_UPSTREAM=1 bun run src/index.ts` 的代理日志，确认注入内容
3. 网关类错误（403 free_mode_cli_required）：跑 `discover-gate.mjs`
   复现 docs/zh/04 的对照表，确认 system 标记仍在
4. 改了注入逻辑：跑 `prodlike-test.mjs` 回归
5. 需要看官方 CLI 到底怎么发的：用 `mitm-ssl-proxy.mjs` 抓包对照
   （见 [MITM使用指南.md](MITM使用指南.md)）
