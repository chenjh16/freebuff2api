import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Config } from "../../src/config.ts";
import type { ModelRegistry } from "../../src/models.ts";
import type { RunManager } from "../../src/runs.ts";
import { Server } from "../../src/server.ts";
import { WaitingRoomError, type TokenManager } from "../../src/session.ts";
import { UpstreamError, type UpstreamClient } from "../../src/upstream.ts";

const MARKER_PHRASE = "You are Buffy, the strategic coding assistant";
const MODEL = "deepseek/deepseek-v4-flash";

interface FullHarness {
  base: string;
  bodies: string[];
  tokensUsed: string[];
  chatCalls: () => number;
  invalidations: () => number;
  start: () => Promise<{ base: string; server: Server }>;
}

function makeFullHarness(opts: {
  apiKeys?: string[];
  models?: string[];
  maxBodyBytes?: number;
  maxConcurrentRequests?: number;
  publicUpstream?: {
    models: () => string[];
    hasModel: (model: string) => boolean;
    chatCompletions: (body: string, signal?: AbortSignal) => Promise<Response>;
  };
  publicUpstreamEnabled?: boolean;
  chatHandler?: (body: string, call: number) => Response | Promise<Response>;
  acquireSession?: () => Promise<{ pool: { token: string }; instanceId: string | null }>;
  acquireUserSession?: (token: string) => Promise<{ pool: { token: string }; instanceId: string | null }>;
  resolveTokenForApiKey?: (apiKey: string) => string | undefined;
} = {}): FullHarness {
  const cfg = {
    listenAddr: ":0",
    upstreamBaseURL: "http://upstream.invalid",
    loginBaseURL: "https://freebuff.com",
    authTokens: ["t1"],
    rotationIntervalMs: 3_600_000,
    requestTimeoutMs: 30_000,
    userAgent: "test-ua",
    actingUserId: null,
    apiKeys: opts.apiKeys ?? [],
    httpProxy: null,
    maxBodyBytes: opts.maxBodyBytes ?? 16 * 1024 * 1024,
    maxConcurrentRequests: opts.maxConcurrentRequests ?? 32,
    publicUpstreamEnabled: opts.publicUpstreamEnabled ?? Boolean(opts.publicUpstream),
    publicUpstreamProviders: ["opencode", "pollinations", "felo"],
    publicUpstreamBaseURL: "https://opencode.ai/zen/v1",
    publicUpstreamModels: ["big-pickle"],
    publicUpstreamTimeoutMs: 2_000,
  } as Config;

  const bodies: string[] = [];
  const tokensUsed: string[] = [];
  let calls = 0;
  let invalidations = 0;

  const client = {
    chatCompletions: async (token: string, body: string) => {
      calls += 1;
      bodies.push(body);
      tokensUsed.push(token);
      if (opts.chatHandler) return opts.chatHandler(body, calls);
      return new Response('{"id":"x","choices":[{"message":{"role":"assistant","content":"hi"}}]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  } as unknown as UpstreamClient;

  const publicUpstream = opts.publicUpstream as never;

  const registry = {
    status: () => ({ source: "fallback" as const, updatedAt: null, agentCount: 2, modelCount: 2 }),
    models: () => opts.models ?? [MODEL],
    agentForModel: (m: string) => (m === MODEL ? "base2-free-deepseek-flash" : undefined),
  } as unknown as ModelRegistry;

  const tokens = {
    acquireSession: opts.acquireSession ?? (async () => ({ pool: { token: "t1" }, instanceId: "inst-1" })),
    acquireUserSession:
      opts.acquireUserSession ??
      (async (token: string) => ({ pool: { token }, instanceId: "user-inst" })),
    invalidateSession: () => {
      invalidations += 1;
    },
    cooldown: () => {},
    snapshots: () => ({}),
  } as unknown as TokenManager;

  const runs = {
    acquire: async () => "run-1",
    invalidate: () => {},
    finishAll: async () => {},
  } as unknown as RunManager;

  const server = new Server({
    cfg,
    client,
    publicUpstream,
    registry,
    tokens,
    runs,
    log: () => {},
    resolveTokenForApiKey: opts.resolveTokenForApiKey,
  });

  return {
    base: "",
    bodies,
    tokensUsed,
    chatCalls: () => calls,
    invalidations: () => invalidations,
    start: async () => {
      // Let the OS choose a free port; Server.listen accepts port 0.
      await server.listen(0, "127.0.0.1");
      const port = server.listeningPort();
      if (port === null) throw new Error("test server is not listening");
      return { base: `http://127.0.0.1:${port}`, server };
    },
  };
}

function chatPost(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Server HTTP surface", () => {
  let harness: FullHarness;
  let base = "";
  let server: Server;

  beforeAll(async () => {
    harness = makeFullHarness();
    const started = await harness.start();
    base = started.base;
    server = started.server;
  });

  afterAll(async () => {
    await server.close();
  });

  test("GET /healthz returns only public liveness data", async () => {
    const resp = await fetch(`${base}/healthz`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; started_at: string; uptime_sec: number; tokens?: unknown; models?: unknown };
    expect(body.ok).toBe(true);
    expect(body.started_at).toMatch(/T/);
    expect(body.uptime_sec).toBeGreaterThanOrEqual(0);
    expect(body.tokens).toBeUndefined();
    expect(body.models).toBeUndefined();
  });

  test("GET /v1/models lists the registered models", async () => {
    const resp = await fetch(`${base}/v1/models`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { data: { id: string; object: string }[] };
    expect(body.data.map((m) => m.id)).toContain(MODEL);
    expect(body.data[0]?.object).toBe("model");
  });

  test("rejects non-GET methods on read-only endpoints", async () => {
    const modelsResp = await fetch(`${base}/v1/models`, { method: "POST" });
    expect(modelsResp.status).toBe(405);
    const healthResp = await fetch(`${base}/healthz`, { method: "POST" });
    expect(healthResp.status).toBe(405);
  });

  test("unknown endpoint returns 404 in OpenAI error shape", async () => {
    const resp = await fetch(`${base}/v1/nope`);
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("uses the anonymous public provider before Freebuff when the model is allowlisted", async () => {
    let publicBody = "";
    const publicHarness = makeFullHarness({
      publicUpstreamEnabled: true,
      publicUpstream: {
        models: () => [MODEL],
        hasModel: (model) => model === MODEL,
        chatCompletions: async (body) => {
          publicBody = body;
          return new Response('{"id":"public","choices":[{"message":{"role":"assistant","content":"public-ok"}}]}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    });
    const started = await publicHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] }, { Authorization: "Bearer proxy-key" });
      expect(resp.status).toBe(200);
      expect((await resp.json()).choices[0].message.content).toBe("public-ok");
      expect(publicBody).toContain(MODEL);
      expect(publicHarness.chatCalls()).toBe(0);
    } finally {
      await started.server.close();
    }
  });

  test("falls back to Freebuff when the public provider returns a transient failure", async () => {
    const publicHarness = makeFullHarness({
      publicUpstreamEnabled: true,
      publicUpstream: {
        models: () => [MODEL],
        hasModel: () => true,
        chatCompletions: async () => new Response('{"error":"busy"}', { status: 503 }),
      },
    });
    const started = await publicHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] }, { Authorization: "Bearer proxy-key" });
      expect(resp.status).toBe(200);
      expect(publicHarness.chatCalls()).toBe(1);
    } finally {
      await started.server.close();
    }
  });

  test("returns a final public failure for a model without Freebuff fallback", async () => {
    const publicUpstream = {
      models: () => ["pollinations/openai"],
      hasModel: (model: string) => model === "pollinations/openai",
      chatCompletions: async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
    };
    const harness = makeFullHarness({ publicUpstream, publicUpstreamEnabled: true });
    const started = await harness.start();
    try {
      const response = await chatPost(started.base, { model: "pollinations/openai", messages: [{ role: "user", content: "hi" }] });
      expect(response.status).toBe(429);
      expect((await response.json() as { error: { message: string } }).error.message).toContain("rate limited");
      expect(harness.chatCalls()).toBe(0);
    } finally {
      await started.server.close();
    }
  });

  test("returns public client errors without consuming Freebuff capacity", async () => {
    const publicHarness = makeFullHarness({
      publicUpstreamEnabled: true,
      publicUpstream: {
        models: () => [MODEL],
        hasModel: () => true,
        chatCompletions: async () => new Response('{"error":"bad request"}', { status: 400 }),
      },
    });
    const started = await publicHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] }, { Authorization: "Bearer proxy-key" });
      expect(resp.status).toBe(400);
      expect(publicHarness.chatCalls()).toBe(0);
    } finally {
      await started.server.close();
    }
  });

  test("POST /v1/chat/completions proxies and injects the CLI marker", async () => {
    const resp = await chatPost(base, {
      model: MODEL,
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("hi");

    const sent = JSON.parse(harness.bodies[0]) as {
      messages: { role: string; content: string }[];
      codebuff_metadata: Record<string, string>;
      provider: Record<string, string>;
      model: string;
    };
    // Marker is prepended as a system message; the client message is preserved.
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toContain(MARKER_PHRASE);
    expect(sent.messages[1]).toEqual({ role: "user", content: "Reply with exactly: PONG" });
    // Metadata + provider mirror the official CLI shape.
    expect(sent.codebuff_metadata.run_id).toBe("run-1");
    expect(sent.codebuff_metadata.freebuff_instance_id).toBe("inst-1");
    expect(sent.codebuff_metadata.cost_mode).toBe("free");
    expect(sent.provider).toEqual({ data_collection: "deny" });
    expect(sent.model).toBe(MODEL);
  });

  test("merges the marker into an existing system message without clobbering it", async () => {
    harness.bodies.length = 0;
    await chatPost(base, {
      model: MODEL,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ],
    });
    const sent = JSON.parse(harness.bodies[0]) as { messages: { role: string; content: string }[] };
    const system = sent.messages.find((m) => m.role === "system")!;
    expect(system.content.startsWith(MARKER_PHRASE)).toBe(true);
    expect(system.content).toContain("You are a helpful assistant.");
  });

  test("does not double-inject when the marker is already present", async () => {
    harness.bodies.length = 0;
    const clientSystem = "You are Buffy, the strategic coding assistant. Custom prompt.";
    await chatPost(base, {
      model: MODEL,
      messages: [{ role: "system", content: clientSystem }, { role: "user", content: "hi" }],
    });
    const sent = JSON.parse(harness.bodies[0]) as { messages: { role: string; content: string }[] };
    expect(sent.messages[0].content).toBe(clientSystem);
    expect(sent.messages).toHaveLength(2);
  });

  test("rejects requests without a model", async () => {
    const resp = await chatPost(base, { messages: [{ role: "user", content: "hi" }] });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { message: string } };
    expect(body.error.message).toContain("model is required");
  });

  test("rejects unsupported models with model_not_found", async () => {
    const resp = await chatPost(base, { model: "nope/model", messages: [{ role: "user", content: "hi" }] });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });

  test("rejects request bodies larger than the configured limit", async () => {
    const limited = makeFullHarness({ maxBodyBytes: 32 });
    const started = await limited.start();
    try {
      const resp = await fetch(`${started.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "this body is larger" }] }),
      });
      expect(resp.status).toBe(413);
    } finally {
      await started.server.close();
    }
  });

  test("rejects malformed JSON", async () => {
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(resp.status).toBe(400);
  });

  test("GET on a POST endpoint returns 405", async () => {
    const resp = await fetch(`${base}/v1/chat/completions`);
    expect(resp.status).toBe(405);
  });

  test("passes through SSE streams chunk by chunk", async () => {
    const streamHarness = makeFullHarness({
      chatHandler: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"id":"1","choices":[{"delta":{"content":"hel"}}]}\n\n'));
              controller.enqueue(new TextEncoder().encode('data: {"id":"1","choices":[{"delta":{"content":"lo"}}]}\n\n'));
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const started = await streamHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("text/event-stream");
      const text = await resp.text();
      expect(text).toContain('"content":"hel"');
      expect(text).toContain('"content":"lo"');
      expect(text).toContain("data: [DONE]");
    } finally {
      await started.server.close();
    }
  });

  test("retries once when the free session is invalid, then succeeds", async () => {
    const retryHarness = makeFullHarness({
      chatHandler: (_, call) =>
        call === 1
          ? new Response(JSON.stringify({ error: { code: "session_expired" } }), { status: 403, headers: { "Content-Type": "application/json" } })
          : new Response('{"id":"x","choices":[{"message":{"role":"assistant","content":"ok"}}]}', { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const started = await retryHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(200);
      expect(retryHarness.chatCalls()).toBe(2);
      expect(retryHarness.invalidations()).toBe(1);
    } finally {
      await started.server.close();
    }
  });

  test("rotates the run when the runId is not found", async () => {
    const retryHarness = makeFullHarness({
      chatHandler: (_, call) =>
        call === 1
          ? new Response(JSON.stringify({ error: { code: "runId not found" } }), { status: 400, headers: { "Content-Type": "application/json" } })
          : new Response('{"id":"x","choices":[{"message":{"role":"assistant","content":"ok"}}]}', { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const started = await retryHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(200);
      expect(retryHarness.chatCalls()).toBe(2);
    } finally {
      await started.server.close();
    }
  });

  test("surfaces upstream errors with Retry-After", async () => {
    const errHarness = makeFullHarness({
      chatHandler: () =>
        new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        }),
    });
    const started = await errHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(429);
      expect(resp.headers.get("retry-after")).toBe("60");
      const body = (await resp.json()) as { error: { code: string; type: string } };
      expect(body.error.code).toBe("rate_limited");
      expect(body.error.type).toBe("upstream_error");
    } finally {
      await started.server.close();
    }
  });

  test("returns 503 + Retry-After on a waiting-room queue", async () => {
    const wrHarness = makeFullHarness({
      acquireSession: async () => {
        throw new WaitingRoomError(30_000, 3, 10);
      },
    });
    const started = await wrHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(503);
      expect(resp.headers.get("retry-after")).toBe("30");
      const body = (await resp.json()) as { error: { code: string } };
      expect(body.error.code).toBe("waiting_room_queued");
    } finally {
      await started.server.close();
    }
  });

  test("returns 503 when every token is on cooldown", async () => {
    const cdHarness = makeFullHarness({
      acquireSession: async () => {
        throw new Error("all upstream tokens are on cooldown");
      },
    });
    const started = await cdHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(503);
    } finally {
      await started.server.close();
    }
  });

  test("preserves terminal model admission errors instead of masking them as 503", async () => {
    const modelHarness = makeFullHarness({
      acquireSession: async () => {
        throw new UpstreamError("model unavailable", 409, undefined, "model_unavailable");
      },
    });
    const started = await modelHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(409);
      const body = (await resp.json()) as { error: { code: string; type: string } };
      expect(body.error.code).toBe("model_unavailable");
      expect(body.error.type).toBe("upstream_error");
    } finally {
      await started.server.close();
    }
  });

  test("model_locked admission errors name the locked model", async () => {
    const modelHarness = makeFullHarness({
      acquireSession: async () => {
        throw new UpstreamError(
          "free session unavailable for deepseek/deepseek-v4-flash: model_locked (session is locked to openai/gpt-5.6-luna)",
          409,
          undefined,
          "model_locked",
        );
      },
    });
    const started = await modelHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(409);
      const body = (await resp.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("model_locked");
      expect(body.error.message).toContain("openai/gpt-5.6-luna");
    } finally {
      await started.server.close();
    }
  });

  test("passes through upstream session 503 with its message and Retry-After", async () => {
    const errHarness = makeFullHarness({
      acquireSession: async () => {
        throw new UpstreamError("free session POST failed: 503", 503, 30_000, "capacity exhausted");
      },
    });
    const started = await errHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(503);
      expect(resp.headers.get("retry-after")).toBe("30");
      const body = (await resp.json()) as { error: { message: string; code?: string } };
      expect(body.error.message).toContain("capacity exhausted");
      expect(body.error.code).toBeUndefined();
    } finally {
      await started.server.close();
    }
  });

  test("passes through upstream session 429 with Retry-After instead of masking as 503", async () => {
    const errHarness = makeFullHarness({
      acquireSession: async () => {
        throw new UpstreamError("rate limited", 429, 60_000, "rate_limited");
      },
    });
    const started = await errHarness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(429);
      expect(resp.headers.get("retry-after")).toBe("60");
      const body = (await resp.json()) as { error: { message: string } };
      expect(body.error.message).toBe("rate_limited");
    } finally {
      await started.server.close();
    }
  });
});

describe("proxy API key auth", () => {
  let harness: FullHarness;
  let base = "";
  let server: Server;

  beforeAll(async () => {
    harness = makeFullHarness({ apiKeys: ["secret-1"] });
    const started = await harness.start();
    base = started.base;
    server = started.server;
  });

  afterAll(async () => {
    await server.close();
  });

  test("rejects requests without a key", async () => {
    const resp = await fetch(`${base}/v1/models`);
    expect(resp.status).toBe(401);
  });

  test("accepts x-api-key", async () => {
    const resp = await fetch(`${base}/v1/models`, { headers: { "x-api-key": "secret-1" } });
    expect(resp.status).toBe(200);
  });

  test("accepts Authorization: Bearer", async () => {
    const resp = await fetch(`${base}/v1/models`, { headers: { Authorization: "Bearer secret-1" } });
    expect(resp.status).toBe(200);
  });

  test("rejects a wrong key", async () => {
    const resp = await fetch(`${base}/v1/models`, { headers: { Authorization: "Bearer nope" } });
    expect(resp.status).toBe(401);
  });

  test("keeps /healthz public even when a proxy key is configured", async () => {
    const resp = await fetch(`${base}/healthz`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("still requires the key for /v1/chat/completions", async () => {
    const resp = await chatPost(base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
    expect(resp.status).toBe(401);
  });
});

describe("web-login API keys (sk-fb-*)", () => {
  test("a resolved user key serves the request with the caller's own token", async () => {
    const harness = makeFullHarness({
      resolveTokenForApiKey: (key: string) => (key.startsWith("sk-fb-") ? key.slice("sk-fb-".length) : undefined),
      acquireUserSession: async (token: string) => ({ pool: { token }, instanceId: "user-inst" }),
    });
    const started = await harness.start();
    try {
      const resp = await chatPost(
        started.base,
        { model: MODEL, messages: [{ role: "user", content: "hi" }] },
        { Authorization: "Bearer sk-fb-user-1" },
      );
      expect(resp.status).toBe(200);
      expect(harness.tokensUsed).toEqual(["user-1"]);
    } finally {
      await started.server.close();
    }
  });

  test("accepts user keys via x-api-key as well", async () => {
    const harness = makeFullHarness({
      resolveTokenForApiKey: (key: string) => (key.startsWith("sk-fb-") ? key.slice("sk-fb-".length) : undefined),
    });
    const started = await harness.start();
    try {
      const resp = await chatPost(
        started.base,
        { model: MODEL, messages: [{ role: "user", content: "hi" }] },
        { "x-api-key": "sk-fb-xkey" },
      );
      expect(resp.status).toBe(200);
      expect(harness.tokensUsed).toEqual(["xkey"]);
    } finally {
      await started.server.close();
    }
  });

  test("unknown keys are rejected even without env API_KEYS", async () => {
    const harness = makeFullHarness({ resolveTokenForApiKey: () => undefined });
    const started = await harness.start();
    try {
      const resp = await chatPost(started.base, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(resp.status).toBe(401);
      expect(harness.chatCalls()).toBe(0);
    } finally {
      await started.server.close();
    }
  });

  test("/healthz stays public when a key resolver is present", async () => {
    const harness = makeFullHarness({ resolveTokenForApiKey: () => undefined });
    const started = await harness.start();
    try {
      const resp = await fetch(`${started.base}/healthz`);
      expect(resp.status).toBe(200);
    } finally {
      await started.server.close();
    }
  });
});
