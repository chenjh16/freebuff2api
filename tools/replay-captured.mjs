#!/usr/bin/env node
/**
 * 捕获请求重放脚本（调试工具）
 *
 * 作用：用最新鲜的 session + run + instance id 重放官方 CLI 的完整
 * 捕获请求体（tools/captured/chatbody-official.json），并支持多种系统
 * 提示变体，观察网关放行还是拒绝。它是 discover-gate.mjs 的前身，
 * 保留了更细粒度的 system 提示编辑能力。
 *
 * 凭证来源：~/.config/freebuff2api/credentials.json
 *
 * 用法：
 *   node tools/replay-captured.mjs             # exact：原样重放
 *   node tools/replay-captured.mjs <变体>      # 见下方列表
 *
 * 变体：notools / shortsys / noseconduser / plaincontent / nouserwrapper /
 *       nocache / pref3000 / pref800 / firstsentence / buffymarker /
 *       nameonly / sent1part2 / sent1exact / casechange
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE = "https://www.codebuff.com";
const creds = JSON.parse(readFileSync(join(homedir(), ".config", "freebuff2api", "credentials.json"), "utf8"));
const TOKEN = creds.default.authToken;
const USER_ID = creds.default.id;
const RUN_UA = "Bun/1.3.14";

async function main() {
  // 1. session POST（官方 CLI 形状：无 body + x-freebuff-model）
  let resp = await fetch(`${BASE}/api/v1/freebuff/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": RUN_UA,
      Accept: "*/*",
      "x-freebuff-model": "deepseek/deepseek-v4-flash",
    },
  });
  const sess = await resp.json();
  console.log(`session POST -> ${resp.status}`);
  const instanceId = sess.instanceId;
  console.log(`instance: ${instanceId}`);

  // 2. compact GET
  await fetch(`${BASE}/api/v1/freebuff/session`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": RUN_UA,
      Accept: "*/*",
      "x-freebuff-instance-id": instanceId,
      "x-freebuff-compact-session": "1",
    },
  });

  // 3. run START
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
  const runId = rb.runId;
  console.log(`run START -> ${resp.status}: ${runId}`);

  const mode = process.argv[2] ?? "exact";

  // 4. chat with the captured body, ids swapped
  let body = readFileSync(join(__dirname, "captured", "chatbody-official.json"), "utf8");
  if (mode !== "exact") {
    const parsed = JSON.parse(body);
    if (mode === "notools") {
      parsed.tools = [];
      console.log("[variant] tools=[]");
    } else if (mode === "shortsys") {
      for (const m of parsed.messages) {
        if (m.role === "system" && typeof m.content === "string") m.content = "You are a helpful assistant.";
      }
      console.log("[variant] short system prompt");
    } else if (mode === "noseconduser") {
      parsed.messages = parsed.messages.filter((m, i) => !(m.role === "user" && i > 0 && typeof m.content === "string" && m.content.length > 100));
      console.log("[variant] dropped second user message");
    } else if (mode === "plaincontent") {
      for (const m of parsed.messages) {
        if (m.role === "user" && Array.isArray(m.content) && m.content.length === 1 && m.content[0].type === "text") {
          m.content = m.content[0].text;
        }
      }
      console.log("[variant] plain string user content");
    } else if (mode === "nouserwrapper") {
      for (const m of parsed.messages) {
        if (m.role === "user" && Array.isArray(m.content)) {
          m.content = m.content.map((p) => ({ ...p, text: p.text.replace(/<user_message>/g, "").replace(/<\/user_message>/g, "") }));
        }
      }
      console.log("[variant] stripped <user_message> wrapper");
    } else if (mode === "nocache") {
      for (const m of parsed.messages) delete m.cache_control;
      console.log("[variant] no cache_control");
    } else if (mode === "pref3000") {
      for (const m of parsed.messages) {
        if (m.role === "system" && typeof m.content === "string" && m.content.length > 3000) m.content = m.content.slice(0, 3000);
      }
      console.log("[variant] system=first 3000 chars");
    } else if (mode === "pref800") {
      for (const m of parsed.messages) {
        if (m.role === "system" && typeof m.content === "string" && m.content.length > 800) m.content = m.content.slice(0, 800);
      }
      console.log("[variant] system=first 800 chars");
    } else if (mode === "firstsentence") {
      for (const m of parsed.messages) {
        if (m.role === "system" && typeof m.content === "string") m.content = "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";
      }
      console.log("[variant] system=first sentence");
    } else if (mode === "buffymarker") {
      for (const m of parsed.messages) {
        if (m.role === "system" && typeof m.content === "string") m.content = "You are Buffy, the strategic coding assistant for the Freebuff product. Free mode is only available through the freebuff CLI.";
      }
      console.log("[variant] system=short with Buffy/Freebuff markers");
    } else if (mode === "nameonly") {
      for (const m of parsed.messages) {
        if (m.role === "system" && typeof m.content === "string") m.content = "You are Buffy, the strategic coding assistant.";
      }
      console.log("[variant] system=name only");
    } else if (mode === "sent1part2") {
      for (const m of parsed.messages) {
        if (m.role === "system" && typeof m.content === "string") m.content = "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff";
      }
      console.log("[variant] system=first 1.5 sentences");
    } else if (mode === "sent1exact") {
      for (const m of parsed.messages) {
        if (m.role === "system" && typeof m.content === "string") m.content = "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";
      }
      console.log("[variant] system=exact first sentence");
    } else if (mode === "casechange") {
      for (const m of parsed.messages) {
        if (m.role === "system" && typeof m.content === "string") m.content = "you are buffy, the strategic coding assistant. you are the ai agent behind the product, freebuff, a tool where users can chat with you to code with ai for free.";
      }
      console.log("[variant] system=first sentence lowercased");
    }
    body = JSON.stringify(parsed);
  }
  body = body.replace(/38fc5803-c5ee-42bd-967c-0f20302ae755/g, instanceId);
  body = body.replace(/0e5f7f91-aa09-44f2-829d-aef3e0aed0df/g, runId);
  body = body.replace(/"dyijxga7r1e"/, JSON.stringify(Math.random().toString(36).slice(2, 13)));
  body = body.replace(/45c18466-5100-44e8-9e13-293a979c317d/g, crypto.randomUUID());

  resp = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser",
      "x-freebuff-acting-user-id": USER_ID,
      Accept: "*/*",
    },
    body,
  });
  const t = await resp.text();
  console.log(`chat POST -> ${resp.status}`);
  console.log(`chat body -> ${t.slice(0, 500)}`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
