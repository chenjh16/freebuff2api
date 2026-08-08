# tests/ — 测试套件

本目录包含三层测试：**单元测试**（`unit/`）、**API 端到端测试**（`e2e/`）、
**Agent 端到端测试**（`agentic/`）。

```
tests/
  unit/       单元测试（bun test，无网络、不消耗额度，CI 自动运行）
  e2e/        API 端到端测试（真实调用 Freebuff 上游，需登录凭证）
  agentic/    Agent 端到端测试（用 opencode 通过代理完成真实编码任务）
    run.mjs   一键运行器
    README.md 本文件
    cases/    案例目录（opencode-demo / opencode-md2html）
```

---

# Agent 端到端测试（agentic/）

用 **opencode**（真实第三方 OpenAI 兼容客户端）连接 **freebuff2api** 代理，
在案例目录中完成真实编码任务，并独立验收产物。这是对“任意 OpenAI 兼容客户端
都能通过本代理驱动 Freebuff 免费模型”的最强证明。

## 前置条件

1. 已安装 opencode：`curl -fsSL https://opencode.ai/install | bash`
   （会安装到 `~/.opencode/bin`）
2. 项目根目录可用 `bun`
3. 已登录（仅当使用 Freebuff 认证模型时）：`bun run login`
   （或已有 `~/.config/freebuff2api/credentials.json`）；使用**公共免认证
   模型**（如 OpenCode Zen 的 `opencode/deepseek-v4-flash-free`、
   `opencode/big-pickle`）时**不需要任何登录凭证**

## 一键运行

```bash
# 运行全部案例（默认 Freebuff 模型，需登录）
node tests/agentic/run.mjs all

# 只运行单个案例
node tests/agentic/run.mjs opencode-demo
node tests/agentic/run.mjs opencode-md2html

# 指定端口 / 续跑上次会话 / 更长超时
node tests/agentic/run.mjs all --port 18080
node tests/agentic/run.mjs opencode-md2html --continue
FB2API_PORT=18090 OPENCODE_TIMEOUT_MIN=30 node tests/agentic/run.mjs opencode-demo

# 用公共免认证模型（OpenCode Zen 渠道），无需登录：
#   model = opencode provider 标签 + 代理模型 ID（ID 带供应商前缀；代理只
#   接受前缀 ID，裸 ID 不再可路由）。
OPENCODE_MODEL=freebuff/opencode/deepseek-v4-flash-free node tests/agentic/run.mjs opencode-demo
OPENCODE_MODEL=freebuff/opencode/big-pickle node tests/agentic/run.mjs opencode-demo

# 删除 scratch 中的参考产物，强制 opencode 从零创建文件（更强的 E2E 证明）
AGENTIC_FRESH=1 OPENCODE_MODEL=freebuff/opencode/deepseek-v4-flash-free node tests/agentic/run.mjs opencode-demo
```

一键模式会自动执行：检查 → 准备配置 → 启动代理 → 运行 opencode → 独立验收 →
停止代理 → 恢复配置。返回码 0=全部通过。

## 分阶段运行（推荐用于 Daytona/CI/远程执行器）

长时间 Agent 任务不要放进一个远程命令请求。每个阶段单独执行，状态保存在
系统临时目录，默认不会写入仓库：

```bash
# 1. 只检查依赖、案例和登录状态，不访问上游
node tests/agentic/run.mjs check

# 2. 备份并准备 opencode provider 配置
node tests/agentic/run.mjs prepare --port 18080

# 3. 独立启动代理；日志位于 /tmp/freebuff2api-agentic-*/proxy.log
node tests/agentic/run.mjs start-proxy --port 18080

# 4. 另一个命令请求中运行真实 Agent
node tests/agentic/run.mjs run opencode-demo

# 5. 不消耗模型额度的独立验收
node tests/agentic/run.mjs validate opencode-demo

# 6. 无论成功失败都执行，停止代理并恢复原 opencode 配置
node tests/agentic/run.mjs cleanup
```

如果某一步失败，先重跑同一阶段或查看临时目录中的 `proxy.log`，不需要从头
执行。`prepare` 会备份原配置；只有配置内容仍是 runner 生成的版本时，
`cleanup` 才会恢复它。如果用户在中途手动修改了配置，runner 会保留修改并
给出警告。

> ⚠️ 每次运行都会真实消耗免费账号额度（deepseek-v4-flash 每日约 6 次），
> 请按需运行，避免频繁跑 `all`。

## 案例一览

| 案例 | 任务 | 验收标准 | 覆盖的内置工具 |
| ---- | ---- | -------- | -------------- |
| `opencode-demo` | 生成 `fib.js`（fibonacci）+ `fib.test.js`（node:assert ≥3 断言），跑通测试 | `node fib.test.js` 输出 `All fib tests passed` | read / write / bash |
| `opencode-md2html` | 零依赖 Markdown→HTML 转换器（`md2html.js` + `cli.js` + `test.js` ≥8 断言），实际转换 `sample.md`，webfetch 抓取 example.com | `node test.js` 全过；`node cli.js sample.md` 输出含 `<h1>` `<ul>` `<pre>` `<a href` | read / write / edit / bash / webfetch |

两个案例目录内保留了上次实测的完整产物（作为参考实现）与验收记录，
重跑时 opencode 会重读 README 并验证/修复；设置 `AGENTIC_FRESH=1` 时
会在临时工作区删除这些参考产物，强制 opencode 从零创建。

## 公共上游渠道模型（OpenCode Zen 等，免认证）

公共渠道默认开启，代理在 `AUTH_TOKENS` 为空时也放行白名单公共模型。运行器
因此支持把 agent 任务直接打到公共免认证模型上，**无需登录**：

```bash
OPENCODE_MODEL=freebuff/opencode/deepseek-v4-flash-free node tests/agentic/run.mjs opencode-demo
OPENCODE_MODEL=freebuff/opencode/big-pickle       node tests/agentic/run.mjs opencode-demo
OPENCODE_MODEL=freebuff/felo/felo-chat        node tests/agentic/run.mjs opencode-demo
```

- `OPENCODE_MODEL` 的格式是 `opencode provider 标签/代理模型 ID`（provider
  标签固定为 `freebuff`），opencode 把完整的代理模型 ID（例如
  `opencode/deepseek-v4-flash-free`，带供应商前缀）发给代理；代理只接受
  带供应商前缀的 ID，裸 ID 不再可路由。
- `check` 阶段对公共模型跳过登录凭证检查；`prepare` 会把该模型 ID 写入
  opencode provider 的 `models` 表。

## 运行器实现说明（2026-08-08 实测修好的三个坑）

1. **stdin 必须关闭**：node `spawn` 默认给 opencode 一个永不关闭的 stdin
   管道，opencode（≥1.18）会在 session init 阶段挂起等待 stdin；运行器改为
   `stdio: ["ignore", …]` 并加 `--print-logs`（非 TTY 下不要用 TUI）。
2. **工作区不能放在 git 仓库内**：opencode 会把工作区规范化为最近的 git
   根目录（日志中表现为先按 cwd 建实例、再用仓库根重建一次），导致模型把
   文件写进仓库根而不是 case 目录。运行器把 case 复制到系统临时目录
   （`/tmp/freebuff2api-agentic-*/work/<case>`）的 scratch 工作区运行并校验，
   仓库保持干净。
3. **子进程 `PWD` 要与 cwd 一致**：node `spawn` 改了 cwd 却不改继承的
   `PWD`，opencode 用 `PWD` 解析工作区，导致从 /tmp 启动时仍把会话指回
   上一个项目目录。运行器在子进程 env 中把 `PWD` 同步为 cwd。

## 手动复现（不用运行器）

```bash
# 1. 启动代理（另开终端）
LISTEN_ADDR=:18080 bun run src/index.ts

# 2. 配置 opencode（一次性）
cat > ~/.config/opencode/config.json <<'EOF'
{
  "provider": {
    "freebuff": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Freebuff via freebuff2api",
      "options": { "baseURL": "http://127.0.0.1:18080/v1", "apiKey": "local" },
      "models": { "freebuff/deepseek/deepseek-v4-flash": { "name": "DeepSeek V4 Flash (Free)" } }
    }
  },
  "model": "freebuff/deepseek/deepseek-v4-flash"
}
EOF

# 3. 在案例目录运行 opencode
cd tests/agentic/cases/opencode-demo
opencode run --model freebuff/deepseek/deepseek-v4-flash --auto "阅读 README.md 完成任务"

# 4. 独立验收
node fib.test.js
```

## 实测记录

- **opencode-demo**（2026-08-07）：4 次上游 chat 全部 status 200；opencode
  自主处理了 ESM/CJS 环境问题（重读父级 `package.json` 后以 ESM 重写并重跑通过）。
- **opencode-md2html**（2026-08-07）：13 条消息 / 12 次上游 chat 调用；
  工具使用 `read`×2、`write`×5、`edit`×2、`bash`×6、`webfetch`×2；10 个断言全过。

### 其他渠道模型能否用于 opencode（2026-08-08 实测）

运行器支持把任意公共渠道模型放进 `OPENCODE_MODEL`，实测结论如下：

| 渠道/模型 | 经 opencode 普通对话 | 经 opencode Agent 任务（带工具） | 原因 |
| ---- | ---- | ---- | ---- |
| OpenCode Zen（`opencode/deepseek-v4-flash-free`、`opencode/big-pickle`） | ✅ | ✅ PASS | 原生 OpenAI 兼容，支持工具调用 |
| Pollinations（`pollinations/qwen-coder`、`pollinations/openai`、`pollinations/deepseek`…） | ✅（不带工具时 200） | ❌ 确定性 401 | 匿名网关**拒绝任何带 `tools` 字段的请求**（实测 3/3 全 401；不带 tools 同模型 3/3 全 200）——工具调用需要账号，Agent 无法使用 |
| Felo（`felo/felo-chat`） | ✅（正常回复） | ❌ 无工具调用 | 对话/搜索类模型，只能聊天，不能写文件/执行命令 |

> Pollinations 的 `tools`-401 是确定性行为而非随机抽签（与文档 10 中记录的
> prompt 形状抽签是两回事）：任何编码 Agent（opencode/Claude Code 等）都会
> 在请求里带工具定义，因此 Pollinations chat 模型不适合做 Agent 后端，只适合
> 普通对话。

### OpenCode Zen 渠道（免认证，经代理）— 2026-08-08

全部通过运行器 one-shot（scratch 工作区、fresh 模式从零创建文件、仓库零污染）：

| 案例 | 模型 | 结果 | 说明 |
| ---- | ---- | ---- | ---- |
| `opencode-demo` | `opencode/deepseek-v4-flash-free` | ✅ PASS | 从零生成 `fib.js`/`fib.test.js`（ESM），测试通过 |
| `opencode-md2html` | `opencode/deepseek-v4-flash-free` | ✅ PASS | 从零生成转换器（11 断言全过）、webfetch example.com 成功、CLI 输出含 `<h1>/<ul>/<pre>/<a href` |
| `opencode-demo` | `opencode/big-pickle` | ✅ PASS | 从零生成 `fib.js`/`fib.test.js`，测试通过 |

验证了 opencode → 代理 `/v1` → OpenCode Zen 免认证上游的完整 Agent 链路，
且**不需要任何 Freebuff 登录凭证**；open 状态下代理对无 token 请求直接放行。
此前还确认：opencode 单轮对话经代理 1.7s 内返回、流式以 `finish_reason:"stop"`
与 `[DONE]` 正常收尾（见 09/10 文档的流式兼容性说明）。

---

# Agentic end-to-end tests (agentic/)

Drive **opencode** — a real third-party OpenAI-compatible client — through the
**freebuff2api** proxy to complete real coding tasks in the case directories,
then independently verify the artifacts. This is the strongest proof that any
OpenAI-compatible client can drive Freebuff's free models through this proxy.

## Prerequisites

1. opencode installed: `curl -fsSL https://opencode.ai/install | bash`
   (installs to `~/.opencode/bin`)
2. `bun` available at the project root
3. Signed in (`bun run login`) only when using authenticated Freebuff models;
   public no-auth models (e.g. OpenCode Zen `opencode/deepseek-v4-flash-free`,
   `opencode/big-pickle`) need no login at all

## One-shot run

```bash
# run every case
node tests/agentic/run.mjs all

# run a single case
node tests/agentic/run.mjs opencode-demo
node tests/agentic/run.mjs opencode-md2html

# custom port / continue a session / longer timeout
node tests/agentic/run.mjs all --port 18080
node tests/agentic/run.mjs opencode-md2html --continue
FB2API_PORT=18090 OPENCODE_TIMEOUT_MIN=30 node tests/agentic/run.mjs opencode-demo
```

The one-shot runner performs check → prepare → start proxy → run opencode →
independent validation → stop proxy → restore config. Exit code 0 means all
cases passed.

## Resumable phases (recommended for Daytona/CI/remote executors)

Do not put a long Agent task into one remote command request. Run each phase
separately; state is stored in the system temporary directory, not the repo:

```bash
node tests/agentic/run.mjs check
node tests/agentic/run.mjs prepare --port 18080
node tests/agentic/run.mjs start-proxy --port 18080
node tests/agentic/run.mjs run opencode-demo
node tests/agentic/run.mjs validate opencode-demo
node tests/agentic/run.mjs cleanup
```

If a phase fails, rerun that phase or inspect `proxy.log` under
`/tmp/freebuff2api-agentic-*/`; no full restart is required. `prepare` backs up
the previous opencode config. `cleanup` restores it only when it has not been
modified outside the runner; manual changes are preserved with a warning.

> ⚠️ Each run really consumes free-tier quota (~6 deepseek-v4-flash requests a
> day). Run sparingly; avoid `all` on a regular basis.

## Cases

| Case | Task | Acceptance | Built-in tools exercised |
| ---- | ---- | ---------- | ------------------------ |
| `opencode-demo` | Write `fib.js` (`fibonacci`) + `fib.test.js` (node:assert ≥3), pass the tests | `node fib.test.js` prints `All fib tests passed` | read / write / bash |
| `opencode-md2html` | Zero-dependency Markdown→HTML converter (`md2html.js` + `cli.js` + `test.js` ≥8 assertions), convert `sample.md`, webfetch example.com | `node test.js` green; `node cli.js sample.md` contains `<h1>` `<ul>` `<pre>` `<a href` | read / write / edit / bash / webfetch |

Both case directories keep the artifacts of the previous real run (as reference
implementations) and the acceptance notes; on re-run opencode re-reads the README
and verifies/fixes.

## Manual reproduction (without the runner)

```bash
# 1. start the proxy (separate terminal)
LISTEN_ADDR=:18080 bun run src/index.ts

# 2. configure opencode once (see config snippet in the Chinese section above)

# 3. run opencode inside the case directory
cd tests/agentic/cases/opencode-demo
opencode run --model freebuff/deepseek/deepseek-v4-flash --auto "Read README.md and complete the task"

# 4. verify independently
node fib.test.js
```

## Recorded results

- **opencode-demo** (2026-08-07): 4 upstream chat calls, all status 200;
  opencode self-debugged an ESM/CJS issue (re-read the parent `package.json`,
  rewrote as ESM, re-ran green).
- **opencode-md2html** (2026-08-07): 13 messages / 12 upstream chat calls;
  tools used `read`×2, `write`×5, `edit`×2, `bash`×6, `webfetch`×2; all 10
  assertions passed.
