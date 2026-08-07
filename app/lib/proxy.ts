/**
 * Next.js bootstrap for the hosted freebuff2api deployment.
 *
 * The hosted app is a Next.js app that mounts the exact same web-native
 * request handler as the standalone CLI server (`src/handler.ts`) behind
 * Next.js App Router route handlers:
 *
 *   GET  /healthz               liveness + token/session state
 *   GET  /v1/models             available free models
 *   POST /v1/chat/completions   OpenAI chat completions → Freebuff backend
 *
 * Environment (hosted deployment):
 *   AUTH_TOKENS   Freebuff auth tokens (REQUIRED for the proxy to serve chats)
 *   API_KEYS      keys clients must present; defaults to sk-freebuff2api-2026
 *                 when unset so the public endpoint is never left open.
 *   All other config options from `src/config.ts` apply as usual.
 */

import { createHandler } from "../../src/handler.ts";
import { loadConfig } from "../../src/config.ts";
import { UpstreamClient } from "../../src/upstream.ts";
import { ModelRegistry } from "../../src/models.ts";
import { TokenManager } from "../../src/session.ts";
import { RunManager } from "../../src/runs.ts";

/** Default proxy API key used by the hosted deployment when API_KEYS is unset. */
export const DEFAULT_API_KEYS = ["sk-freebuff2api-2026"];

function log(message: string): void {
  console.log(`[freebuff2api] ${message}`);
}

/**
 * Resolve the proxy API keys from the environment, falling back to the hosted
 * deployment default. Exported as a pure function so unit tests can verify the
 * precedence without touching process.env.
 */
export function resolveApiKeys(env: Record<string, string | undefined>): string[] {
  const raw = env.API_KEYS;
  if (raw && raw.trim()) {
    return [...new Set(raw.split(/[,;\n\r]/).map((item) => item.trim()).filter((item) => item.length > 0))];
  }
  return [...DEFAULT_API_KEYS];
}

let handlerPromise: Promise<(request: Request) => Promise<Response>> | null = null;

/**
 * Lazily build the shared request handler. The proxy engine (session pool,
 * run manager, model registry) is stateful, so it is created once per server
 * process and reused across requests.
 */
export function getHandler(): Promise<(request: Request) => Promise<Response>> {
  if (!handlerPromise) {
    handlerPromise = buildHandler();
  }
  return handlerPromise;
}

async function buildHandler(): Promise<(request: Request) => Promise<Response>> {
  let cfg;
  try {
    // Hosted default: protect the public endpoint with the deploy API key when
    // API_KEYS is not explicitly configured. An explicit env value wins.
    cfg = loadConfig(process.env.API_KEYS?.trim() ? {} : { apiKeys: DEFAULT_API_KEYS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`proxy not configured: ${message}`);
    return unconfiguredHandler(message);
  }

  // Best-effort mirror of the CLI's HTTP_PROXY handling for runtimes whose
  // fetch honors these variables.
  if (cfg.httpProxy) {
    process.env.HTTP_PROXY = cfg.httpProxy;
    process.env.HTTPS_PROXY = cfg.httpProxy;
  }

  const client = new UpstreamClient({
    baseURL: cfg.upstreamBaseURL,
    requestTimeoutMs: cfg.requestTimeoutMs,
    userAgent: cfg.userAgent,
    actingUserId: cfg.actingUserId,
  });
  const registry = new ModelRegistry(fetch, log);
  await registry.start();
  const tokens = new TokenManager(cfg.authTokens, client, log);
  const runs = new RunManager(client, cfg.rotationIntervalMs, log);
  log(
    `web handler ready: upstream=${cfg.upstreamBaseURL} tokens=${cfg.authTokens.length} ` +
      `apiKeys=${cfg.apiKeys.length > 0 ? "required" : "open"}`,
  );
  return createHandler({ cfg, client, registry, tokens, runs, log });
}

/**
 * Handler used while the proxy has no configured auth tokens. /healthz stays
 * alive (200, configured: false) so hosting health probes and the landing page
 * can tell "deploy is up" from "proxy needs AUTH_TOKENS"; everything else
 * returns a clear 503.
 */
export function unconfiguredHandler(message: string): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") {
      return new Response(
        JSON.stringify({
          ok: false,
          configured: false,
          error: message,
          hint: "Set AUTH_TOKENS (your freebuff.com account token — get it with `freebuff2api login`; this is NOT the proxy API key) in the deployment environment, then redeploy.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return configErrorResponse(message);
  };
}

/**
 * Dispatch a web API request (route handlers call this). OPTIONS preflights are
 * answered separately by `corsPreflight`; every real request is delegated to
 * the shared proxy handler and returned with permissive CORS headers.
 */
export async function apiRoute(request: Request): Promise<Response> {
  const handler = await getHandler();
  const response = await handler(request);
  return applyCors(response);
}

/** Answer CORS preflight requests (204). */
export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export function applyCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders())) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key",
    "Access-Control-Max-Age": "86400",
  };
}

/** A stable error shape for configuration failures surfaced by the web app. */
export function configErrorResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `proxy is not configured: ${message}. Set AUTH_TOKENS (and optionally API_KEYS) in the deploy environment.`,
        type: "server_error",
      },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}
