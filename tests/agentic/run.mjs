#!/usr/bin/env node
/**
 * tests/agentic/run.mjs — Agent 端到端测试运行器
 *
 * 支持两种模式：
 *   1. 一键模式：node tests/agentic/run.mjs opencode-demo
 *   2. 分阶段模式：check → prepare → start-proxy → run → validate → cleanup
 *
 * 分阶段模式专门用于受限的远程执行器，避免把长时间 opencode 任务和代理
 * 生命周期放进同一个命令请求。代理 PID、日志和配置恢复状态只写入系统
 * 临时目录，不写入仓库，不保存任何凭证。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CASES_DIR = join(__dirname, "cases");
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? join(homedir(), ".opencode", "bin", "opencode");
const OPENCODE_MODEL = process.env.OPENCODE_MODEL ?? "freebuff/deepseek/deepseek-v4-flash";
const OPENCODE_TIMEOUT_MS = positiveNumber(process.env.OPENCODE_TIMEOUT_MIN, 20) * 60_000;
const DEFAULT_PORT = positiveNumber(process.env.FB2API_PORT, 18080);
const CONTINUE = process.argv.includes("--continue");
const RUNNER_ID = createHash("sha1").update(ROOT).digest("hex").slice(0, 12);
const STATE_DIR = join(tmpdir(), `freebuff2api-agentic-${RUNNER_ID}`);
const STATE_FILE = join(STATE_DIR, "state.json");
const CONFIG_PATH = join(homedir(), ".config", "opencode", "config.json");
const BACKUP_PATH = join(STATE_DIR, "opencode-config.backup.json");
const PROXY_LOG = join(STATE_DIR, "proxy.log");
const PID_FILE = join(STATE_DIR, "proxy.pid");

const CASES = {
  "opencode-demo": {
    prompt: "请阅读本目录 README.md 完成任务：实现 fib.js（导出 fibonacci(n)，n>=0，f(0)=0, f(1)=1）与 fib.test.js（node:assert 至少 3 个断言）。禁止任何第三方依赖。完成后运行 node fib.test.js 确认全部通过，然后简要报告。",
    validate: async (dir) => {
      const result = await runCommand("node", ["fib.test.js"], { cwd: dir });
      return { ok: result.code === 0 && /All fib tests passed/.test(result.stdout), detail: result.stdout.trim() };
    },
  },
  "opencode-md2html": {
    prompt: "请阅读本目录 README.md 与 sample.md，按任务要求完成 Markdown→HTML 转换器：md2html.js（导出 md2html）、cli.js（node cli.js <file>）、test.js（node:assert 至少 8 个断言）。零第三方依赖。用 webfetch 工具抓取 https://example.com 确认网络。完成后运行 node test.js 与 node cli.js sample.md 验证，并简要总结。",
    validate: async (dir) => {
      const tests = await runCommand("node", ["test.js"], { cwd: dir });
      const cli = await runCommand("node", ["cli.js", "sample.md"], { cwd: dir });
      const hasTags = /<h1>/.test(cli.stdout) && /<ul>/.test(cli.stdout) && /<pre>/.test(cli.stdout) && /<a href=/.test(cli.stdout);
      return {
        ok: tests.code === 0 && /all \d+ assertions passed/i.test(tests.stdout) && hasTags,
        detail: `test.js: ${tests.stdout.trim()}\ncli.js tags: ${hasTags}`,
      };
    },
  },
};

function positiveNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function printHelp() {
  console.log(`Agentic E2E runner for freebuff2api

One-shot:
  node tests/agentic/run.mjs opencode-demo
  node tests/agentic/run.mjs opencode-md2html
  node tests/agentic/run.mjs all --port 18080

Resumable phases (recommended for remote/limited executors):
  node tests/agentic/run.mjs check
  node tests/agentic/run.mjs prepare --port 18080
  node tests/agentic/run.mjs start-proxy --port 18080
  node tests/agentic/run.mjs run opencode-demo
  node tests/agentic/run.mjs validate opencode-demo
  node tests/agentic/run.mjs cleanup

Options:
  --port <n>       proxy port (default: FB2API_PORT or 18080)
  --continue       pass --continue to opencode run

Environment:
  OPENCODE_BIN          opencode executable path
  OPENCODE_MODEL        model (default freebuff/deepseek/deepseek-v4-flash)
  OPENCODE_TIMEOUT_MIN  per-case timeout in minutes (default 20)
  OPENCODE_SKIP_MODELS_CHECK=1  skip the optional provider model check

Phases:
  check       verify bun, opencode, credentials and case files; no network call
  prepare     backup and configure opencode provider; state is stored in /tmp
  start-proxy start detached proxy and wait for /healthz
  run         run opencode for one case; proxy must already be running
  validate    independently validate generated artifacts; no model call
  cleanup     stop proxy and restore opencode config safely
  all/case    run the complete lifecycle in one process`);
}

function parseArgs(argv) {
  const positional = [];
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("--port must be an integer from 1 to 65535");
      port = value;
    } else if (arg === "--continue") {
      // Handled through the global CONTINUE constant for compatibility.
    } else if (arg === "--help" || arg === "-h") {
      return { command: "help", positional, port };
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? "all", positional: positional.slice(1), port };
}

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function hashFile(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function checkPrerequisites() {
  const problems = [];
  if (!existsSync(OPENCODE_BIN)) problems.push(`opencode not found: ${OPENCODE_BIN}`);
  if (!existsSync(join(homedir(), ".config", "freebuff2api", "credentials.json")) && !process.env.AUTH_TOKENS) {
    problems.push("no login credentials file and AUTH_TOKENS is not set");
  }
  if (!existsSync(join(ROOT, "package.json"))) problems.push("project package.json not found");
  for (const name of Object.keys(CASES)) {
    if (!existsSync(join(CASES_DIR, name, "README.md"))) problems.push(`case README missing: ${name}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[check] ${problem}`);
    return false;
  }
  console.log(`[check] OK: bun project, opencode ${OPENCODE_BIN}, ${Object.keys(CASES).length} cases`);
  return true;
}

function ensureOpencodeConfig(baseURL) {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const currentExists = existsSync(CONFIG_PATH);
  const currentText = currentExists ? readFileSync(CONFIG_PATH, "utf8") : "";
  if (!existsSync(BACKUP_PATH)) writeFileSync(BACKUP_PATH, currentText, "utf8");

  let config = {};
  if (currentText) {
    try {
      config = JSON.parse(currentText);
    } catch {
      throw new Error(`cannot parse existing opencode config: ${CONFIG_PATH}`);
    }
  }
  const provider = config.provider && typeof config.provider === "object" ? config.provider : {};
  const existingFreebuff = provider.freebuff && typeof provider.freebuff === "object" ? provider.freebuff : {};
  const existingOptions = existingFreebuff.options && typeof existingFreebuff.options === "object" ? existingFreebuff.options : {};
  provider.freebuff = {
    ...existingFreebuff,
    npm: existingFreebuff.npm ?? "@ai-sdk/openai-compatible",
    name: existingFreebuff.name ?? "Freebuff via freebuff2api",
    options: { ...existingOptions, baseURL, apiKey: "local" },
    models: {
      ...(existingFreebuff.models && typeof existingFreebuff.models === "object" ? existingFreebuff.models : {}),
      "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash (Free)" },
    },
  };
  config.provider = provider;
  config.model = config.model ?? OPENCODE_MODEL;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  saveState({ ...(readState() ?? {}), configPath: CONFIG_PATH, configExisted: currentExists, backupPath: BACKUP_PATH, generatedConfigHash: hashFile(CONFIG_PATH) });
  console.log(`[prepare] opencode provider ready at ${CONFIG_PATH}`);
}

async function restoreOpencodeConfig(state) {
  if (!state?.configPath || !state.backupPath || !existsSync(state.backupPath)) return;
  const currentHash = hashFile(state.configPath);
  if (currentHash !== state.generatedConfigHash) {
    console.warn(`[cleanup] config changed outside runner; leaving it untouched: ${state.configPath}`);
    return;
  }
  if (state.configExisted) writeFileSync(state.configPath, readFileSync(state.backupPath), "utf8");
  else if (existsSync(state.configPath)) unlinkSync(state.configPath);
  unlinkSync(state.backupPath);
  console.log(`[cleanup] restored opencode config: ${state.configPath}`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealthz(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return true;
    } catch {
      // proxy is still starting
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  return false;
}

async function startProxy(port) {
  const state = readState();
  if (state?.proxyPid && isProcessAlive(state.proxyPid)) {
    console.log(`[start-proxy] proxy already running on :${state.port}`);
    return state;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  const logFd = openSync(PROXY_LOG, "a");
  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, LISTEN_ADDR: `:${port}`, PORT: "" },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  if (!child.pid) throw new Error("proxy process did not provide a PID");
  writeFileSync(PID_FILE, String(child.pid) + "\n", "utf8");
  const nextState = { ...(state ?? {}), proxyPid: child.pid, port, baseURL: `http://127.0.0.1:${port}/v1`, proxyLog: PROXY_LOG };
  saveState(nextState);
  if (!(await waitForHealthz(`http://127.0.0.1:${port}/healthz`))) {
    console.error(`[start-proxy] proxy did not become ready; inspect ${PROXY_LOG}`);
    return nextState;
  }
  console.log(`[start-proxy] proxy ready: ${nextState.baseURL}`);
  return nextState;
}

async function stopProxy(state = readState()) {
  const pid = state?.proxyPid;
  if (pid && isProcessAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isProcessAlive(pid)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    if (isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  if (state?.proxyPid) console.log(`[cleanup] proxy stopped (pid ${state.proxyPid})`);
}

function runCommand(command, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => { stdout += data; process.stdout.write(data); });
    child.stderr?.on("data", (data) => { stderr += data; process.stderr.write(data); });
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, opts.timeoutMs) : null;
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? -1, signal, timedOut, stdout, stderr });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: -1, signal: null, timedOut, stdout, stderr: `${stderr}${error.message}` });
    });
  });
}

function resolveCase(name) {
  if (!CASES[name]) throw new Error(`unknown case "${name}"; valid: ${Object.keys(CASES).join(", ")}`);
  return join(CASES_DIR, name);
}

async function preparePhase(port) {
  if (!checkPrerequisites()) return false;
  ensureOpencodeConfig(`http://127.0.0.1:${port}/v1`);
  return true;
}

async function runPhase(name) {
  const dir = resolveCase(name);
  const state = readState();
  if (!state?.proxyPid || !isProcessAlive(state.proxyPid)) throw new Error("proxy is not running; execute start-proxy first");
  if (!existsSync(CONFIG_PATH)) throw new Error("opencode config is not prepared; execute prepare first");
  console.log(`[run] case ${name}; model ${OPENCODE_MODEL}`);
  const args = CONTINUE ? ["run", "--continue", "--model", OPENCODE_MODEL, "--auto", CASES[name].prompt] : ["run", "--model", OPENCODE_MODEL, "--auto", CASES[name].prompt];
  if (process.env.OPENCODE_SKIP_MODELS_CHECK !== "1") {
    const models = await runCommand(OPENCODE_BIN, ["models", "freebuff"], { timeoutMs: 90_000 });
    if (models.code !== 0) throw new Error(`opencode models check failed (exit ${models.code})`);
  }
  const result = await runCommand(OPENCODE_BIN, args, { cwd: dir, timeoutMs: OPENCODE_TIMEOUT_MS, env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } });
  if (result.timedOut) throw new Error(`opencode timed out after ${OPENCODE_TIMEOUT_MS / 60_000} minutes`);
  if (result.code !== 0) throw new Error(`opencode exited with code ${result.code}`);
  return true;
}

async function validatePhase(name) {
  const dir = resolveCase(name);
  const verdict = await CASES[name].validate(dir);
  console.log(`[validate] ${name}: ${verdict.ok ? "PASS" : "FAIL"}`);
  if (verdict.detail) console.log(verdict.detail);
  return verdict.ok;
}

async function cleanupPhase() {
  const state = readState();
  await stopProxy(state);
  await restoreOpencodeConfig(state);
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  console.log("[cleanup] complete");
}

async function oneShot(names, port) {
  if (!(await preparePhase(port))) return false;
  let state;
  try {
    state = await startProxy(port);
    let ok = true;
    for (const name of names) {
      await runPhase(name);
      ok = (await validatePhase(name)) && ok;
    }
    return ok;
  } finally {
    await stopProxy(state ?? readState());
    await restoreOpencodeConfig(readState());
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") return printHelp();
  if (parsed.command === "check") return process.exit(checkPrerequisites() ? 0 : 1);
  if (parsed.command === "prepare") return process.exit((await preparePhase(parsed.port)) ? 0 : 1);
  if (parsed.command === "start-proxy") {
    const state = await startProxy(parsed.port);
    return process.exit(state?.proxyPid && isProcessAlive(state.proxyPid) ? 0 : 1);
  }
  if (parsed.command === "cleanup" || parsed.command === "stop-proxy") return cleanupPhase();
  if (parsed.command === "run") {
    const name = parsed.positional[0] ?? "opencode-demo";
    await runPhase(name);
    return;
  }
  if (parsed.command === "validate") {
    const name = parsed.positional[0] ?? "opencode-demo";
    return process.exit((await validatePhase(name)) ? 0 : 1);
  }

  const names = parsed.command === "all" ? Object.keys(CASES) : [parsed.command];
  for (const name of names) resolveCase(name);
  return process.exit((await oneShot(names, parsed.port)) ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`[agentic] ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[agentic] state directory: ${STATE_DIR}`);
  process.exitCode = 1;
});
