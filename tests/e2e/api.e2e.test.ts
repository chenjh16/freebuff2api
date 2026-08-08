/**
 * tests/e2e/api.e2e.test.ts — API 端到端测试（真实上游）
 *
 * 启动真实的 freebuff2api 代理进程，通过 /v1 接口完成真实对话：
 *   - GET  /healthz              就绪状态
 *   - GET  /v1/models            模型列表
 *   - POST /v1/chat/completions  非流式 chat（要求模型回复 PONG）
 *   - POST /v1/chat/completions  流式 chat（SSE，含 [DONE]）
 *   - POST /v1/chat/completions  工具调用（tool_calls 两轮往返）
 *
 * 需要真实登录凭证（~/.config/freebuff2api/credentials.json）；缺失时自动跳过。
 * 运行：bun test ./tests/e2e/ --timeout 120000   （会消耗免费账号额度）
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The proxy surface accepts only the provider-namespaced id.
const MODEL = "freebuff/deepseek/deepseek-v4-flash";

function hasCredentials(): boolean {
  const path = join(homedir(), ".config", "freebuff2api", "credentials.json");
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { default?: { authToken?: string } };
    return typeof parsed.default?.authToken === "string" && parsed.default.authToken.length > 0;
  } catch {
    return false;
  }
}

const CREDS_OK = hasCredentials();

let proc: ReturnType<typeof Bun.spawn> | null = null;
let BASE = "";

async function startProxy(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 18100 + Math.floor(Math.random() * 100);
    proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, LISTEN_ADDR: `:${port}`, PORT: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break; // process died
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) });
        if (resp.ok) {
          ready = true;
          break;
        }
      } catch {
        // not ready yet
      }
      await Bun.sleep(1_000);
    }
    if (ready) {
      BASE = `http://127.0.0.1:${port}`;
      return;
    }
    proc.kill("SIGTERM");
    await proc.exited.catch(() => undefined);
  }
  throw new Error("proxy failed to become ready on any test port");
}

async function stopProxy(): Promise<void> {
  if (!proc) return;
  proc.kill("SIGTERM");
  await Promise.race([proc.exited.catch(() => undefined), Bun.sleep(10_000)]);
  proc = null;
}

function chatBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    ...overrides,
  };
}

async function chat(overrides: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(chatBody(overrides)),
  });
}

/** Parse an SSE body into an array of JSON payloads (excluding [DONE]). */
function parseSSE(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    out.push(JSON.parse(data) as Record<string, unknown>);
  }
  return out;
}

beforeAll(async () => {
  if (!CREDS_OK) return;
  await startProxy();
});

afterAll(async () => {
  await stopProxy();
});

describe.skipIf(!CREDS_OK)("API end-to-end (live Freebuff upstream)", () => {
  test("GET /healthz reports ready", async () => {
    const resp = await fetch(`${BASE}/healthz`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; started_at: string; uptime_sec: number; tokens?: unknown; models?: unknown };
    expect(body.ok).toBe(true);
    expect(body.started_at).toMatch(/T/);
    expect(body.uptime_sec).toBeGreaterThanOrEqual(0);
    expect(body.tokens).toBeUndefined();
    expect(body.models).toBeUndefined();
  });

  test("GET /v1/models includes the free flash model", async () => {
    const resp = await fetch(`${BASE}/v1/models`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { data: { id: string }[] };
    expect(body.data.map((m) => m.id)).toContain(MODEL);
  });

  test("non-streaming chat returns a real answer", async () => {
    const resp = await chat({});
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { choices: { message: { content: string } }[] };
    const content = body.choices[0]?.message?.content ?? "";
    expect(content).toMatch(/PONG/i);
  });

  test("streaming chat yields SSE chunks ending in [DONE]", async () => {
    const resp = await chat({ stream: true });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await resp.text();
    const chunks = parseSSE(text);
    expect(chunks.length).toBeGreaterThan(0);
    expect(text).toContain("data: [DONE]");
    const joined = chunks
      .map((c) => {
        const delta = (c.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content ?? "";
        return delta;
      })
      .join("");
    expect(joined).toMatch(/PONG/i);
  });

  test("tool call round trip: model calls get_weather, then answers with the result", async () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"],
          },
        },
      },
    ];

    // Round 1 — force a tool call.
    const first = await chat({
      tools,
      messages: [
        {
          role: "user",
          content:
            "You MUST call the get_weather tool for the city Tokyo now. Call the tool, then after receiving the result, report the temperature.",
        },
      ],
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      choices: {
        message: {
          role: string;
          content?: string;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
    };
    const message = firstJson.choices[0]?.message;
    expect(message.tool_calls, "expected the model to emit tool_calls").toBeDefined();
    expect(message.tool_calls!.length).toBeGreaterThanOrEqual(1);
    const toolCall = message.tool_calls![0]!;
    expect(toolCall.function.name).toBe("get_weather");

    // Round 2 — feed the tool result back and expect a final answer.
    const second = await chat({
      tools,
      messages: [
        {
          role: "user",
          content:
            "You MUST call the get_weather tool for the city Tokyo now. Call the tool, then after receiving the result, report the temperature.",
        },
        { role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls },
        { role: "tool", tool_call_id: toolCall.id, content: '{"city":"Tokyo","temp":25,"condition":"sunny"}' },
        { role: "user", content: "Report the temperature now." },
      ],
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { choices: { message: { content: string } }[] };
    const finalContent = secondJson.choices[0]?.message?.content ?? "";
    expect(finalContent).toMatch(/25|sunny|temp/i);
  });
});
