#!/usr/bin/env node
/**
 * tests/agentic/run.mjs — Agent 端到端测试一键运行器
 *
 * 流程：启动 freebuff2api 代理 → 等待 /healthz 就绪 → 确保 opencode 的
 * `freebuff` provider 指向代理 → 在案例目录用 opencode 完成真实编码任务 →
 * 独立验收产物 → 停止代理。返回码 0=通过，1=失败。
 *
 * 案例（tests/agentic/cases/）：
 *   opencode-demo     最小任务：生成 fib.js + fib.test.js 并跑通断言
 *   opencode-md2html  复杂任务：零依赖 Markdown→HTML 转换器（多文件 + webfetch）
 *
 * 用法：
 *   node tests/agentic/run.mjs [opencode-demo|opencode-md2html|all] [--port 18080] [--continue]
 *
 * 环境变量：
 *   FB2API_PORT   代理端口（默认 18080）
 *   OPENCODE_MODEL opencode 使用的模型（默认 freebuff/deepseek/deepseek-v4-flash）
 *   OPENCODE_TIMEOUT_MIN opencode 单次运行超时（分钟，默认 20）
 *
 * 前置条件：
 *   1. 已登录：~/.config/freebuff2api/credentials.json（bun run login）
 *   2. 已安装 opencode（官方脚本：curl -fsSL https://opencode.ai/install | bash）
 *   3. 本项目根目录可运行 bun
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CASES_DIR = join(__dirname, "cases");

const portArgIdx = process.argv.indexOf("--port");
const PORT = Number(process.env.FB2API_PORT ?? (portArgIdx !== -1 ? process.argv[portArgIdx + 1] : 18080));
const OPENCODE_MODEL = process.env.OPENCODE_MODEL ?? "freebuff/deepseek/deepseek-v4-flash";
const OPENCODE_TIMEOUT_MS = (Number(process.env.OPENCODE_TIMEOUT_MIN ?? 20)) * 60_000;
const CONTINUE = process.argv.includes("--continue");
const OPENCODE_BIN = join(homedir(), ".opencode", "bin", "opencode");

const CASES = {
  "opencode-demo": {
    prompt: "请阅读本目录 README.md 完成任务：实现 fib.js（导出 fibonacci(n)，n>=0，f(0)=0, f(1)=1）与 fib.test.js（node:assert 至少 3 个断言）。禁止任何第三方依赖。完成后运行 node fib.test.js 确认全部通过，然后简要报告。",
    validate: async (dir) => {
      const { code, stdout } = await run("node", ["fib.test.js"], { cwd: dir });
      return { ok: code === 0 && /All fib tests passed/.test(stdout), detail: stdout.trim() };
    },
  },
  "opencode-md2html": {
    prompt: "请阅读本目录 README.md 与 sample.md，按任务要求完成 Markdown→HTML 转换器：md2html.js（导出 md2html）、cli.js（node cli.js <file>）、test.js（node:assert 至少 8 个断言）。零第三方依赖。用 webfetch 工具抓取 https://example.com 确认网络。完成后运行 node test.js 与 node cli.js sample.md 验证，并简要总结。",
    validate: async (dir) => {
      const t = await run("node", ["test.js"], { cwd: dir });
      const c = await run("node", ["cli.js", "sample.md"], { cwd: dir });
      const hasTags = /<h1>/.test(c.stdout) && /<ul>/.test(c.stdout) && /<pre>/.test(c.stdout) && /<a href=/.test(c.stdout);
      return { ok: t.code === 0 && /all \d+ assertions passed/i.test(t.stdout) && hasTags, detail: `test.js: ${t.stdout.trim()}\ncli.js tags: ${hasTags}` };
    },
  },
};

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function waitForHealthz(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (resp.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/** 确保 opencode 的 freebuff provider 指向代理（合并保留用户其他配置）。 */
function ensureOpencodeConfig(baseURL) {
  const dir = join(homedir(), ".config", "opencode");
  const file = join(dir, "config.json");
  mkdirSync(dir, { recursive: true });
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch { cfg = {}; }
  }
  const provider = cfg.provider ?? {};
  provider.freebuff = {
    npm: "@ai-sdk/openai-compatible",
    name: "Freebuff via freebuff2api",
    options: { baseURL, apiKey: "local" },
    models: { "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash (Free)" } },
    ...(provider.freebuff ?? {}),
  };
  // 只更新 baseURL，保留其他 provider 配置
  provider.freebuff.options = { ...(provider.freebuff.options ?? {}), baseURL, apiKey: "local" };
  cfg.provider = provider;
  cfg.model = cfg.model ?? OPENCODE_MODEL;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`[run] opencode config ready → ${file} (${baseURL})`);
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0] ?? "all";
  const names = requested === "all" ? Object.keys(CASES) : [requested];
  for (const name of names) {
    if (!CASES[name]) { console.error(`[run] unknown case "${name}". Valid: ${Object.keys(CASES).join(", ")} or all`); process.exit(1); }
  }

  if (!existsSync(OPENCODE_BIN)) {
    console.error("[run] opencode not found. Install it first: curl -fsSL https://opencode.ai/install | bash");
    process.exit(1);
  }
  if (!existsSync(join(homedir(), ".config", "freebuff2api", "credentials.json"))) {
    console.error("[run] no credentials at ~/.config/freebuff2api/credentials.json — run `bun run login` first");
    process.exit(1);
  }

  const baseURL = `http://127.0.0.1:${PORT}/v1`;
  const proxy = spawn("bun", ["run", "src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, LISTEN_ADDR: `:${PORT}`, PORT: "" },
  });
  proxy.stdout.on("data", (d) => process.stdout.write(`[proxy] ${d}`));
  proxy.stderr.on("data", (d) => process.stderr.write(`[proxy] ${d}`));

  try {
    if (!(await waitForHealthz(`http://127.0.0.1:${PORT}/healthz`))) {
      console.error(`[run] proxy did not become ready on :${PORT} within 60s`);
      process.exitCode = 1;
      return;
    }
    console.log(`[run] proxy ready on :${PORT}`);
    ensureOpencodeConfig(baseURL);

    // 验证 opencode 能列出 freebuff provider 的模型
    const modelsCheck = await run(OPENCODE_BIN, ["models", "freebuff"], { timeoutMs: 90_000 });
    if (modelsCheck.code !== 0) {
      console.error(`[run] 'opencode models freebuff' failed (exit ${modelsCheck.code}) — provider not loading?`);
      process.exitCode = 1;
      return;
    }

    let allOk = true;
    for (const name of names) {
      const dir = join(CASES_DIR, name);
      const args = CONTINUE ? ["run", "--continue", "--model", OPENCODE_MODEL, "--auto", CASES[name].prompt]
                           : ["run", "--model", OPENCODE_MODEL, "--auto", CASES[name].prompt];
      console.log(`\n[run] ===== case: ${name} (opencode ${CONTINUE ? "continue " : ""}run) =====`);
      const result = await run(OPENCODE_BIN, args, { cwd: dir, timeoutMs: OPENCODE_TIMEOUT_MS, env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } });
      const verdict = await CASES[name].validate(dir);
      console.log(`[run] case ${name}: opencode exit=${result.code}, validation=${verdict.ok ? "PASS" : "FAIL"}`);
      if (verdict.detail) console.log(`[run] validation detail:\n${verdict.detail}`);
      if (result.code !== 0 || !verdict.ok) allOk = false;
    }

    console.log(`\n[run] ${allOk ? "ALL CASES PASSED ✅" : "SOME CASES FAILED ❌"}`);
    process.exitCode = allOk ? 0 : 1;
  } finally {
    console.log("[run] stopping proxy…");
    proxy.kill("SIGTERM");
    await new Promise((r) => { proxy.once("exit", r); setTimeout(r, 5_000).unref?.(); });
  }
}

void main();
