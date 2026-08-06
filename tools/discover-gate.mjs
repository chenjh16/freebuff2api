#!/usr/bin/env node
/**
 * 免费模式网关二分探索脚本（调试工具）— 破解 free_mode_cli_required 的工具
 *
 * 作用：对 /api/v1/chat/completions 的请求体做"逐个字段关掉"的变体测试，
 * 观察上游网关（403 free_mode_cli_required）放行还是拒绝，从而确定哪些
 * 字段是必需的。结论见 docs/04-请求格式破解.md。
 *
 * 依赖捕获产物（仓库内）：
 *   tools/captured/chatbody-official.json   官方 CLI 成功请求的完整 body
 *   tools/captured/agentdefs-full.json      官方 CLI 发送的 Agent 定义
 *
 * 凭证来源：~/.config/freebuff2api/credentials.json
 *
 * 用法：
 *   node tools/discover-gate.mjs exact      # 完整复刻官方请求（应 200）
 *   node tools/discover-gate.mjs nosystem   # 去掉 system 消息（应 403）
 *   node tools/discover-gate.mjs all        # 跑全部变体（耗额度较多）
 *   可用变体：exact / nosystem / notools / nostop / noprovider / mint /
 *             shortbuffy / buffyname / freebuffonly / buffyfb / firstsent /
 *             climarker / ourua / all
 *
 * 注意：每个变体都会真实消耗免费额度（每日约 6 次），请按需使用。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURED = join(__dirname, "captured");

const BASE = "https://www.codebuff.com";
const creds = JSON.parse(readFileSync(join(homedir(), ".config", "freebuff2api", "credentials.json"), "utf8"));
const TOKEN = creds.default.authToken;
const USER_ID = creds.default.id;

const MODEL = "deepseek/deepseek-v4-flash";
const AGENT = "base2-free-deepseek-flash";
const RUN_UA = "Bun/1.3.14";
const CLI_UA = "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";

const captured = JSON.parse(readFileSync(join(CAPTURED, "chatbody-official.json"), "utf8"));

async function req(label, method, path, { token = TOKEN, headers = {}, body, earlyCancel = false } = {}) {
  const h = { "User-Agent": RUN_UA, Accept: "*/*", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const opts = { method, headers: h };
  if (body !== undefined) {
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!h["Content-Type"]) h["Content-Type"] = "application/json";
  }
  const r = await fetch(`${BASE}${path}`, { ...opts, signal: AbortSignal.timeout(90000) });
  let text = "";
  if (earlyCancel && r.body) {
    // Read just the first SSE chunk to confirm a live stream, then abort.
    const reader = r.body.getReader();
    try {
      const { value } = await reader.read();
      if (value) text = new TextDecoder().decode(value);
    } catch {}
    reader.releaseLock();
    r.body.cancel().catch(() => {});
  } else {
    text = await r.text();
  }
  const head = text.slice(0, 400).replace(/\n/g, " ");
  console.log(`${label}: ${r.status} ${head}`);
  return { status: r.status, text, headers: r.headers };
}

async function sessionCreate() {
  const r = await req("session POST", "POST", "/api/v1/freebuff/session", {
    headers: { "x-freebuff-model": MODEL },
  });
  let id = null;
  try { const p = JSON.parse(r.text); if (p.status === "active") id = p.instanceId; } catch {}
  return id;
}

async function runStart() {
  const r = await req("run START", "POST", "/api/v1/agent-runs", {
    headers: { "x-freebuff-acting-user-id": USER_ID },
    body: { action: "START", agentId: AGENT, ancestorRunIds: [] },
  });
  let runId = null;
  try { runId = JSON.parse(r.text).runId; } catch {}
  return runId;
}

function buildChatBody(instanceId, runId, opts) {
  const { includeSystem, includeTools, includeStop, includeProvider, systemStyle } = opts;
  const messages = [];
  if (includeSystem) {
    let content = captured.messages[0].content;
    if (systemStyle === "minimal") {
      content = "You are a helpful assistant.";
    } else if (systemStyle === "short-buffy") {
      content = "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";
    } else if (systemStyle === "buffy-name") {
      content = "You are Buffy.";
    } else if (systemStyle === "freebuff-only") {
      content = "You are an AI assistant for the product Freebuff.";
    } else if (systemStyle === "buffy-freebuff-name") {
      content = "You are Buffy. You are the AI agent behind the product Freebuff.";
    } else if (systemStyle === "first-sentence") {
      content = "You are Buffy, the strategic coding assistant.";
    } else if (systemStyle === "codebuff-cli") {
      content = "You are the official freebuff CLI coding assistant.";
    }
    messages.push({ role: "system", content, cache_control: { type: "ephemeral" } });
  }
  messages.push({ role: "user", content: [{ type: "text", text: "<user_message>Reply with exactly: PONG</user_message>" }] });

  const body = {
    model: MODEL,
    codebuff_metadata: {
      freebuff_instance_id: instanceId,
      trace_session_id: crypto.randomUUID(),
      llm_step_number: "1",
      run_id: runId,
      client_id: Math.random().toString(36).slice(2, 15),
      cost_mode: "free",
    },
    messages,
    stream: true,
  };
  if (includeStop) body.stop = ['"cb_easp"'];
  if (includeProvider) body.provider = { data_collection: "deny" };
  if (includeTools) body.tools = captured.tools;
  return body;
}

async function chat(instanceId, runId, opts, ua = CLI_UA) {
  const body = buildChatBody(instanceId, runId, opts);
  return req(`chat ${opts.label}`, "POST", "/api/v1/chat/completions", {
    headers: { "x-freebuff-acting-user-id": USER_ID, "User-Agent": ua },
    body,
    earlyCancel: true,
  });
}

async function cleanup(runId) {
  await req("run FINISH", "POST", "/api/v1/agent-runs", {
    body: { action: "FINISH", runId, status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 },
  }).catch(() => {});
  await req("session DELETE", "DELETE", "/api/v1/freebuff/session").catch(() => {});
}

async function runVariant(label, opts, ua) {
  console.log(`\n########## ${label} ##########`);
  const instanceId = await sessionCreate();
  if (!instanceId) { console.log("!! no session"); return; }
  const runId = await runStart();
  if (!runId) { console.log("!! no run"); await cleanup(); return; }
  const result = await chat(instanceId, runId, { ...opts, label }, ua);
  const ok = result.status >= 200 && result.status < 300;
  console.log(`>> ${label} => ${result.status} ${ok ? "SUCCESS" : ""}`);
  await cleanup(runId);
}

const mode = process.argv[2] ?? "exact";
const variants = {
  exact: [{ label: "EXACT-FULL", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true }, ua: CLI_UA }],
  nosystem: [{ label: "NO-SYSTEM", opts: { includeSystem: false, includeTools: true, includeStop: true, includeProvider: true }, ua: CLI_UA }],
  notools: [{ label: "NO-TOOLS", opts: { includeSystem: true, includeTools: false, includeStop: true, includeProvider: true }, ua: CLI_UA }],
  nostop: [{ label: "NO-STOP", opts: { includeSystem: true, includeTools: true, includeStop: false, includeProvider: true }, ua: CLI_UA }],
  noprovider: [{ label: "NO-PROVIDER", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: false }, ua: CLI_UA }],
  mint: [{ label: "MINIMAL-FULL", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true, systemStyle: "minimal" }, ua: CLI_UA }],
  shortbuffy: [{ label: "SHORT-BUFFY", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true, systemStyle: "short-buffy" }, ua: CLI_UA }],
  buffyname: [{ label: "BUFFY-NAME", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true, systemStyle: "buffy-name" }, ua: CLI_UA }],
  freebuffonly: [{ label: "FREEBUFF-ONLY", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true, systemStyle: "freebuff-only" }, ua: CLI_UA }],
  buffyfb: [{ label: "BUFFY+FREEBUFF", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true, systemStyle: "buffy-freebuff-name" }, ua: CLI_UA }],
  firstsent: [{ label: "FIRST-SENTENCE", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true, systemStyle: "first-sentence" }, ua: CLI_UA }],
  climarker: [{ label: "CLI-MARKER", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true, systemStyle: "codebuff-cli" }, ua: CLI_UA }],
  ourua: [{ label: "EXACT-OUR-UA", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true }, ua: "ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser" }],
  all: [
    { label: "EXACT-FULL", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true }, ua: CLI_UA },
    { label: "MINIMAL-FULL", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true, systemStyle: "minimal" }, ua: CLI_UA },
    { label: "SHORT-BUFFY", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true, systemStyle: "short-buffy" }, ua: CLI_UA },
    { label: "NO-SYSTEM", opts: { includeSystem: false, includeTools: true, includeStop: true, includeProvider: true }, ua: CLI_UA },
    { label: "NO-TOOLS", opts: { includeSystem: true, includeTools: false, includeStop: true, includeProvider: true }, ua: CLI_UA },
    { label: "NO-STOP", opts: { includeSystem: true, includeTools: true, includeStop: false, includeProvider: true }, ua: CLI_UA },
    { label: "NO-PROVIDER", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: false }, ua: CLI_UA },
    { label: "EXACT-OUR-UA", opts: { includeSystem: true, includeTools: true, includeStop: true, includeProvider: true }, ua: "ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser" },
  ],
};

const list = variants[mode] ?? variants.all;
for (const v of list) {
  await runVariant(v.label, v.opts, v.ua);
}
console.log("\nDONE");
