import { describe, expect, test } from "bun:test";

import {
  applyCors,
  corsPreflight,
  resolveApiKeys,
  unconfiguredHandler,
  DEFAULT_API_KEYS,
} from "../../app/lib/proxy.ts";

describe("resolveApiKeys (hosted deployment default)", () => {
  test("falls back to the deploy default when API_KEYS is unset", () => {
    expect(resolveApiKeys({})).toEqual(DEFAULT_API_KEYS);
    expect(resolveApiKeys({ API_KEYS: "" })).toEqual(DEFAULT_API_KEYS);
    expect(resolveApiKeys({ API_KEYS: "   " })).toEqual(DEFAULT_API_KEYS);
  });

  test("prefers an explicit API_KEYS value", () => {
    expect(resolveApiKeys({ API_KEYS: "sk-custom" })).toEqual(["sk-custom"]);
  });

  test("splits comma/whitespace lists and dedupes", () => {
    expect(resolveApiKeys({ API_KEYS: " a , b\nc;b " })).toEqual(["a", "b", "c"]);
  });
});

describe("cors", () => {
  test("preflight answers 204 with open CORS headers", () => {
    const resp = corsPreflight();
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("access-control-allow-methods")).toContain("POST");
    expect(resp.headers.get("access-control-allow-headers") ?? "").toContain("Authorization");
  });

  test("applyCors attaches CORS headers to an existing response", async () => {
    const wrapped = applyCors(new Response('{"ok":true}', { status: 200 }));
    expect(wrapped.headers.get("access-control-allow-origin")).toBe("*");
    expect(wrapped.status).toBe(200);
    expect(await wrapped.text()).toBe('{"ok":true}');
  });
});

describe("unconfiguredHandler (AUTH_TOKENS missing)", () => {
  const handler = unconfiguredHandler("No AUTH_TOKENS configured");

  test("GET /healthz stays alive with configured: false", async () => {
    const resp = await handler(new Request("http://localhost/healthz"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; configured: boolean; hint: string };
    expect(body.ok).toBe(false);
    expect(body.configured).toBe(false);
    expect(body.hint).toContain("UPSTREAM_BASE_URL");
  });

  test("API endpoints return a clear 503 until AUTH_TOKENS is set", async () => {
    const resp = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toContain("AUTH_TOKENS");
  });

  test("unknown paths return the same 503", async () => {
    const resp = await handler(new Request("http://localhost/v1/nope"));
    expect(resp.status).toBe(503);
  });
});
