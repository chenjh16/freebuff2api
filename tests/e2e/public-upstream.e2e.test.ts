/**
 * Live E2E coverage for the default public OpenCode route.
 *
 * Run explicitly because it makes a real external request:
 *   LIVE_PUBLIC_UPSTREAM_TEST=1 bun test ./tests/e2e/public-upstream.e2e.test.ts --timeout 120000
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.LIVE_PUBLIC_UPSTREAM_TEST === "1";
const model = "big-pickle";
const configDir = mkdtempSync(join(tmpdir(), "freebuff2api-public-e2e-"));

let proc: ReturnType<typeof Bun.spawn> | null = null;
let baseURL = "";

async function startProxy(): Promise<void> {
  const port = 19_000 + Math.floor(Math.random() * 500);
  proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: {
      ...process.env,
      LISTEN_ADDR: `:${port}`,
      PORT: "",
      AUTH_TOKENS: "",
      FREEBUFF2API_CONFIG_DIR: configDir,
      PUBLIC_UPSTREAM_MODELS: model,
      // Deliberately omit PUBLIC_UPSTREAM_ENABLED: this test verifies the default.
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error("public E2E proxy exited before becoming ready");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        baseURL = `http://127.0.0.1:${port}`;
        return;
      }
    } catch {
      // The model registry and server are still starting.
    }
    await Bun.sleep(500);
  }
  throw new Error("public E2E proxy did not become ready");
}

async function stopProxy(): Promise<void> {
  if (!proc) return;
  proc.kill("SIGTERM");
  await Promise.race([proc.exited.catch(() => undefined), Bun.sleep(10_000)]);
  proc = null;
}

beforeAll(async () => {
  if (enabled) await startProxy();
});

afterAll(async () => {
  await stopProxy();
  rmSync(configDir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("default public OpenCode upstream (live)", () => {
  test("serves models and chat completions without AUTH_TOKENS", async () => {
    const modelsResponse = await fetch(`${baseURL}/v1/models`);
    expect(modelsResponse.status).toBe(200);
    const models = (await modelsResponse.json()) as { data: { id: string }[] };
    expect(models.data.map((item) => item.id)).toContain(model);

    const chatResponse = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: "Reply with exactly NOAUTH_DEFAULT_PROXY_OK" }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    expect(chatResponse.status).toBe(200);
    const body = (await chatResponse.json()) as { choices?: { message?: { content?: string } }[] };
    expect(body.choices?.[0]?.message?.content ?? "").toMatch(/NOAUTH_DEFAULT_PROXY_OK/i);
  });
});
