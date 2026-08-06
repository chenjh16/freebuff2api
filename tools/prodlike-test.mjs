#!/usr/bin/env node
/**
 * 生产形状请求验证脚本（调试工具）
 *
 * 作用：模拟 freebuff2api 代理实际会发出的上游请求形状（前置 CLI 身份
 * system 标记 + 客户端自己的消息 + codebuff_metadata/provider 注入），
 * 分别以流式 / 非流式验证网关放行并拿到真实回复。
 *
 * 这与代理 src/server.ts 中 injectCliSystemMarker() 的行为一一对应，
 * 用于在改动注入逻辑后快速回归验证。
 *
 * 凭证来源：~/.config/freebuff2api/credentials.json
 *
 * 用法：
 *   node tools/prodlike-test.mjs    # 流式 + 非流式各一次（各耗 1 次免费额度）
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://www.codebuff.com";
const creds = JSON.parse(readFileSync(join(homedir(), ".config", "freebuff2api", "credentials.json"), "utf8"));
const TOKEN = creds.default.authToken;
const USER_ID = creds.default.id;
const MODEL = "deepseek/deepseek-v4-flash";
const AGENT = "base2-free-deepseek-flash";
const RUN_UA = "Bun/1.3.14";

// 与 src/server.ts 的 CLI_SYSTEM_MARKER 保持一致
const MARKER =
  "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";

async function doChat(stream) {
  // 1. session（代理发 body {}；官方 CLI 发空 body，二者均可）
  let r = await fetch(`${BASE}/api/v1/freebuff/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": RUN_UA, Accept: "*/*", "x-freebuff-model": MODEL, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(30000),
  });
  const sBody = await r.json();
  if (sBody.status !== "active") throw new Error(`session: ${JSON.stringify(sBody)}`);
  const instanceId = sBody.instanceId;

  // 2. run（代理发 ancestorRunIds: []，与官方 CLI 一致）
  r = await fetch(`${BASE}/api/v1/agent-runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": RUN_UA, Accept: "*/*", "x-freebuff-acting-user-id": USER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "START", agentId: AGENT, ancestorRunIds: [] }),
    signal: AbortSignal.timeout(30000),
  });
  const runId = (await r.json()).runId;

  // 3. chat — 代理注入后的形状（标记 + 客户端 system + 客户端 user 纯字符串）
  const body = {
    model: MODEL,
    codebuff_metadata: {
      run_id: runId,
      client_id: Math.random().toString(36).slice(2, 15),
      cost_mode: "free",
      trace_session_id: crypto.randomUUID(),
      llm_step_number: "1",
      freebuff_instance_id: instanceId,
    },
    provider: { data_collection: "deny" },
    messages: [
      { role: "system", content: MARKER + "\n\n" + "You are a helpful assistant." },
      { role: "user", content: "Reply with exactly: PONG" },
    ],
  };
  if (stream) body.stream = true;

  r = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser", "x-freebuff-acting-user-id": USER_ID, Accept: "*/*" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  let head = "";
  if (stream && r.body) {
    const reader = r.body.getReader();
    const { value } = await reader.read().catch(() => ({ value: undefined }));
    if (value) head = new TextDecoder().decode(value);
    r.body.cancel().catch(() => {});
  } else {
    head = (await r.text()).slice(0, 400);
  }
  console.log(`stream=${stream}: ${r.status} ${head.replace(/\n/g, " ").slice(0, 300)}`);

  // cleanup
  await fetch(`${BASE}/api/v1/agent-runs`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": RUN_UA, "Content-Type": "application/json" }, body: JSON.stringify({ action: "FINISH", runId, status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 }) }).catch(() => {});
  await fetch(`${BASE}/api/v1/freebuff/session`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": RUN_UA } }).catch(() => {});
}

await doChat(true);
await doChat(false);
console.log("DONE");
