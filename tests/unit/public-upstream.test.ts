import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PUBLIC_UPSTREAM_BASE_URL,
  PublicUpstreamClient,
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

  test("falls back only for transient/provider-auth statuses", () => {
    expect(isPublicUpstreamFallbackStatus(401)).toBe(true);
    expect(isPublicUpstreamFallbackStatus(429)).toBe(true);
    expect(isPublicUpstreamFallbackStatus(503)).toBe(true);
    expect(isPublicUpstreamFallbackStatus(400)).toBe(false);
    expect(isPublicUpstreamFallbackStatus(404)).toBe(false);
  });
});
