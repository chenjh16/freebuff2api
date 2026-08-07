/**
 * Opt-in model availability test.
 *
 * Run with LIVE_MODEL_TEST=1 and a running proxy:
 *   LIVE_MODEL_TEST=1 bun test ./tests/e2e/model-availability.test.ts --timeout 180000
 *
 * This is intentionally opt-in because each model probe consumes upstream quota.
 */
import { describe, expect, test } from "bun:test";

const enabled = process.env.LIVE_MODEL_TEST === "1";
const baseURL = (process.env.FB2API_BASE_URL ?? "http://127.0.0.1:23333/v1").replace(/\/+$/, "");
const apiKey = process.env.FB2API_API_KEY;

describe.skipIf(!enabled)("live model availability", () => {
  test("every advertised model accepts a minimal chat request", async () => {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const listedResponse = await fetch(`${baseURL}/models`, { headers });
    expect(listedResponse.ok).toBe(true);
    const listed = (await listedResponse.json()) as { data: { id: string }[] };
    expect(listed.data.length).toBeGreaterThan(0);

    const results = await Promise.all(
      listed.data.map(async ({ id }) => {
        const response = await fetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Reply with exactly: MODEL_PROBE_OK" }] }),
          signal: AbortSignal.timeout(120_000),
        });
        return { id, status: response.status, body: await response.text() };
      }),
    );

    for (const result of results) {
      expect(result.status, `${result.id}: ${result.body.slice(0, 300)}`).toBeGreaterThanOrEqual(200);
      expect(result.status, `${result.id}: ${result.body.slice(0, 300)}`).toBeLessThan(300);
    }
  });
});
