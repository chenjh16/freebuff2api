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

1. 已登录：`bun run login`（或已有 `~/.config/freebuff2api/credentials.json`）
2. 已安装 opencode：`curl -fsSL https://opencode.ai/install | bash`
   （会安装到 `~/.opencode/bin`）
3. 项目根目录可用 `bun`

## 一键运行

```bash
# 运行全部案例
node tests/agentic/run.mjs all

# 只运行单个案例
node tests/agentic/run.mjs opencode-demo
node tests/agentic/run.mjs opencode-md2html

# 指定端口 / 续跑上次会话 / 更长超时
node tests/agentic/run.mjs all --port 18080
node tests/agentic/run.mjs opencode-md2html --continue
FB2API_PORT=18090 OPENCODE_TIMEOUT_MIN=30 node tests/agentic/run.mjs opencode-demo
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
重跑时 opencode 会重读 README 并验证/修复。

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
      "models": { "deepseek/deepseek-v4-flash": { "name": "DeepSeek V4 Flash (Free)" } }
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

---

# Agentic end-to-end tests (agentic/)

Drive **opencode** — a real third-party OpenAI-compatible client — through the
**freebuff2api** proxy to complete real coding tasks in the case directories,
then independently verify the artifacts. This is the strongest proof that any
OpenAI-compatible client can drive Freebuff's free models through this proxy.

## Prerequisites

1. Signed in: `bun run login` (or `~/.config/freebuff2api/credentials.json` exists)
2. opencode installed: `curl -fsSL https://opencode.ai/install | bash`
   (installs to `~/.opencode/bin`)
3. `bun` available at the project root

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
