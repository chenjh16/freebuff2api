import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PUBLIC_UPSTREAM_BASE_URL,
  FeloPublicUpstreamClient,
  PollinationsImageClient,
  PublicUpstreamClient,
  PublicUpstreamRouter,
  createPublicUpstreamRouter,
  isPublicUpstreamFallbackStatus,
  sanitizeOpenAIStream,
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

  test("routes only allowlisted models and rejects bare ids", () => {
    const client = new PublicUpstreamClient({
      baseURL: DEFAULT_PUBLIC_UPSTREAM_BASE_URL,
      models: ["big-pickle"],
      timeoutMs: 2_000,
    });
    expect(client.hasModel("opencode/big-pickle")).toBe(true);
    // Unprefixed aliases are intentionally not exposed.
    expect(client.hasModel("big-pickle")).toBe(false);
    expect(client.hasModel("gpt-5.6-luna")).toBe(false);
  });

  test("aggregates provider-namespaced ids only across providers", () => {
    const router = createPublicUpstreamRouter({
      providers: ["opencode", "pollinations", "felo"],
      models: ["big-pickle", "pollinations/openai", "felo/felo-chat"],
      timeoutMs: 2_000,
    });
    const ids = router.models();
    expect(ids).toContain("opencode/big-pickle");
    expect(ids).toContain("pollinations/openai");
    expect(ids).toContain("felo/felo-chat");
    // No unprefixed forms are advertised.
    expect(ids).not.toContain("big-pickle");
    expect(ids).not.toContain("openai");
    expect(ids).not.toContain("felo-chat");
    // Prefixed ids resolve through their owning provider; bare ids do not.
    expect(router.hasModel("pollinations/openai")).toBe(true);
    expect(router.hasModel("openai")).toBe(false);
    expect(router.hasModel("felo/felo-chat")).toBe(true);
    expect(router.hasModel("felo-chat")).toBe(false);
    expect(router.hasModel("opencode/big-pickle")).toBe(true);
    expect(router.hasModel("pollinations/claude")).toBe(false);
    expect(router.hasModel("gpt-5.6-luna")).toBe(false);
  });

  test("accepts bare OpenCode ids in the allowlist config for compatibility", () => {
    const router = createPublicUpstreamRouter({
      providers: ["opencode"],
      models: ["big-pickle"],
      timeoutMs: 2_000,
    });
    expect(router.models()).toEqual(["opencode/big-pickle"]);
    expect(router.hasModel("opencode/big-pickle")).toBe(true);
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
    const text = await response.text();
    expect(text).toContain("final answer");
    // Felo's web protocol has no finish chunk; the adapter must emit a
    // terminal stop before [DONE] or strict clients abort with "other".
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]"));
  });

  test("Felo exposes provider-namespaced ids only without credentials", () => {
    const client = new FeloPublicUpstreamClient({ models: ["felo/felo-chat"], timeoutMs: 2_000 });
    expect(client.hasModel("felo/felo-chat")).toBe(true);
    expect(client.hasModel("felo-chat")).toBe(false);
    expect(client.hasModel("felo/felo-search")).toBe(false);
    expect(client.models()).toEqual(["felo/felo-chat"]);
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

  test("Pollinations image client honors n/seed offsets with prefixed ids and rejects bare ids", async () => {
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
      JSON.stringify({ model: "pollinations/flux", prompt: "cat", n: 2, seed: 10, response_format: "b64_json" }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("seed=10");
    expect(calls[1]).toContain("seed=11");
    const body = (await response.json()) as { data: { b64_json?: string; url?: string }[] };
    expect(body.data).toHaveLength(2);
    expect(body.data[0].b64_json).toBe(Buffer.from([1]).toString("base64"));
    expect(body.data[0].url).toBeUndefined();
    // The unprefixed alias is no longer a valid model id.
    const rejected = await client.imageGenerations(JSON.stringify({ model: "flux", prompt: "cat" }));
    expect(rejected.status).toBe(400);
  });

  test("Pollinations image client posts reference images for img2img", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new PollinationsImageClient({
      models: ["pollinations/flux"],
      timeoutMs: 2_000,
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    });
    const response = await client.imageGenerations(
      JSON.stringify({
        model: "pollinations/flux",
        prompt: "turn the photo into a watercolor",
        size: "512x512",
        image: "data:image/png;base64,aGVsbG8=",
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].url).toContain(`/prompt/${encodeURIComponent("turn the photo into a watercolor")}`);
    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(sent.image).toBe("data:image/png;base64,aGVsbG8=");
    expect(sent.prompt).toBe("turn the photo into a watercolor");
    expect(sent.model).toBe("flux");
    expect(sent.width).toBe(512);
    expect(sent.height).toBe(512);
    // No Authorization/cookie/api-key data leaks into the upstream request.
    expect(calls[0].url).not.toMatch(/[Aa]uthorization|api[_-]?key|cookie/i);
    expect(String(calls[0].init?.body)).not.toMatch(/[Aa]uthorization|api[_-]?key|cookie/i);
  });

  test("Pollinations image client supports multiple reference images and rejects too many", async () => {
    const calls: { init?: RequestInit }[] = [];
    const client = new PollinationsImageClient({
      models: ["pollinations/flux"],
      timeoutMs: 2_000,
      fetchFn: async (_input, init) => {
        calls.push({ init });
        return new Response(new Uint8Array([1]), { status: 200 });
      },
    });
    const response = await client.imageGenerations(
      JSON.stringify({ model: "pollinations/flux", prompt: "x", image: ["data:a", "data:b"] }),
    );
    expect(response.status).toBe(200);
    const sent = JSON.parse(String(calls[0].init?.body)) as { image: unknown };
    expect(sent.image).toEqual(["data:a", "data:b"]);

    const rejected = await client.imageGenerations(
      JSON.stringify({ model: "pollinations/flux", prompt: "x", image: ["a", "b", "c", "d", "e"] }),
    );
    expect(rejected.status).toBe(400);
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
    expect(router.imageModels()).toEqual(["pollinations/flux", "pollinations/turbo"]);
    expect(router.hasImageModel("flux")).toBe(false);
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
    // Unprefixed aliases are not routable.
    expect(router.hasModel("openai")).toBe(false);
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

function sseResponse(raw: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function sseDataLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}

function parseFinishReasons(text: string): string[] {
  const reasons: string[] = [];
  for (const line of sseDataLines(text)) {
    if (line === "[DONE]") continue;
    try {
      const chunk = JSON.parse(line) as { choices?: { finish_reason?: string | null }[] };
      const reason = chunk.choices?.[0]?.finish_reason;
      if (reason) reasons.push(reason);
    } catch {
      // ignore
    }
  }
  return reasons;
}

describe("sanitizeOpenAIStream", () => {
  test("synthesizes a terminal stop when the upstream ends without a finish chunk", async () => {
    // OpenCode free-tier truncation: reasoning deltas, then [DONE] with no
    // finish_reason anywhere. Strict clients would synthesize "other" here.
    const response = sanitizeOpenAIStream(sseResponse(
      `data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":null}]}\n\n` +
      `data: [DONE]\n\n`,
    ));
    const text = await response.text();
    const lines = sseDataLines(text);
    expect(lines[lines.length - 1]).toBe("[DONE]");
    const terminal = JSON.parse(lines[lines.length - 2]) as {
      choices: { index: number; delta: Record<string, unknown>; finish_reason: string }[];
    };
    expect(terminal.choices[0].finish_reason).toBe("stop");
    // Reasoning delta is preserved verbatim.
    expect(lines[0]).toContain("reasoning_content");
  });

  test("rewrites a non-standard finish reason to stop", async () => {
    const response = sanitizeOpenAIStream(sseResponse(
      `data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"other"}]}\n\n` +
      `data: [DONE]\n\n`,
    ));
    const text = await response.text();
    expect(parseFinishReasons(text)).toEqual(["stop"]);
    expect(text).toContain('"content":"hi"');
    expect(text).not.toContain('"other"');
  });

  test("drops junk trailing chunks without choices or usage", async () => {
    const response = sanitizeOpenAIStream(sseResponse(
      `data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n` +
      `data: {"choices":[],"cost":"0"}\n\n` +
      `data: [DONE]\n\n`,
    ));
    const text = await response.text();
    const lines = sseDataLines(text);
    expect(text).not.toContain("cost");
    const chunks = lines.filter((line) => line !== "[DONE]");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('"content":"hi"');
    expect(lines[lines.length - 1]).toBe("[DONE]");
  });

  test("keeps usage chunks and appends the terminal stop after them", async () => {
    const response = sanitizeOpenAIStream(sseResponse(
      `data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n` +
      `data: {"id":"x","choices":[],"usage":{"prompt_tokens":84}}\n\n` +
      `data: [DONE]\n\n`,
    ));
    const text = await response.text();
    const lines = sseDataLines(text);
    expect(lines.some((line) => line.includes("usage"))).toBe(true);
    expect(lines[lines.length - 1]).toBe("[DONE]");
    expect(lines[lines.length - 2]).toContain("prompt_tokens");
  });

  test("drops malformed data lines", async () => {
    const response = sanitizeOpenAIStream(sseResponse(
      `data: {not json\n\n` +
      `data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`,
    ));
    const text = await response.text();
    expect(text).not.toContain("not json");
    expect(text).toContain('"content":"hi"');
  });

  test("leaves a well-formed stream untouched apart from chunk framing", async () => {
    const response = sanitizeOpenAIStream(sseResponse(
      `data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n` +
      `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`,
    ));
    const text = await response.text();
    expect(parseFinishReasons(text)).toEqual(["stop"]);
    const lines = sseDataLines(text);
    expect(lines[lines.length - 1]).toBe("[DONE]");
    expect(lines[0]).toContain('"content":"Hello"');
  });

  test("passes non-stream JSON responses through unchanged", async () => {
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
    const response = sanitizeOpenAIStream(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(await response.text()).toBe(body);
  });

  test("PublicUpstreamClient sanitizes SSE responses from the wire", async () => {
    const client = new PublicUpstreamClient({
      baseURL: DEFAULT_PUBLIC_UPSTREAM_BASE_URL,
      models: ["big-pickle"],
      timeoutMs: 2_000,
      fetchFn: async () => sseResponse(`data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"r"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`),
    });
    const response = await client.chatCompletions(JSON.stringify({ model: "big-pickle", stream: true, messages: [{ role: "user", content: "hi" }] }));
    const text = await response.text();
    const lines = sseDataLines(text);
    expect(JSON.parse(lines[lines.length - 2]).choices[0].finish_reason).toBe("stop");
    expect(lines[lines.length - 1]).toBe("[DONE]");
  });
});
