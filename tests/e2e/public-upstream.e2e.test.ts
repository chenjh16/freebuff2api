/**
 * Live E2E coverage for the aggregated public (no-auth) upstreams.
 *
 * Starts the real proxy without AUTH_TOKENS and verifies, through the proxy:
 *   - the /v1/models catalog (canonical ids + bare aliases)
 *   - every public chat model answers /v1/chat/completions
 *   - every public image model answers /v1/images/generations
 *   - bare aliases route to their owning provider
 *
 * Run explicitly because it makes many real external requests. The sweep is
 * split into provider groups so each group fits comfortably in a runner
 * timeout; run all groups with:
 *   LIVE_PUBLIC_UPSTREAM_TEST=1 bun test ./tests/e2e/public-upstream.e2e.test.ts --timeout 600000
 * or a single group with -t (e.g. -t "pollinations").
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROGRESS_LOG = process.env.PUBLIC_E2E_PROGRESS_LOG ?? "/tmp/public-e2e-progress.log";
function progress(line: string): void {
  console.log(line);
  try {
    appendFileSync(PROGRESS_LOG, `${line}\n`);
  } catch {
    // Logging must never break the test.
  }
}

import {
  DEFAULT_FELO_MODELS,
  DEFAULT_OPENCODE_MODELS,
  DEFAULT_POLLINATIONS_IMAGE_MODELS,
  DEFAULT_POLLINATIONS_MODELS,
} from "../../src/public-upstream.ts";

const enabled = process.env.LIVE_PUBLIC_UPSTREAM_TEST === "1";
const OPENCODE_MODELS = [...DEFAULT_OPENCODE_MODELS];
const POLLINATIONS_MODELS = DEFAULT_POLLINATIONS_MODELS.map((model) => `pollinations/${model}`);
const FELO_MODELS = DEFAULT_FELO_MODELS.map((model) => `felo/${model}`);
const IMAGE_MODELS = DEFAULT_POLLINATIONS_IMAGE_MODELS.map((model) => `pollinations/${model}`);
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
      PUBLIC_UPSTREAM_MODELS: [...OPENCODE_MODELS, ...POLLINATIONS_MODELS, ...FELO_MODELS].join(","),
      PUBLIC_UPSTREAM_IMAGE_MODELS: IMAGE_MODELS.join(","),
      // Keep the default 20s provider header timeout so transient provider
      // stalls fail fast and the probe's backoff retry can move on quickly.
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

/**
 * Probe a chat model through the proxy with backoff retries for transient
 * provider throttling (401/408/425/429/5xx). Public providers occasionally
 * reject short bursts even for valid anonymous models.
 */
/**
 * Probe a chat model through the proxy with retries. Pollinations' anonymous
 * chat tier intermittently returns 401 "Authentication required" (verified
 * live: the same prompt alternates 200/401), so transient statuses are retried
 * with a fast escalating backoff until a 200 window is hit.
 */
async function probeChat(model: string): Promise<{ model: string; ok: boolean; detail: string }> {
  const backoff = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
  let last = "no attempt";
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const response = await fetch(`${baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          // Pollinations' anonymous chat tier rejects many prompt shapes with
          // 401 (verified live: "Reply with exactly: …" 401s 10/10, "hi" 200s
          // 20/20, "Say hello" 401s for most models). The probe therefore uses
          // the most benign prompt, which every anonymous pollinations model
          // accepts; the proxy path itself is what this suite verifies.
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (response.status >= 200 && response.status < 300) {
        const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
        const content = body?.choices?.[0]?.message?.content ?? "";
        return { model, ok: content.trim().length > 0, detail: `content ${JSON.stringify(content.slice(0, 60))}` };
      }
      last = `status ${response.status}`;
      if (response.status === 401 || response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        await Bun.sleep(backoff[attempt] ?? 15_000);
        continue;
      }
      return { model, ok: false, detail: last };
    } catch (error) {
      last = `error ${String(error).slice(0, 120)}`;
      await Bun.sleep(backoff[attempt] ?? 15_000);
    }
  }
  return { model, ok: false, detail: `retries exhausted, last ${last}` };
}

/** Probe an image model through the proxy with the same transient retry policy. */
async function probeImage(model: string): Promise<{ model: string; ok: boolean; detail: string }> {
  const backoff = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
  let last = "no attempt";
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const response = await fetch(`${baseURL}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: "a tiny red circle on a white background",
          size: "256x256",
          n: 1,
          response_format: "b64_json",
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status >= 200 && response.status < 300) {
        const body = (await response.json().catch(() => null)) as { data?: { b64_json?: string }[] } | null;
        const b64 = body?.data?.[0]?.b64_json ?? "";
        return { model, ok: b64.length > 64, detail: `b64 length ${b64.length}` };
      }
      last = `status ${response.status}`;
      if (response.status === 401 || response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        await Bun.sleep(backoff[attempt] ?? 15_000);
        continue;
      }
      return { model, ok: false, detail: last };
    } catch (error) {
      last = `error ${String(error).slice(0, 120)}`;
      await Bun.sleep(backoff[attempt] ?? 15_000);
    }
  }
  return { model, ok: false, detail: `retries exhausted, last ${last}` };
}

/** Pace one probe at a time with a small gap so anonymous providers are not burst-flooded. */
async function probeSequentially<T extends { model: string; ok: boolean; detail: string }>(
  models: string[],
  probe: (model: string) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (const model of models) {
    const result = await probe(model);
    progress(`[e2e] ${result.ok ? "PASS" : "FAIL"} ${model}: ${result.detail}`);
    results.push(result);
    await Bun.sleep(750);
  }
  return results;
}

function expectNoFailures(results: { model: string; ok: boolean; detail: string }[]): void {
  const failures = results.filter((result) => !result.ok);
  expect(failures, failures.map((f) => `${f.model}: ${f.detail}`).join("\n")).toEqual([]);
}

describe.skipIf(!enabled)("aggregated public upstreams (live)", () => {
  test("catalog lists canonical ids and bare aliases from /v1/models", async () => {
    const modelsResponse = await fetch(`${baseURL}/v1/models`);
    expect(modelsResponse.status).toBe(200);
    const models = (await modelsResponse.json()) as { data: { id: string }[] };
    const ids = models.data.map((item) => item.id);

    for (const model of [...OPENCODE_MODELS, ...POLLINATIONS_MODELS, ...FELO_MODELS, ...IMAGE_MODELS]) {
      expect(ids).toContain(model);
    }
    expect(ids).toContain("opencode/big-pickle");
    expect(ids).toContain("openai");
    expect(ids).toContain("felo-chat");
    expect(ids).toContain("flux");
    expect(ids).toContain("pollinations/flux");
  });

  test("opencode chat models answer through the proxy", async () => {
    expectNoFailures(await probeSequentially(OPENCODE_MODELS, probeChat));
  });

  test("pollinations chat models answer through the proxy", async () => {
    expectNoFailures(await probeSequentially(POLLINATIONS_MODELS, probeChat));
  });

  test("felo chat models answer through the proxy", async () => {
    expectNoFailures(await probeSequentially(FELO_MODELS, probeChat));
  });

  test("bare aliases route to their owning public provider", async () => {
    expectNoFailures(await probeSequentially(["big-pickle", "openai", "felo-chat"], probeChat));
  });

  test("pollinations image models generate a base64 image through /v1/images/generations", async () => {
    expectNoFailures(await probeSequentially(IMAGE_MODELS, probeImage));
  });
});
