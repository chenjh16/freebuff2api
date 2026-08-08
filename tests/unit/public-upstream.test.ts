import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PUBLIC_UPSTREAM_BASE_URL,
  FeloPublicUpstreamClient,
  PublicUpstreamClient,
  PublicUpstreamRouter,
  createPublicUpstreamRouter,
  isPublicUpstreamFallbackStatus,
  validatePublicUpstreamURL,
} from "../../src/public-upstream.ts";

describe("public upstream safety", () => {
  test("accepts only the fixed OpenCode host over HTTPS", () => {
    expect(validatePublicUpstreamURL(DEFAULT_PUBLIC_UPSTREAM_BASE_URL, ["opencode.ai"]).hostname).toBe("opencode.ai");
    expect(() => validatePublicUpstreamURL("https://evil.example/v1", ["opencode.ai"])).toThrow();
    expect(() => validatePublicUpstreamURL("http://opencode.ai/v1", ["opencode.ai"])).toThrow();
  });

  test("never sends an Authorization or cookie header", async () => {
    let captured: RequestInit | undefined;
    const client = new PublicUpstreamClient({
      baseURL: "https://opencode.ai/zen/v1",
      models: ["big-pickle"],
      timeoutMs: 2_000,
      fetchFn: async (_input, init) => {
        captured = init;
        return new Response('{"ok":true}', { status: 200 });
      },
    });

    const response = await client.chatCompletions('{"model":"big-pickle"}');
    expect(response.status).toBe(200);
    const headers = new Headers(captured?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("routes only allowlisted models", () => {
    const client = new PublicUpstreamClient({
      baseURL: DEFAULT_PUBLIC_UPSTREAM_BASE_URL,
      models: ["big-pickle"],
      timeoutMs: 2_000,
    });
    expect(client.hasModel("big-pickle")).toBe(true);
    expect(client.hasModel("gpt-5.6-luna")).toBe(false);
  });

  test("aggregates namespaced Pollinations and Felo models", () => {
    const router = createPublicUpstreamRouter({
      providers: ["opencode", "pollinations", "felo"],
      models: ["big-pickle", "pollinations/openai", "felo/felo-chat"],
      timeoutMs: 2_000,
    });
    expect(router.models()).toEqual(["big-pickle", "pollinations/openai", "felo/felo-chat"]);
    expect(router.hasModel("pollinations/openai")).toBe(true);
    expect(router.hasModel("openai")).toBe(false);
    expect(router.hasModel("felo/felo-chat")).toBe(true);
    expect(router.hasModel("felo-chat")).toBe(false);
    expect(router.hasModel("pollinations/claude")).toBe(false);
  });

  test("Pollinations strips only its public namespace and no credentials", async () => {
    let capturedBody = "";
    let capturedHeaders: Headers | undefined;
    const client = new PublicUpstreamClient({
      baseURL: "https://gen.pollinations.ai/v1",
      providerId: "pollinations",
      models: ["pollinations/openai"],
      timeoutMs: 2_000,
      fetchFn: async (_input, init) => {
        capturedBody = String(init?.body ?? "");
        capturedHeaders = new Headers(init?.headers);
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    await client.chatCompletions('{"model":"pollinations/openai"}');
    expect(JSON.parse(capturedBody).model).toBe("openai");
    expect(capturedHeaders?.get("authorization")).toBeNull();
    expect(capturedHeaders?.get("cookie")).toBeNull();
  });

  test("router tries a second public provider before returning its final failure", async () => {
    const calls: string[] = [];
    const router = new PublicUpstreamRouter([
      { models: () => ["shared"], hasModel: () => true, chatCompletions: async () => { calls.push("first"); return new Response("busy", { status: 503 }); } },
      { models: () => ["shared"], hasModel: () => true, chatCompletions: async () => { calls.push("second"); return new Response("ok", { status: 200 }); } },
    ]);
    expect((await router.chatCompletions('{"model":"shared"}')).status).toBe(200);
    expect(calls).toEqual(["first", "second"]);
  });

  test("Felo translates a final unterminated SSE snapshot", async () => {
    const snapshot = JSON.stringify({ data: { type: "answer", data: { text: "final answer" } } });
    const outer = JSON.stringify({ content: snapshot });
    const client = new FeloPublicUpstreamClient({
      models: ["felo/felo-chat"],
      timeoutMs: 2_000,
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/threads")) return new Response(JSON.stringify({ stream_key: "key" }), { status: 200 });
        return new Response(`data:${outer}`, { status: 200 });
      },
    });
    const response = await client.chatCompletions(JSON.stringify({ model: "felo/felo-chat", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(await response.text()).toContain("final answer");
  });

  test("Felo exposes only strict namespaced aliases without credentials", () => {
    const client = new FeloPublicUpstreamClient({ models: ["felo/felo-chat"], timeoutMs: 2_000 });
    expect(client.hasModel("felo/felo-chat")).toBe(true);
    expect(client.hasModel("felo-chat")).toBe(false);
    expect(client.hasModel("felo/felo-search")).toBe(false);
  });

  test("does not advertise premium Pollinations models as anonymous", () => {
    const router = createPublicUpstreamRouter({
      providers: ["pollinations"],
      models: ["pollinations/claude", "pollinations/openai"],
      timeoutMs: 2_000,
    });
    expect(router.models()).toEqual(["pollinations/openai"]);
    expect(router.hasModel("pollinations/claude")).toBe(false);
  });

  test("falls back only for transient/provider-auth statuses", () => {
    expect(isPublicUpstreamFallbackStatus(401)).toBe(true);
    expect(isPublicUpstreamFallbackStatus(429)).toBe(true);
    expect(isPublicUpstreamFallbackStatus(503)).toBe(true);
    expect(isPublicUpstreamFallbackStatus(400)).toBe(false);
    expect(isPublicUpstreamFallbackStatus(404)).toBe(false);
  });
});
