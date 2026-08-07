#!/usr/bin/env node
/**
 * 端到端请求格式探索脚本（调试工具）
 *
 * 作用：直接用真实账号对上游 https://www.codebuff.com 跑一遍完整的
 * 请求链路（会话 → agent-runs → chat），并支持多种模式对比不同的
 * 请求头/body 变体，观察上游返回什么。
 *
 * 凭证来源：~/.config/freebuff2api/credentials.json（由 `freebuff2api login`
 * 生成），token 不会打印到日志。
 *
 * 用法：
 *   node tools/e2e-test.mjs            # baseline：普通 chat（会 403，见 docs/zh/04）
 *   node tools/e2e-test.mjs fullclone  # 复刻官方 CLI 完整流程（含 compact GET）
 *   node tools/e2e-test.mjs delete     # 仅删除当前会话
 *
 * 其他模式（切换 chat 的 UA/头）：official、compact-get、noactinguser、bunua
 *
 * 注意：会真实消耗免费额度；免费档每日约 6 次（deepseek-v4-flash）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://www.codebuff.com";
const creds = JSON.parse(readFileSync(join(homedir(), ".config", "freebuff2api", "credentials.json"), "utf8"));
const TOKEN = creds.default.authToken;
const USER_ID = creds.default.id;

const RUN_UA = "Bun/1.3.14";

async function main() {
  const mode = process.argv[2] ?? "baseline";
  console.log(`=== mode: ${mode} ===`);

  if (mode === "delete") {
    const del = await fetch(`${BASE}/api/v1/freebuff/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": RUN_UA, Accept: "*/*" },
    });
    console.log(`session DELETE -> ${del.status}: ${(await del.text()).slice(0, 200)}`);
    return;
  }

  // 1. Create session (official CLI shape: Authorization only; Bun adds UA + Accept */*)
  let resp = await fetch(`${BASE}/api/v1/freebuff/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": RUN_UA,
      Accept: "*/*",
      "x-freebuff-model": "deepseek/deepseek-v4-flash",
    },
    body: mode === "fullclone" ? undefined : "{}",
  });
  const sessionBody = await resp.json();
  console.log(`session POST -> ${resp.status}: ${JSON.stringify(sessionBody).slice(0, 300)}`);
  const instanceId = sessionBody.instanceId;

  if (mode === "fullclone") {
    // Exact replication of the captured official CLI request flow.
    // 2. compact GET poll
    resp = await fetch(`${BASE}/api/v1/freebuff/session`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": RUN_UA,
        Accept: "*/*",
        "x-freebuff-instance-id": instanceId,
        "x-freebuff-compact-session": "1",
      },
    });
    console.log(`session GET -> ${resp.status}`);

    resp = await fetch(`${BASE}/api/v1/agent-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": RUN_UA,
        Accept: "*/*",
        "x-freebuff-acting-user-id": USER_ID,
      },
      body: JSON.stringify({ action: "START", agentId: "base2-free-deepseek-flash", ancestorRunIds: [] }),
    });
    const rb = await resp.json();
    const rid = rb.runId;
    console.log(`agent-runs START -> ${resp.status}: ${rid}`);

    const body = {
      model: "deepseek/deepseek-v4-flash",
      stop: ["\"cb_easp\""],
      codebuff_metadata: {
        freebuff_instance_id: instanceId,
        trace_session_id: "trace-" + Math.random().toString(36).slice(2, 14),
        llm_step_number: "1",
        run_id: rid,
        client_id: Math.random().toString(36).slice(2, 13),
        cost_mode: "free",
      },
      provider: { data_collection: "deny" },
      messages: [
        { role: "system", content: "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.", cache_control: { type: "ephemeral" } },
        { role: "user", content: [{ type: "text", text: "<user_message>Reply with exactly: PONG</user_message>" }] },
      ],
      tools: [],
      tool_choice: "auto",
      stream: true,
    };
    resp = await fetch(`${BASE}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser",
        "x-freebuff-acting-user-id": USER_ID,
        Accept: "*/*",
      },
      body: JSON.stringify(body),
    });
    const t = await resp.text();
    console.log(`chat POST -> ${resp.status}`);
    console.log(`chat body -> ${t.slice(0, 400)}`);
    return;
  }

  if (mode === "compact-get" && instanceId) {
    // 2a. Compact GET like the CLI does while active.
    resp = await fetch(`${BASE}/api/v1/freebuff/session`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": RUN_UA,
        Accept: "*/*",
        "x-freebuff-instance-id": instanceId,
        "x-freebuff-compact-session": "1",
      },
    });
    const poll = await resp.json();
    console.log(`session compact GET -> ${resp.status}: ${JSON.stringify(poll).slice(0, 200)}`);
  }

  // 3. Start an agent run (official SDK shape)
  resp = await fetch(`${BASE}/api/v1/agent-runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": RUN_UA,
      "x-freebuff-acting-user-id": USER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "START", agentId: "base2-free-deepseek-flash" }),
  });
  const runBody = await resp.json();
  console.log(`agent-runs START -> ${resp.status}: ${JSON.stringify(runBody).slice(0, 200)}`);
  const runId = runBody.runId;

  // 4. Chat completions with variant headers/body
  const chatHeaders = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "x-freebuff-acting-user-id": USER_ID,
  };
  if (mode === "baseline") {
    chatHeaders["User-Agent"] = "ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";
    chatHeaders.Accept = "*/*";
  } else if (mode === "official") {
    chatHeaders["User-Agent"] = "ai-sdk/openai-compatible/1.0.0/codebuff";
    chatHeaders.Accept = "application/json";
  } else if (mode === "compact-get") {
    chatHeaders["User-Agent"] = "ai-sdk/openai-compatible/1.0.0/codebuff";
    chatHeaders.Accept = "*/*";
  } else if (mode === "noactinguser") {
    chatHeaders["User-Agent"] = "ai-sdk/openai-compatible/1.0.0/codebuff";
    chatHeaders.Accept = "*/*";
    delete chatHeaders["x-freebuff-acting-user-id"];
  } else if (mode === "bunua") {
    chatHeaders["User-Agent"] = "Bun/1.3.14";
    chatHeaders.Accept = "*/*";
  }

  const chatBody = {
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    max_tokens: 20,
    codebuff_metadata: {
      run_id: runId,
      client_id: "testclient123",
      cost_mode: "free",
      trace_session_id: "trace-" + Math.random().toString(36).slice(2, 10),
      llm_step_number: "1",
      freebuff_instance_id: instanceId,
    },
    provider: { data_collection: "deny" },
  };

  resp = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: chatHeaders,
    body: JSON.stringify(chatBody),
  });
  const text = await resp.text();
  console.log(`chat POST -> ${resp.status}`);
  console.log(`chat body -> ${text.slice(0, 600)}`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
