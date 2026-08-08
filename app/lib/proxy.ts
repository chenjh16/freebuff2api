/**
 * Next.js bootstrap for the hosted freebuff2api deployment.
 *
 * The hosted app is a Next.js app that mounts the exact same web-native
 * request handler as the standalone CLI server (`src/handler.ts`) behind
 * Next.js App Router route handlers:
 *
 *   GET  /healthz               liveness-only status
 *   GET  /v1/models             available free models
 *   POST /v1/chat/completions   OpenAI chat completions → Freebuff backend
 *   POST /api/auth/start        start a device-code login (web login flow)
 *   GET  /api/auth/status       poll the login status
 *   POST /api/auth/register     validate the account token, mint an API key
 *   POST /api/auth/revoke       revoke an API key (logout)
 *
 * Two ways to get upstream tokens:
 *   - `AUTH_TOKENS` env (or `freebuff2api login` credentials on a machine)
 *     feeds the shared token pool — requests whose key is in `API_KEYS` use it.
 *   - the web login flow mints `sk-fb-…` keys that resolve to the logged-in
 *     user's own freebuff.com token (`resolveApiKeyToken`), so no account
 *     token ever has to be shared by everyone.
 */

import { createHandler } from "../../src/handler.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import { UpstreamClient } from "../../src/upstream.ts";
import { createPublicUpstreamRouter } from "../../src/public-upstream.ts";
import { ModelRegistry } from "../../src/models.ts";
import { TokenManager } from "../../src/session.ts";
import { RunManager } from "../../src/runs.ts";
import { resolveApiKeyToken } from "./account.ts";

function log(message: string): void {
  console.log(`[freebuff2api] ${message}`);
}

/**
 * Resolve the proxy API keys from the environment, falling back to the hosted
 * environment. An unset value intentionally produces an empty list: hosted
 * web-login keys are resolved separately, while shared keys must be explicitly
 * provisioned rather than relying on a predictable public credential.
 */
export function resolveApiKeys(env: Record<string, string | undefined>): string[] {
  const raw = env.API_KEYS;
  if (raw && raw.trim()) {
    return [...new Set(raw.split(/[,;\n\r]/).map((item) => item.trim()).filter((item) => item.length > 0))];
  }
  return [];
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

/**
 * Shared runtime: config (token-optional — the web login flow serves requests
 * with per-user tokens even when AUTH_TOKENS is unset) plus an UpstreamClient.
 * Cached per process; used by both the proxy handler and the /api/auth routes.
 */
let runtimePromise: Promise<{ cfg: Config; client: UpstreamClient }> | null = null;

export function getRuntime(): Promise<{ cfg: Config; client: UpstreamClient }> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      // Hosted web-login mode is intentionally token-optional. Shared client
      // keys, when desired, must be explicitly configured via API_KEYS.
      const cfg = loadConfig({ requireToken: false });
      const client = new UpstreamClient({
        baseURL: cfg.upstreamBaseURL,
        requestTimeoutMs: cfg.requestTimeoutMs,
        userAgent: cfg.userAgent,
        actingUserId: cfg.actingUserId,
      });
      return { cfg, client };
    })();
  }
  return runtimePromise;
}

async function buildHandler(): Promise<(request: Request) => Promise<Response>> {
  let cfg: Config;
  let client: UpstreamClient;
  try {
    ({ cfg, client } = await getRuntime());
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

  const registry = new ModelRegistry(fetch, log);
  await registry.start();
  const tokens = new TokenManager(cfg.authTokens, client, log);
  const runs = new RunManager(client, cfg.rotationIntervalMs, log);
  const publicUpstream = cfg.publicUpstreamEnabled
    ? createPublicUpstreamRouter({
        providers: cfg.publicUpstreamProviders,
        models: cfg.publicUpstreamModels,
        baseURL: cfg.publicUpstreamBaseURL,
        timeoutMs: cfg.publicUpstreamTimeoutMs,
      })
    : undefined;
  log(
    `web handler ready: upstream=${cfg.upstreamBaseURL} poolTokens=${cfg.authTokens.length} ` +
      `apiKeys=${cfg.apiKeys.length > 0 ? "required" : "open"} webLogin=sk-fb-keys`,
  );
  return createHandler({
    cfg,
    client,
    publicUpstream,
    registry,
    tokens,
    runs,
    log,
    resolveTokenForApiKey: resolveApiKeyToken,
  });
}

/**
 * Handler used while the proxy has no usable configuration. /healthz stays
 * alive (200, configured: false) so hosting health probes and the landing
 * page can tell "deploy is up" from "proxy needs configuration"; everything
 * else returns a clear 503.
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
          hint: "Check UPSTREAM_BASE_URL / LOGIN_BASE_URL in the deployment environment.",
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
        message: `proxy is not configured: ${message}. Check the deployment environment.`,
        type: "server_error",
      },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}
