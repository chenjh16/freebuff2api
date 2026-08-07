#!/usr/bin/env node
/**
 * Model availability probe for freebuff2api.
 *
 * Usage:
 *   node tools/model-availability.mjs --base-url http://127.0.0.1:23333/v1
 *   node tools/model-availability.mjs --base-url http://127.0.0.1:23333/v1 --models a,b --json
 *
 * The probe first reads GET /models, then sends one small non-streaming chat
 * request per model. It never prints credentials; pass --api-key only when the
 * local proxy requires one. Live probing consumes upstream quota.
 */

const args = process.argv.slice(2);

function printHelp() {
  console.log(`freebuff2api model availability probe

Usage:
  node tools/model-availability.mjs [options]

Options:
  --base-url <url>       OpenAI-compatible base URL (default http://127.0.0.1:23333/v1)
  --api-key <key>        optional local proxy key (or FB2API_API_KEY)
  --models <a,b,c>       probe an explicit comma-separated model list
  --timeout-ms <ms>      per-request timeout (default 120000)
  --concurrency <n>      maximum parallel probes (default 3)
  --json                 print machine-readable JSON results
  --help                 show this help

The probe is opt-in because every chat request can consume upstream quota.`);
}

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

function value(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}

const baseURL = value("--base-url", process.env.FB2API_BASE_URL ?? "http://127.0.0.1:23333/v1").replace(/\/+$/, "");
const apiKey = value("--api-key", process.env.FB2API_API_KEY ?? "");
const timeoutMs = positiveInteger(value("--timeout-ms", process.env.FB2API_PROBE_TIMEOUT_MS ?? "120000"), 120_000);
const concurrency = positiveInteger(value("--concurrency", process.env.FB2API_PROBE_CONCURRENCY ?? "3"), 3);
const explicitModels = value("--models", "");
const jsonOutput = args.includes("--json");

function positiveInteger(raw, fallback) {
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function headers() {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

async function request(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function probeModel(model) {
  const started = Date.now();
  try {
    const response = await request(`${baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: MODEL_PROBE_OK" }] }),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep only a bounded diagnostic below.
    }
    const content = body?.choices?.[0]?.message?.content ?? "";
    return {
      model,
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      content: String(content).slice(0, 160),
      error: body?.error?.message ?? (response.ok ? undefined : text.slice(0, 160)),
    };
  } catch (error) {
    return {
      model,
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: String(error).slice(0, 160),
    };
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function main() {
  const modelsResponse = await request(`${baseURL}/models`, { method: "GET" });
  if (!modelsResponse.ok) throw new Error(`GET /models failed: HTTP ${modelsResponse.status}`);
  const listed = (await modelsResponse.json()).data ?? [];
  const models = explicitModels
    ? explicitModels.split(",").map((x) => x.trim()).filter(Boolean)
    : listed.map((x) => x.id).filter(Boolean);
  if (models.length === 0) throw new Error("No models returned; pass --models model-a,model-b to probe explicitly");

  const results = await mapWithConcurrency(models, concurrency, probeModel);

  if (jsonOutput) {
    console.log(JSON.stringify({ baseURL, count: results.length, concurrency, results }, null, 2));
    if (results.some((result) => !result.ok)) process.exitCode = 1;
    return;
  }
  console.log(`Model availability: ${baseURL} (${results.length} models, concurrency ${concurrency})`);
  for (const result of results) {
    console.log(`${result.ok ? "OK  " : "FAIL"} ${result.model} HTTP ${result.status} ${result.latencyMs}ms${result.error ? ` — ${result.error}` : ""}`);
  }
  const passed = results.filter((result) => result.ok).length;
  console.log(`Summary: ${passed}/${results.length} models responded successfully.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[model-availability] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
