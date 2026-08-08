/**
 * Web-native request handler for the freebuff2api proxy.
 *
 * Implements the same OpenAI-compatible surface as the CLI server
 * (`GET /healthz` liveness-only, `GET /v1/models`, `POST /v1/chat/completions`) but against
 * the standard Web `Request`/`Response` API, so the exact same code path can
 * be served by:
 *   - the standalone node:http server (`src/server.ts`, CLI / `bun run src/index.ts`)
 *   - Next.js route handlers (`app/v1/chat/completions/route.ts`, hosted deploys)
 *
 * All upstream logic (free session, agent run, CLI gate marker, error
 * classification, streaming) lives here and is shared by both runtimes.
 */

import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { ModelRegistry } from "./models.ts";
import type { RunManager } from "./runs.ts";
import { TOKEN_COOLDOWN_MS, WaitingRoomError, tokenLabel, type TokenManager } from "./session.ts";
import { UpstreamError, type UpstreamClient } from "./upstream.ts";
import { isPublicUpstreamFallbackStatus, type PublicUpstreamClient } from "./public-upstream.ts";

export const DEFAULT_MAX_BODY_BYTES = 16_000_000;

const SESSION_INVALID_ERRORS = new Set([
  "freebuff_update_required",
  "waiting_room_required",
  "waiting_room_queued",
  "session_superseded",
  "session_model_mismatch",
  "session_expired",
]);

/**
 * The free-tier gate on /api/v1/chat/completions rejects requests that don't
 * look like they came from the official Freebuff CLI (403 free_mode_cli_required).
 * Verified against the live backend, the check is the system message: it must
 * contain the exact phrase "You are Buffy, the strategic coding assistant"
 * (the official agent's system prompt opening). Every other field (stop,
 * provider, tools, user-agent version) is optional. We prepend/merge this
 * marker into the client's messages so the gate passes.
 */
const CLI_SYSTEM_MARKER =
  "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";
const CLI_SYSTEM_MARKER_PHRASE = "You are Buffy, the strategic coding assistant";

export interface HandlerDeps {
  cfg: Config;
  client: UpstreamClient;
  /** Optional anonymous/public provider, used before the authenticated path. */
  publicUpstream?: PublicUpstreamClient;
  registry: ModelRegistry;
  tokens: TokenManager;
  runs: RunManager;
  log: (message: string) => void;
  /** Server start time (ms epoch); used for /healthz uptime and model `created`. */
  startedAt?: number;
  /**
   * Map a presented API key to the upstream account token it stands for.
   * Used by the hosted web login flow: keys minted by the site (`sk-fb-…`)
   * resolve to the logged-in user's freebuff.com token, which is then used
   * for this request instead of the env-token pool. When absent (or for a
   * key it doesn't recognize) the env pool is used as before.
   */
  resolveTokenForApiKey?: (apiKey: string) => string | undefined;
}

/** Build a web-native request handler bound to the given dependencies. */
export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  const startedAt = deps.startedAt ?? Date.now();

  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;

    // API-key gate: /v1/* is protected so unauthenticated traffic never
    // touches upstream. /healthz (and the web landing page) stay public so
    // hosting health probes and status checks work without a key. A key is
    // valid when it is in the configured API_KEYS or it resolves to an
    // upstream token via the web-login key resolver.
    const gateRequired = deps.cfg.apiKeys.length > 0 || deps.resolveTokenForApiKey !== undefined;
    if (path !== "/healthz" && gateRequired && !isAuthorized(request, deps.cfg.apiKeys, deps.resolveTokenForApiKey)) {
      return openAIError(401, "invalid proxy api key", "authentication_error", "");
    }

    switch (path) {
      case "/healthz":
        if (request.method !== "GET") {
          return openAIError(405, "method not allowed", "invalid_request_error", "");
        }
        return healthz(deps, startedAt);
      case "/v1/models":
        if (request.method !== "GET") {
          return openAIError(405, "method not allowed", "invalid_request_error", "");
        }
        return models(deps, startedAt);
      case "/v1/chat/completions":
        return chatCompletions(deps, request);
      default:
        return openAIError(404, `unknown endpoint: ${path}`, "invalid_request_error", "not_found");
    }
  };
}

/** Extract the API key from `x-api-key` or `Authorization: Bearer <key>`. */
export function extractApiKey(request: Request): string | null {
  const direct = request.headers.get("x-api-key");
  if (direct && direct.trim()) return direct.trim();
  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1].trim() : null;
}

/**
 * Shared auth check: `x-api-key` header or `Authorization: Bearer <key>`.
 * A key is accepted when it is in `apiKeys` or (optionally) when the
 * web-login resolver maps it to an upstream token.
 */
export function isAuthorized(
  request: Request,
  apiKeys: string[],
  resolveToken?: (apiKey: string) => string | undefined,
): boolean {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  if (apiKeys.includes(apiKey)) return true;
  return resolveToken ? resolveToken(apiKey) !== undefined : false;
}

function healthz(deps: HandlerDeps, startedAt: number): Response {
  // Keep the public liveness contract deliberately small. Detailed model and
  // session state can contain account/queue identifiers and belongs in private
  // telemetry, not an unauthenticated endpoint.
  return json(200, {
    ok: true,
    started_at: new Date(startedAt).toISOString(),
    uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
  });
}

function models(deps: HandlerDeps, startedAt: number): Response {
  const created = Math.floor(startedAt / 1000);
  const modelIds = [...new Set([
    ...deps.registry.models(),
    ...(deps.cfg.publicUpstreamEnabled ? (deps.publicUpstream?.models() ?? deps.cfg.publicUpstreamModels) : []),
  ])].sort();
  const list = modelIds.map((model) => ({
    id: model,
    object: "model",
    created,
    owned_by: "freebuff2api",
    root: model,
    permission: [],
  }));
  return json(200, { object: "list", data: list });
}

async function chatCompletions(deps: HandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return openAIError(405, "method not allowed", "invalid_request_error", "");
  }

  const signal = request.signal;
  const maxBodyBytes = deps.cfg.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return openAIError(413, `request body exceeds ${maxBodyBytes} bytes`, "invalid_request_error", "body_too_large");
  }

  let rawBody: string;
  try {
    rawBody = await readBodyLimited(request, maxBodyBytes, signal);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return openAIError(413, `request body exceeds ${maxBodyBytes} bytes`, "invalid_request_error", "body_too_large");
    }
    if (signal.aborted) {
      return openAIError(499, "client closed request", "server_error", "");
    }
    throw error;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return openAIError(400, "request body must be valid JSON", "invalid_request_error", "");
  }

  const requestedModel = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!requestedModel) {
    return openAIError(400, "model is required", "invalid_request_error", "");
  }

  const started = Date.now();

  // Public OpenCode-compatible models are attempted first. The public client
  // receives only the JSON body, never the inbound Authorization/cookie or a
  // Freebuff account token. A non-retryable 4xx is returned directly; only a
  // pre-header transient failure permits the authenticated fallback path.
  if (deps.cfg.publicUpstreamEnabled && deps.publicUpstream?.hasModel(requestedModel)) {
    try {
      const publicResponse = await deps.publicUpstream.chatCompletions(rawBody, signal);
      if (publicResponse.status >= 200 && publicResponse.status < 300) {
        deps.log(`[public-upstream] completed (model: ${requestedModel}) with status ${publicResponse.status}`);
        return passthrough(publicResponse);
      }
      const publicBody = await publicResponse.text().catch(() => "");
      if (!isPublicUpstreamFallbackStatus(publicResponse.status)) {
        return upstreamError(publicResponse.status, publicResponse.headers.get("Retry-After"), publicBody);
      }
      deps.log(`[public-upstream] status ${publicResponse.status}; falling back to Freebuff`);
    } catch (error) {
      if (signal.aborted) return openAIError(499, "client closed request", "server_error", "");
      deps.log(`[public-upstream] unavailable; falling back to Freebuff: ${String(error)}`);
    }
  }

  const agentId = deps.registry.agentForModel(requestedModel);
  if (!agentId) {
    return openAIError(400, `unsupported model "${requestedModel}"`, "invalid_request_error", "model_not_found");
  }
  // A web-login key resolves to the account token that should serve this
  // request; everything below uses lease.poolToken, so the user's token is
  // carried through session/run/chat transparently.
  const upstreamToken = deps.resolveTokenForApiKey ? deps.resolveTokenForApiKey(extractApiKey(request) ?? "") : undefined;

  // A run/session invalid response is retried once with a fresh lease.
  for (let attempt = 0; attempt < 2; attempt++) {
    let lease: { poolToken: string; instanceId: string | null };
    try {
      const acquired = upstreamToken
        ? await deps.tokens.acquireUserSession(upstreamToken, requestedModel, signal)
        : await deps.tokens.acquireSession(requestedModel, signal);
      lease = { poolToken: acquired.pool.token, instanceId: acquired.instanceId };
    } catch (error) {
      if (error instanceof WaitingRoomError) {
        return openAIError(503, error.message, "server_error", "waiting_room_queued", error.retryAfterMs);
      }
      if (error instanceof UpstreamError && error.statusCode >= 400) {
        // Any upstream session-admission failure: preserve the real status,
        // Retry-After and message (429 / 401 / 500 / 503 / ...) instead of
        // masking it as a generic "no healthy token" 503. The official CLI
        // treats 429/503 on session POST as retryable with backoff, so
        // clients should see the same status + Retry-After to retry.
        const terminalModelCase = error.statusCode === 409 || error.statusCode === 403;
        const message = terminalModelCase || !error.errorCode ? error.message : error.errorCode;
        return openAIError(
          error.statusCode,
          message.slice(0, 300),
          "upstream_error",
          terminalModelCase ? (error.errorCode ?? "") : "",
          error.retryAfterMs,
        );
      }
      // Non-upstream failures (all tokens on cooldown, network errors without
      // a status) collapse to a generic retryable 503.
      return openAIError(503, "no healthy upstream token available", "server_error", "");
    }

    let runId: string;
    try {
      runId = await deps.runs.acquire(lease.poolToken, agentId, signal);
    } catch (error) {
      deps.tokens.invalidateSession(lease.poolToken, "run acquisition failed");
      return openAIError(502, `failed to start upstream agent run: ${String(error)}`, "server_error", "");
    }

    const upstreamBody = injectUpstreamMetadata(payload, requestedModel, runId, lease.instanceId);
    let upstream: Response;
    try {
      upstream = await deps.client.chatCompletions(lease.poolToken, upstreamBody, { signal });
    } catch (error) {
      // A transient transport/timeout error may belong to one token. Retry
      // once through the normal token/session picker; never retry a client
      // cancellation.
      if (attempt === 0 && !signal.aborted && isTransientUpstreamFailure(error)) {
        deps.tokens.invalidateSession(lease.poolToken, "transient upstream failure");
        continue;
      }
      return openAIError(502, `upstream request failed: ${String(error)}`, "server_error", "");
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      deps.log(
        `[${tokenLabel(lease.poolToken)}] completed (model: ${requestedModel}) in ${Date.now() - started}ms with status ${upstream.status}`,
      );
      return passthrough(upstream);
    }

    const errorBody = await upstream.text().catch(() => "");
    if (isSessionInvalid(upstream.status, errorBody)) {
      deps.log(`[${tokenLabel(lease.poolToken)}] free session invalid, refreshing and retrying`);
      deps.tokens.invalidateSession(lease.poolToken, errorBody.trim() || "session invalid");
      deps.runs.invalidate(lease.poolToken, agentId);
      continue;
    }
    if (isRunInvalid(upstream.status, errorBody)) {
      deps.log(`[${tokenLabel(lease.poolToken)}] run invalid, rotating and retrying`);
      deps.runs.invalidate(lease.poolToken, agentId);
      continue;
    }
    if (upstream.status === 401) {
      deps.tokens.cooldown(lease.poolToken, TOKEN_COOLDOWN_MS, "upstream auth rejected token");
      deps.tokens.invalidateSession(lease.poolToken, "upstream auth rejected token");
    }

    return upstreamError(upstream.status, upstream.headers.get("Retry-After"), errorBody);
  }

  return openAIError(502, "upstream run expired twice in a row", "server_error", "");
}

/** Copy a 2xx upstream response (JSON or SSE) to the client, dropping hop-by-hop headers. */
function passthrough(upstream: Response): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // fetch() transparently decompresses upstream bodies but may retain the
    // original content-encoding header; re-pipe already-decoded bytes.
    if (["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"].includes(lower)) {
      return;
    }
    headers.set(key, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}

function upstreamError(statusCode: number, retryAfter: string | null, body: string): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (retryAfter) headers.set("Retry-After", retryAfter);
  const trimmed = body.trim();
  let parsed: { error?: unknown; message?: unknown } | null = null;
  try {
    parsed = trimmed ? (JSON.parse(trimmed) as { error?: unknown; message?: unknown }) : null;
  } catch {
    parsed = null;
  }
  if (parsed) {
    if (typeof parsed.error === "string") {
      return new Response(JSON.stringify({ error: { message: parsed.error, type: "upstream_error", code: parsed.error } }), {
        status: statusCode,
        headers,
      });
    }
    if (parsed.error && typeof parsed.error === "object") {
      const e = parsed.error as { message?: unknown; type?: unknown; code?: unknown };
      const message = typeof e.message === "string" ? e.message : trimmed.slice(0, 500);
      const type = typeof e.type === "string" ? e.type : "upstream_error";
      const error: Record<string, string> = { message: message || "error", type };
      if (typeof e.code === "string" && e.code) error.code = e.code;
      return new Response(JSON.stringify({ error }), { status: statusCode, headers });
    }
    if (typeof parsed.message === "string") {
      return new Response(
        JSON.stringify({ error: { message: parsed.message || "error", type: "upstream_error" } }),
        { status: statusCode, headers },
      );
    }
  }
  return new Response(
    JSON.stringify({
      error: { message: trimmed.slice(0, 500) || `upstream error (status ${statusCode})`, type: "upstream_error" },
    }),
    { status: statusCode, headers },
  );
}

function openAIError(
  statusCode: number,
  message: string,
  type: string,
  code: string,
  retryAfterMs?: number,
): Response {
  const error: Record<string, string> = { message: message || "error", type: type || "server_error" };
  if (code) error.code = code;
  const headers = new Headers({ "Content-Type": "application/json" });
  if (retryAfterMs) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }
  return new Response(JSON.stringify({ error }), { status: statusCode, headers });
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

async function readBodyLimited(request: Request, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("client closed request", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function isTransientUpstreamFailure(error: unknown): boolean {
  if (error instanceof UpstreamError) return error.statusCode === 0 || error.statusCode >= 500;
  return error instanceof TypeError || (error instanceof Error && /timeout|network|fetch|socket/i.test(error.message));
}

function isSessionInvalid(statusCode: number, body: string): boolean {
  if (statusCode < 400) return false;
  let parsed: { error?: unknown };
  try {
    parsed = JSON.parse(body) as { error?: unknown };
  } catch {
    return false;
  }
  const code = typeof parsed.error === "string" ? parsed.error : (parsed.error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SESSION_INVALID_ERRORS.has(code.trim());
}

function isRunInvalid(statusCode: number, body: string): boolean {
  if (statusCode !== 400) return false;
  return /runid not found|runid not running/i.test(body);
}

function injectUpstreamMetadata(
  payload: Record<string, unknown>,
  model: string,
  runId: string,
  instanceId: string | null,
): string {
  const cloned: Record<string, unknown> = { ...payload };
  cloned.model = model;

  const metadata: Record<string, string> = {
    run_id: runId,
    client_id: generateClientSessionId(),
    cost_mode: "free",
    // The official SDK attaches these to every chat request (captured via MITM).
    trace_session_id: randomUUID(),
    llm_step_number: "1",
  };
  if (instanceId) metadata.freebuff_instance_id = instanceId;

  const existing = cloned.codebuff_metadata;
  if (existing && typeof existing === "object") {
    cloned.codebuff_metadata = { ...(existing as Record<string, unknown>), ...metadata };
  } else {
    cloned.codebuff_metadata = metadata;
  }

  // The official CLI's free agents carry providerOptions that get flattened
  // into the request body as `provider` (see agents/base2 getBase2ProviderOptions
  // in CodebuffAI/freebuff). Include it to mirror the official request shape.
  if (cloned.provider === undefined) {
    cloned.provider = { data_collection: "deny" };
  }

  // The free-tier gate requires the system message to carry the official CLI's
  // agent-identity marker; inject it without clobbering the client's prompt.
  injectCliSystemMarker(cloned);

  return JSON.stringify(cloned);
}

/**
 * Ensure the request's system message contains the CLI-identity phrase that
 * the free-tier gate checks for (403 free_mode_cli_required otherwise).
 * Merges into the client's first system message when present, or prepends a
 * standalone system message.
 */
function injectCliSystemMarker(payload: Record<string, unknown>): void {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;
  const already = messages.some(
    (m) =>
      m &&
      typeof m === "object" &&
      (m as { role?: unknown }).role === "system" &&
      typeof (m as { content?: unknown }).content === "string" &&
      ((m as { content: string }).content.includes(CLI_SYSTEM_MARKER_PHRASE)),
  );
  if (already) return;

  const firstSystem = messages.findIndex(
    (m) => m && typeof m === "object" && (m as { role?: unknown }).role === "system",
  );
  if (firstSystem === -1) {
    messages.unshift({ role: "system", content: CLI_SYSTEM_MARKER });
    return;
  }
  const existing = messages[firstSystem] as Record<string, unknown>;
  const content = existing.content;
  if (typeof content === "string" && content.length > 0) {
    existing.content = `${CLI_SYSTEM_MARKER}\n\n${content}`;
  } else {
    existing.content = CLI_SYSTEM_MARKER;
  }
}

/** Math.random().toString(36).substring(2, 15) — the official SDK's session id. */
function generateClientSessionId(): string {
  return Math.random().toString(36).slice(2, 15);
}
