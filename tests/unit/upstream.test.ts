import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { CLI_USER_AGENT, UpstreamClient, UpstreamError } from "../../src/upstream.ts";

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

const captured: CapturedRequest[] = [];
// Per-route handlers, overridable per test; keyed `${method} ${path}`.
const routes = new Map<string, (req: CapturedRequest) => { status: number; body: string; headers?: Record<string, string> }>();

function json(status: number, body: unknown, headers: Record<string, string> = {}): { status: number; body: string; headers: Record<string, string> } {
  return { status, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } };
}

let server: ReturnType<typeof createServer>;
let port = 0;
let client: UpstreamClient;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "").split("?")[0];
      const record: CapturedRequest = { method: req.method ?? "", path, headers: req.headers as Record<string, string>, body };
      captured.push(record);
      const handler = routes.get(`${record.method} ${path}`);
      const out = handler ? handler(record) : json(404, { error: "no route" });
      res.writeHead(out.status, out.headers ?? { "Content-Type": "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  client = new UpstreamClient({ baseURL: `http://127.0.0.1:${port}`, requestTimeoutMs: 5_000, userAgent: "test-ua" });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function setRoute(method: string, path: string, handler: (req: CapturedRequest) => { status: number; body: string; headers?: Record<string, string> }): void {
  routes.set(`${method} ${path}`, handler);
}

beforeAll(() => {
  // Default routes used by most tests.
  setRoute("POST", "/api/v1/freebuff/session", () => json(200, { status: "active", instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  setRoute("GET", "/api/v1/freebuff/session", () => json(200, { status: "active", instanceId: "inst-1" }));
  setRoute("DELETE", "/api/v1/freebuff/session", () => json(200, { status: "ended" }));
  setRoute("POST", "/api/v1/agent-runs", (req) => {
    const body = JSON.parse(req.body || "{}");
    if (body.action === "START") return json(200, { runId: "run-123" });
    return json(200, { status: "ok" });
  });
  setRoute("POST", "/api/v1/chat/completions", () => json(200, { id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "pong" } }] }));
});

describe("createOrRefreshSession", () => {
  test("returns the active session and sends the CLI wire shape", async () => {
    captured.length = 0;
    const session = await client.createOrRefreshSession("tok", { model: "deepseek/deepseek-v4-flash" });
    expect(session.status).toBe("active");
    expect(session.instanceId).toBe("inst-1");
    const req = captured[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v1/freebuff/session");
    expect(req.headers.authorization).toBe("Bearer tok");
    expect(req.headers["user-agent"]).toBe(CLI_USER_AGENT);
    expect(req.headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");
    expect(JSON.parse(req.body)).toEqual({});
  });

  test("maps 404 to status disabled", async () => {
    setRoute("POST", "/api/v1/freebuff/session", () => json(404, { status: "disabled" }));
    const session = await client.createOrRefreshSession("tok");
    expect(session).toEqual({ status: "disabled" });
  });

  test("passes through 403 country_blocked / banned", async () => {
    setRoute("POST", "/api/v1/freebuff/session", () => json(403, { status: "country_blocked" }));
    const session = await client.createOrRefreshSession("tok");
    expect(session.status).toBe("country_blocked");
  });

  test("throws UpstreamError with retryAfterMs on 429 + Retry-After", async () => {
    setRoute("POST", "/api/v1/freebuff/session", () => json(429, { status: "rate_limited" }, { "Retry-After": "120" }));
    const error = await client.createOrRefreshSession("tok").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).statusCode).toBe(429);
    expect((error as UpstreamError).retryAfterMs).toBe(120_000);
  });

  test("throws UpstreamError on other non-2xx", async () => {
    setRoute("POST", "/api/v1/freebuff/session", () => json(500, { message: "boom" }));
    const error = await client.createOrRefreshSession("tok").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).statusCode).toBe(500);
    expect((error as UpstreamError).errorCode).toBe("boom");
  });

  test("throws when the response is not JSON", async () => {
    setRoute("POST", "/api/v1/freebuff/session", () => ({ status: 200, body: "definitely not json" }));
    const error = await client.createOrRefreshSession("tok").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
  });
});

describe("getSession / endSession", () => {
  test("polls with the instance id header", async () => {
    captured.length = 0;
    const session = await client.getSession("tok", "inst-9");
    expect(session.instanceId).toBe("inst-1");
    expect(captured[0].method).toBe("GET");
    expect(captured[0].headers["x-freebuff-instance-id"]).toBe("inst-9");
  });

  test("endSession tolerates 404", async () => {
    setRoute("DELETE", "/api/v1/freebuff/session", () => json(404, { status: "disabled" }));
    await expect(client.endSession("tok")).resolves.toBeUndefined();
  });

  test("endSession throws on 500", async () => {
    setRoute("DELETE", "/api/v1/freebuff/session", () => json(500, {}));
    const error = await client.endSession("tok").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
  });
});

describe("startRun / finishRun", () => {
  test("starts a run with the official START shape", async () => {
    captured.length = 0;
    const runId = await client.startRun("tok", "base2-free-deepseek-flash");
    expect(runId).toBe("run-123");
    const req = captured[0];
    expect(req.path).toBe("/api/v1/agent-runs");
    expect(req.headers["user-agent"]).toBe(CLI_USER_AGENT);
    expect(JSON.parse(req.body)).toEqual({ action: "START", agentId: "base2-free-deepseek-flash", ancestorRunIds: [] });
  });

  test("throws on run start failure", async () => {
    setRoute("POST", "/api/v1/agent-runs", () => json(500, { message: "no credits" }));
    const error = await client.startRun("tok", "agent").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).statusCode).toBe(500);
  });

  test("throws on invalid run start response JSON", async () => {
    setRoute("POST", "/api/v1/agent-runs", () => ({ status: 200, body: "not json" }));
    const error = await client.startRun("tok", "agent").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(String(error)).toContain("invalid JSON");
  });

  test("throws when runId is missing", async () => {
    setRoute("POST", "/api/v1/agent-runs", () => json(200, { ok: true }));
    const error = await client.startRun("tok", "agent").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(String(error)).toContain("missing runId");
  });

  test("finishRun never throws (best-effort)", async () => {
    setRoute("POST", "/api/v1/agent-runs", () => json(500, {}));
    await expect(client.finishRun("tok", "run-123")).resolves.toBeUndefined();
  });
});

describe("chatCompletions", () => {
  test("proxies the request with the SDK user-agent and Accept */*", async () => {
    captured.length = 0;
    const body = JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
    const resp = await client.chatCompletions("tok", body);
    expect(resp.status).toBe(200);
    const req = captured[0];
    expect(req.path).toBe("/api/v1/chat/completions");
    expect(req.headers["user-agent"]).toBe("test-ua");
    expect(req.headers.accept).toBe("*/*");
    expect(req.body).toBe(body);
  });

  test("returns non-2xx responses as-is for caller inspection", async () => {
    setRoute("POST", "/api/v1/chat/completions", () => json(429, { error: { code: "rate_limited" } }));
    const resp = await client.chatCompletions("tok", "{}");
    expect(resp.status).toBe(429);
    const parsed = (await resp.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("rate_limited");
  });
});
