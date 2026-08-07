#!/usr/bin/env node
/**
 * 会话准入探针（调试工具）— 逐模型探测 Freebuff 上游的会话准入状态。
 *
 * 用途：在消耗 chat 额度之前，先确认某个模型当前能否被准入（session
 * admission），并观察"账户已持有另一个模型会话"时上游的真实响应。
 * 这正是一小时 session 固定模型约束下的关键诊断步骤。
 *
 * 凭证来源：~/.config/freebuff2api/credentials.json（由 `freebuff2api login`
 * 生成），token 不会打印到日志。
 *
 * 用法：
 *   node tools/probe-session.mjs --delete
 *       仅结束当前会话（释放账户上的 session 槽位）
 *   node tools/probe-session.mjs <model> --admit-only
 *       仅探测会话准入：POST /api/v1/freebuff/session（x-freebuff-model=<model>）
 *       —— 不消耗 chat 额度
 *   node tools/probe-session.mjs <model>
 *       全链路：session → agent-runs START → 最小 chat → FINISH → DELETE
 *       —— 消耗 1 次该模型的 chat 额度
 *
 * Agent 映射（与 src/models.ts 的 FALLBACK 一致；远程同步后取每个模型最
 * 专用的 base2-free-* agent）：
 *   openai/gpt-5.6-luna          -> base2-free-luna
 *   deepseek/deepseek-v4-flash   -> base2-free-deepseek-flash
 *   deepseek/deepseek-v4-pro     -> base2-free-deepseek
 *   minimax/minimax-m3           -> base2-free-minimax-m3
 *   mimo/mimo-v2.5               -> base2-free-mimo
 *   z-ai/glm-5.2                 -> base2-free-glm
 *   其他                         -> base2-free
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://www.codebuff.com";
const RUN_UA = "Bun/1.3.14";
const SDK_UA = "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";

const AGENT_FOR_MODEL = {
  "openai/gpt-5.6-luna": "base2-free-luna",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "z-ai/glm-5.2": "base2-free-glm",
};
const DEFAULT_AGENT = "base2-free";

function loadCreds() {
  const creds = JSON.parse(
    readFileSync(join(homedir(), ".config", "freebuff2api", "credentials.json"), "utf8"),
  );
  return { token: creds.default.authToken, userId: creds.default.id };
}

function summarize(status, body) {
  let out = body;
  try {
    const parsed = JSON.parse(body);
    // 只打印结构摘要，避免打印完整 prompt/会话内容
    out = JSON.stringify({
      ...parsed,
      instanceId: parsed.instanceId ? `${parsed.instanceId.slice(0, 8)}…` : undefined,
      ...(parsed.rateLimit ? { rateLimit: { model: parsed.rateLimit.model, limit: parsed.rateLimit.limit, period: parsed.rateLimit.period, recentCount: parsed.rateLimit.recentCount } } : {}),
      ...(parsed.rateLimitsByModel ? { rateLimitsByModel: Object.keys(parsed.rateLimitsByModel).slice(0, 5) } : {}),
      runId: parsed.runId ? `${parsed.runId.slice(0, 8)}…` : undefined,
    });
  } catch {
    // 非 JSON，保留原文（截断）
    out = body.slice(0, 300);
  }
  return `HTTP ${status} ${out}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--delete")) {
    const { token } = loadCreds();
    const del = await fetch(`${BASE}/api/v1/freebuff/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "User-Agent": RUN_UA, Accept: "*/*" },
    });
    console.log(`session DELETE -> ${del.status}: ${(await del.text()).slice(0, 200)}`);
    return;
  }

  const model = args.find((a) => a.startsWith("openai/") || a.startsWith("deepseek/") || a.startsWith("minimax/") || a.startsWith("mimo/") || a.startsWith("z-ai/") || a.startsWith("anthropic/") || a.startsWith("google/"));
  if (!model) {
    console.error("usage: node tools/probe-session.mjs <model> [--admit-only] | --delete");
    process.exit(1);
  }
  const admitOnly = args.includes("--admit-only");
  const { token, userId } = loadCreds();
  const agentId = AGENT_FOR_MODEL[model] ?? DEFAULT_AGENT;

  console.log(`=== probe model: ${model} (agent: ${agentId}${admitOnly ? ", admit-only" : ", full-chain"}) ===`);

  // 1. 会话准入（空 body + x-freebuff-model，与官方 CLI 一致）
  const sessionResp = await fetch(`${BASE}/api/v1/freebuff/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": RUN_UA,
      Accept: "*/*",
      "x-freebuff-model": model,
    },
    body: undefined,
  });
  const sessionBody = await sessionResp.text();
  console.log(`session POST (x-freebuff-model: ${model}) -> ${summarize(sessionResp.status, sessionBody)}`);
  if (admitOnly) return;

  let parsed;
  try {
    parsed = JSON.parse(sessionBody);
  } catch {
    console.error("session response is not JSON; aborting");
    return;
  }
  if (parsed.status !== "active") {
    console.log(`admission failed (status=${parsed.status}); skipping run/chat`);
    return;
  }
  const instanceId = parsed.instanceId;

  // 2. 启动 agent run
  const runResp = await fetch(`${BASE}/api/v1/agent-runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": RUN_UA,
      Accept: "*/*",
      "x-freebuff-acting-user-id": userId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "START", agentId, ancestorRunIds: [] }),
  });
  const runBody = await runResp.text();
  console.log(`agent-runs START (${agentId}) -> ${summarize(runResp.status, runBody)}`);
  let runId;
  try {
    runId = JSON.parse(runBody).runId;
  } catch {
    console.error("run response missing runId; aborting");
    return;
  }
  if (!runId) return;

  // 3. 最小 chat（不流式，节省解析成本）
  const chatBody = {
    model,
    messages: [
      { role: "system", content: "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free." },
      { role: "user", content: "Reply with exactly: MODEL_PROBE_OK" },
    ],
    codebuff_metadata: {
      run_id: runId,
      client_id: Math.random().toString(36).slice(2, 13),
      cost_mode: "free",
      trace_session_id: "trace-" + Math.random().toString(36).slice(2, 14),
      llm_step_number: "1",
      freebuff_instance_id: instanceId,
    },
    provider: { data_collection: "deny" },
    stream: false,
  };
  const started = Date.now();
  const chatResp = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": SDK_UA,
      "x-freebuff-acting-user-id": userId,
      Accept: "*/*",
    },
    body: JSON.stringify(chatBody),
  });
  const chatText = await chatResp.text();
  const ok = chatResp.status >= 200 && chatResp.status < 300;
  const content = ok
    ? JSON.parse(chatText)?.choices?.[0]?.message?.content ?? "<no content>"
    : chatText.slice(0, 200);
  console.log(`chat POST -> HTTP ${chatResp.status} in ${Date.now() - started}ms, content=${ok ? JSON.stringify(content.slice(0, 60)) : content}`);

  // 4. 结束 run + session（best-effort）
  await fetch(`${BASE}/api/v1/agent-runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": RUN_UA, "x-freebuff-acting-user-id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "FINISH", runId, status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 }),
  });
  await fetch(`${BASE}/api/v1/freebuff/session`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": RUN_UA, Accept: "*/*" },
  });
  console.log("run FINISH + session DELETE (best-effort) done");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
