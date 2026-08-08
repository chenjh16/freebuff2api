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
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CASES_DIR = join(__dirname, "cases");
// Agent tasks run in a scratch copy of the case directory OUTSIDE the git
// repository. opencode (>= 1.18) normalizes its workspace to the nearest git
// root, so running inside tests/agentic/cases would make the model write into
// the repo root instead of the case dir (verified 2026-08-08). A temp copy has
// no git root, so the workspace is exactly the case dir and validation checks
// the files opencode actually produced.
function prepareScratch(name) {
  const scratch = join(SCRATCH_BASE, name);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(dirname(scratch), { recursive: true });
  cpSync(join(CASES_DIR, name), scratch, { recursive: true });
  // AGENTIC_FRESH=1 removes the reference artifacts so opencode must create
  // them from scratch (stronger proof that the model can write code), keeping
  // only the task description (README.md) and any input data (sample.md).
  if (process.env.AGENTIC_FRESH === "1") {
    for (const entry of readdirSync(scratch)) {
      if (entry !== "README.md" && entry !== "sample.md") unlinkSync(join(scratch, entry));
    }
  }
  return scratch;
}
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? join(homedir(), ".opencode", "bin", "opencode");
// The proxy surface accepts only provider-namespaced ids, so the default model
// is `freebuff/freebuff/deepseek/deepseek-v4-flash`: the first segment is
// opencode's provider label and everything after it
// (`freebuff/deepseek/deepseek-v4-flash`) is what opencode sends to the proxy.
const OPENCODE_MODEL = process.env.OPENCODE_MODEL ?? "freebuff/freebuff/deepseek/deepseek-v4-flash";

/** Provider-namespaced ids of the default public (no-auth) channel models. When
 * the model id the proxy receives resolves to one of these, no login
 * credentials are required: the proxy routes the request to the fixed public
 * upstream without any token. */
const PUBLIC_MODEL_IDS = new Set([
  // OpenCode Zen
  "opencode/big-pickle", "opencode/deepseek-v4-flash-free", "opencode/mimo-v2.5-free", "opencode/nemotron-3-ultra-free",
  // Pollinations chat
  "pollinations/openai", "pollinations/openai-fast", "pollinations/openai-large", "pollinations/qwen-coder", "pollinations/mistral", "pollinations/deepseek", "pollinations/grok", "pollinations/perplexity-fast",
  // Pollinations image (chat id of the image models is not used here)
  "pollinations/flux", "pollinations/turbo", "pollinations/zimage",
  // Felo
  "felo/felo-chat", "felo/felo-search", "felo/felo-scholar", "felo/felo-social", "felo/felo-document",
]);

/** The model id opencode sends to the proxy: everything after the first `/` of
 * the `--model` value (opencode provider label stripped). */
function modelIdOf(model) {
  return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}

/** True when the model id the proxy receives is a public (no-auth) channel model. */
function isPublicModel(model) {
  return PUBLIC_MODEL_IDS.has(modelIdOf(model));
}
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
const SCRATCH_BASE = join(STATE_DIR, "work");

const CASES = {
  "opencode-demo": {
    prompt: "请阅读本目录 README.md 完成任务：实现 fib.js（导出 fibonacci(n)，n>=0，f(0)=0, f(1)=1）与 fib.test.js（node:assert 至少 3 个断言）。禁止任何第三方依赖。完成后运行 node fib.test.js 确认全部通过，然后简要报告。",
    validate: async (dir) => {
      const result = await runCommand("node", ["fib.test.js"], { cwd: dir });
      // Accept any pass-like output: the model may phrase the success line
      // differently ("all assertions passed") than the reference run
      // ("All fib tests passed").
      const ok = result.code === 0 && /all .*assertions passed|All fib tests passed/i.test(result.stdout);
      return { ok, detail: result.stdout.trim() };
    },
  },
  "opencode-md2html": {
    prompt: "请阅读本目录 README.md 与 sample.md，按任务要求完成 Markdown→HTML 转换器：md2html.js（导出 md2html）、cli.js（node cli.js <file>）、test.js（node:assert 至少 8 个断言）。零第三方依赖。用 webfetch 工具抓取 https://example.com 确认网络。完成后运行 node test.js 与 node cli.js sample.md 验证，并简要总结。",
    validate: async (dir) => {
      const tests = await runCommand("node", ["test.js"], { cwd: dir });
      const cli = await runCommand("node", ["cli.js", "sample.md"], { cwd: dir });
      const hasTags = /<h1>/.test(cli.stdout) && /<ul>/.test(cli.stdout) && /<pre>/.test(cli.stdout) && /<a href=/.test(cli.stdout);
      // Accept any pass-like output (e.g. "✓ 11 tests, 11 assertions passed"
      // or "all 10 assertions passed"); the essential contract is exit 0 with
      // a "passed" line plus the required HTML tags.
      return {
        ok: tests.code === 0 && /passed/i.test(tests.stdout) && hasTags,
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
  OPENCODE_MODEL        model passed to opencode as <opencode-provider>/<proxy-id>
                        (default freebuff/freebuff/deepseek/deepseek-v4-flash; the
                        proxy receives freebuff/deepseek/deepseek-v4-flash). Public
                        no-auth channel models (e.g.
                        freebuff/opencode/deepseek-v4-flash-free,
                        freebuff/pollinations/openai, freebuff/felo/felo-chat)
                        need no login credentials; the proxy routes them without
                        any token.
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
  if (!isPublicModel(OPENCODE_MODEL) && !existsSync(join(homedir(), ".config", "freebuff2api", "credentials.json")) && !process.env.AUTH_TOKENS) {
    problems.push("no login credentials file and AUTH_TOKENS is not set (and the selected model is not a public no-auth model)");
  }
  if (!existsSync(join(ROOT, "package.json"))) problems.push("project package.json not found");
  for (const name of Object.keys(CASES)) {
    if (!existsSync(join(CASES_DIR, name, "README.md"))) problems.push(`case README missing: ${name}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[check] ${problem}`);
    return false;
  }
  console.log(`[check] OK: bun project, opencode ${OPENCODE_BIN}, ${Object.keys(CASES).length} cases, model ${OPENCODE_MODEL}${isPublicModel(OPENCODE_MODEL) ? " (public, no login required)" : ""}`);
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
  const modelId = modelIdOf(OPENCODE_MODEL);
  provider.freebuff = {
    ...existingFreebuff,
    npm: existingFreebuff.npm ?? "@ai-sdk/openai-compatible",
    name: existingFreebuff.name ?? "Freebuff via freebuff2api",
    options: { ...existingOptions, baseURL, apiKey: "local" },
    models: {
      ...(existingFreebuff.models && typeof existingFreebuff.models === "object" ? existingFreebuff.models : {}),
      [modelId]: { name: `${modelId} via freebuff2api` },
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
    // stdio stdin must be "ignore": with the default open pipe, opencode hangs
    // at session init waiting on stdin (verified 2026-08-08; closing stdin with
    // </dev/null makes the identical command run to completion).
    // PWD must match the child cwd: node's spawn changes the working directory
    // but leaves the inherited PWD env var stale, and opencode resolves its
    // workspace from PWD — with a stale PWD it re-points the session at the
    // previous project (verified 2026-08-08: from a /tmp scratch it re-created
    // the instance at /home/daytona/codebase and wrote there).
    const child = spawn(command, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env, PWD: opts.cwd ?? ROOT }, stdio: ["ignore", "pipe", "pipe"] });
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
  resolveCase(name);
  const state = readState();
  if (!state?.proxyPid || !isProcessAlive(state.proxyPid)) throw new Error("proxy is not running; execute start-proxy first");
  if (!existsSync(CONFIG_PATH)) throw new Error("opencode config is not prepared; execute prepare first");
  const workDir = prepareScratch(name);
  saveState({ ...state, work: { ...(state?.work ?? {}), [name]: workDir } });
  console.log(`[run] case ${name}; model ${OPENCODE_MODEL}; work ${workDir}`);
  // --print-logs keeps opencode in plain-log mode instead of the TUI, which is
  // required under a non-TTY pipe (the TUI hangs at init there).
  const args = CONTINUE ? ["run", "--continue", "--model", OPENCODE_MODEL, "--auto", "--print-logs", CASES[name].prompt] : ["run", "--model", OPENCODE_MODEL, "--auto", "--print-logs", CASES[name].prompt];
  if (process.env.OPENCODE_SKIP_MODELS_CHECK !== "1") {
    const models = await runCommand(OPENCODE_BIN, ["models", "freebuff"], { timeoutMs: 90_000 });
    if (models.code !== 0) throw new Error(`opencode models check failed (exit ${models.code})`);
  }
  const result = await runCommand(OPENCODE_BIN, args, { cwd: workDir, timeoutMs: OPENCODE_TIMEOUT_MS, env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } });
  if (result.timedOut) throw new Error(`opencode timed out after ${OPENCODE_TIMEOUT_MS / 60_000} minutes`);
  if (result.code !== 0) throw new Error(`opencode exited with code ${result.code}`);
  return true;
}

async function validatePhase(name) {
  const state = readState();
  const workDir = state?.work?.[name];
  if (!workDir || !existsSync(workDir)) throw new Error("case work dir missing; execute the run phase first");
  const verdict = await CASES[name].validate(workDir);
  console.log(`[validate] ${name}: ${verdict.ok ? "PASS" : "FAIL"}`);
  if (verdict.detail) console.log(verdict.detail);
  return verdict.ok;
}

async function cleanupPhase() {
  const state = readState();
  await stopProxy(state);
  await restoreOpencodeConfig(state);
  rmSync(SCRATCH_BASE, { recursive: true, force: true });
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
    rmSync(SCRATCH_BASE, { recursive: true, force: true });
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
