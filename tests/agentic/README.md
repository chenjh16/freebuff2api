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
node tests/agentic/run.mjs

# 只运行单个案例
node tests/agentic/run.mjs opencode-demo
node tests/agentic/run.mjs opencode-md2html

# 指定端口 / 续跑上次会话 / 更长超时
node tests/agentic/run.mjs all --port 18080
node tests/agentic/run.mjs opencode-md2html --continue
FB2API_PORT=18090 OPENCODE_TIMEOUT_MIN=30 node tests/agentic/run.mjs
```

运行器会：启动代理 → 等待 `/healthz` → 自动把 opencode 的 `freebuff` provider
指向代理（合并写入 `~/.config/opencode/config.json`，不覆盖你的其他配置）→
执行案例 → 独立验收 → 停止代理。返回码 0=全部通过。

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
node tests/agentic/run.mjs

# run a single case
node tests/agentic/run.mjs opencode-demo
node tests/agentic/run.mjs opencode-md2html

# custom port / continue a session / longer timeout
node tests/agentic/run.mjs all --port 18080
node tests/agentic/run.mjs opencode-md2html --continue
FB2API_PORT=18090 OPENCODE_TIMEOUT_MIN=30 node tests/agentic/run.mjs
```

The runner: starts the proxy → waits for `/healthz` → points opencode's
`freebuff` provider at the proxy (merges into `~/.config/opencode/config.json`
without clobbering your other config) → executes the case → independently
validates → stops the proxy. Exit code 0 = all passed.

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
