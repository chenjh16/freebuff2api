import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PUBLIC_UPSTREAM_BASE_URL,
  FeloPublicUpstreamClient,
  PollinationsImageClient,
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

  test("aggregates canonical ids plus bare aliases across providers", () => {
    const router = createPublicUpstreamRouter({
      providers: ["opencode", "pollinations", "felo"],
      models: ["big-pickle", "pollinations/openai", "felo/felo-chat"],
      timeoutMs: 2_000,
    });
    const ids = router.models();
    expect(ids).toContain("big-pickle");
    expect(ids).toContain("opencode/big-pickle");
    expect(ids).toContain("pollinations/openai");
    expect(ids).toContain("openai");
    expect(ids).toContain("felo/felo-chat");
    expect(ids).toContain("felo-chat");
    // Bare aliases resolve through their owning provider.
    expect(router.hasModel("pollinations/openai")).toBe(true);
    expect(router.hasModel("openai")).toBe(true);
    expect(router.hasModel("felo/felo-chat")).toBe(true);
    expect(router.hasModel("felo-chat")).toBe(true);
    expect(router.hasModel("opencode/big-pickle")).toBe(true);
    expect(router.hasModel("pollinations/claude")).toBe(false);
    expect(router.hasModel("gpt-5.6-luna")).toBe(false);
  });

  test("opencode strips its prefix before forwarding", async () => {
    let capturedBody = "";
    const client = new PublicUpstreamClient({
      baseURL: DEFAULT_PUBLIC_UPSTREAM_BASE_URL,
      models: ["big-pickle"],
      timeoutMs: 2_000,
      fetchFn: async (_input, init) => {
        capturedBody = String(init?.body ?? "");
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    await client.chatCompletions('{"model":"opencode/big-pickle"}');
    expect(JSON.parse(capturedBody).model).toBe("big-pickle");
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

  test("Felo exposes canonical ids and bare aliases without credentials", () => {
    const client = new FeloPublicUpstreamClient({ models: ["felo/felo-chat"], timeoutMs: 2_000 });
    expect(client.hasModel("felo/felo-chat")).toBe(true);
    expect(client.hasModel("felo-chat")).toBe(true);
    expect(client.hasModel("felo/felo-search")).toBe(false);
    expect(client.models()).toContain("felo/felo-chat");
    expect(client.models()).toContain("felo-chat");
  });

  test("Pollinations image client builds the anonymous URL and embeds base64", async () => {
    let captured: string | undefined;
    const client = new PollinationsImageClient({
      models: ["pollinations/flux"],
      timeoutMs: 2_000,
      fetchFn: async (input) => {
        captured = String(input);
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      },
    });
    const response = await client.imageGenerations(
      JSON.stringify({ model: "pollinations/flux", prompt: "a red apple", size: "512x512", seed: 7, n: 1 }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { created: number; data: { url: string; b64_json: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].b64_json).toBe(Buffer.from([0xff, 0xd8, 0xff]).toString("base64"));
    expect(body.data[0].url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(captured).toContain(`/prompt/${encodeURIComponent("a red apple")}`);
    expect(captured).toContain("width=512");
    expect(captured).toContain("height=512");
    expect(captured).toContain("seed=7");
    expect(captured).toContain("model=flux");
    expect(captured).not.toMatch(/[Aa]uthorization|api[_-]?key|cookie/i);
    expect(captured).not.toContain("nologo");
  });

  test("Pollinations image client accepts the bare alias and honors n/seed offsets", async () => {
    const calls: string[] = [];
    const client = new PollinationsImageClient({
      models: ["pollinations/flux"],
      timeoutMs: 2_000,
      fetchFn: async (input) => {
        calls.push(String(input));
        return new Response(new Uint8Array([1]), { status: 200 });
      },
    });
    const response = await client.imageGenerations(
      JSON.stringify({ model: "flux", prompt: "cat", n: 2, seed: 10, response_format: "b64_json" }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("seed=10");
    expect(calls[1]).toContain("seed=11");
    const body = (await response.json()) as { data: { b64_json?: string; url?: string }[] };
    expect(body.data).toHaveLength(2);
    expect(body.data[0].b64_json).toBe(Buffer.from([1]).toString("base64"));
    expect(body.data[0].url).toBeUndefined();
  });

  test("Pollinations image client rejects bad input", async () => {
    const client = new PollinationsImageClient({ models: ["pollinations/flux"], timeoutMs: 2_000 });
    const badModel = await client.imageGenerations(JSON.stringify({ model: "pollinations/openai", prompt: "x" }));
    expect(badModel.status).toBe(400);
    const noPrompt = await client.imageGenerations(JSON.stringify({ model: "pollinations/flux" }));
    expect(noPrompt.status).toBe(400);
    const badSize = await client.imageGenerations(JSON.stringify({ model: "pollinations/flux", prompt: "x", size: "square" }));
    expect(badSize.status).toBe(400);
    const badN = await client.imageGenerations(JSON.stringify({ model: "pollinations/flux", prompt: "x", n: 5 }));
    expect(badN.status).toBe(400);
  });

  test("router exposes image models and routes image generation", async () => {
    const router = createPublicUpstreamRouter({
      providers: ["pollinations"],
      models: ["pollinations/openai"],
      imageModels: ["pollinations/flux", "pollinations/turbo"],
      timeoutMs: 2_000,
    });
    expect(router.imageModels()).toContain("pollinations/flux");
    expect(router.imageModels()).toContain("flux");
    expect(router.hasImageModel("flux")).toBe(true);
    expect(router.hasImageModel("pollinations/flux")).toBe(true);
    expect(router.hasImageModel("pollinations/openai")).toBe(false);
    // Image generation with a mocked image fetch.
    const response = await router.imageGenerations(JSON.stringify({ model: "pollinations/flux", prompt: "sunset" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { b64_json: string }[] };
    expect(body.data[0].b64_json).toBeDefined();
  });

  test("router does not expose image models when none are configured", () => {
    const router = createPublicUpstreamRouter({
      providers: ["pollinations"],
      models: ["pollinations/openai"],
      timeoutMs: 2_000,
    });
    expect(router.imageModels()).toEqual([]);
  });

  test("does not advertise premium Pollinations models as anonymous", () => {
    const router = createPublicUpstreamRouter({
      providers: ["pollinations"],
      models: ["pollinations/claude", "pollinations/openai"],
      timeoutMs: 2_000,
    });
    expect(router.hasModel("pollinations/openai")).toBe(true);
    expect(router.hasModel("openai")).toBe(true);
    expect(router.hasModel("pollinations/claude")).toBe(false);
    expect(router.hasModel("claude")).toBe(false);
  });

  test("falls back only for transient/provider-auth statuses", () => {
    expect(isPublicUpstreamFallbackStatus(401)).toBe(true);
    expect(isPublicUpstreamFallbackStatus(429)).toBe(true);
    expect(isPublicUpstreamFallbackStatus(503)).toBe(true);
    expect(isPublicUpstreamFallbackStatus(400)).toBe(false);
    expect(isPublicUpstreamFallbackStatus(404)).toBe(false);
  });
});
