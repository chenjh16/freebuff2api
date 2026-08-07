/**
 * OpenAI-compatible HTTP server.
 *
 *   GET  /healthz               liveness + token/session state
 *   GET  /v1/models             available free models
 *   POST /v1/chat/completions   OpenAI chat completions → Freebuff backend
 *
 * The proxy translates a standard OpenAI request into a Freebuff API request by
 * acquiring a free session, starting (or reusing) an agent run, and injecting
 * the `codebuff_metadata` block the backend expects.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import type { ModelRegistry } from "./models.ts";
import { RunManager } from "./runs.ts";
import { TokenManager, WaitingRoomError, TOKEN_COOLDOWN_MS, tokenLabel } from "./session.ts";
import { UpstreamClient, UpstreamError } from "./upstream.ts";

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

export interface ServerDeps {
  cfg: Config;
  client: UpstreamClient;
  registry: ModelRegistry;
  tokens: TokenManager;
  runs: RunManager;
  log: (message: string) => void;
}

export class Server {
  private readonly startedAt = Date.now();
  private server = createServer((req, res) => {
    void this.dispatch(req, res);
  });

  constructor(private readonly deps: ServerDeps) {}

  listen(port: number, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.removeListener("error", reject);
        this.deps.log(`listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Return the OS-assigned listening port (mainly useful to test harnesses). */
  listeningPort(): number | null {
    const address = this.server.address();
    return address && typeof address === "object" ? address.port : null;
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.deps.cfg.apiKeys.length > 0 && !this.authorized(req)) {
        this.writeOpenAIError(res, 401, "invalid proxy api key", "authentication_error", "");
        return;
      }

      const path = (req.url ?? "").split("?")[0];
      switch (path) {
        case "/healthz":
          await this.handleHealthz(req, res);
          return;
        case "/v1/models":
          await this.handleModels(req, res);
          return;
        case "/v1/chat/completions":
          await this.handleChatCompletions(req, res);
          return;
        default:
          this.writeOpenAIError(res, 404, `unknown endpoint: ${path}`, "invalid_request_error", "not_found");
      }
    } catch (error) {
      this.deps.log(`[server] unhandled error: ${String(error)}`);
      if (!res.headersSent) {
        this.writeOpenAIError(res, 500, "internal server error", "server_error", "");
      } else {
        res.end();
      }
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.trim() && this.deps.cfg.apiKeys.includes(apiKey.trim())) {
      return true;
    }
    const auth = req.headers.authorization;
    if (typeof auth !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!match) return false;
    return this.deps.cfg.apiKeys.includes(match[1].trim());
  }

  private async handleHealthz(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      this.writeOpenAIError(res, 405, "method not allowed", "invalid_request_error", "");
      return;
    }
    this.writeJSON(res, 200, {
      ok: true,
      started_at: new Date(this.startedAt).toISOString(),
      uptime_sec: Math.floor((Date.now() - this.startedAt) / 1000),
      upstream: this.deps.cfg.upstreamBaseURL,
      user_agent: this.deps.cfg.userAgent,
      acting_user_id: this.deps.cfg.actingUserId,
      models: this.deps.registry.status(),
      tokens: this.deps.tokens.snapshots(),
    });
  }

  private async handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      this.writeOpenAIError(res, 405, "method not allowed", "invalid_request_error", "");
      return;
    }
    const created = Math.floor(this.startedAt / 1000);
    const models = this.deps.registry.models().map((model) => ({
      id: model,
      object: "model",
      created,
      owned_by: "freebuff2api",
      root: model,
      permission: [],
    }));
    this.writeJSON(res, 200, { object: "list", data: models });
  }

  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      this.writeOpenAIError(res, 405, "method not allowed", "invalid_request_error", "");
      return;
    }

    const rawBody = await readBody(req);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      this.writeOpenAIError(res, 400, "request body must be valid JSON", "invalid_request_error", "");
      return;
    }

    const requestedModel = typeof payload.model === "string" ? payload.model.trim() : "";
    if (!requestedModel) {
      this.writeOpenAIError(res, 400, "model is required", "invalid_request_error", "");
      return;
    }

    const agentId = this.deps.registry.agentForModel(requestedModel);
    if (!agentId) {
      this.writeOpenAIError(res, 400, `unsupported model "${requestedModel}"`, "invalid_request_error", "model_not_found");
      return;
    }

    // Abort the upstream request when the client disconnects.
    const abort = new AbortController();
    res.once("close", () => abort.abort());

    const started = Date.now();
    // A run/session invalid response is retried once with a fresh lease.
    for (let attempt = 0; attempt < 2; attempt++) {
      let lease: { poolToken: string; instanceId: string | null };
      try {
        const { pool, instanceId } = await this.deps.tokens.acquireSession(abort.signal);
        lease = { poolToken: pool.token, instanceId };
      } catch (error) {
        if (error instanceof WaitingRoomError) {
          res.setHeader("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
          this.writeOpenAIError(res, 503, error.message, "server_error", "waiting_room_queued");
        } else {
          if (error instanceof UpstreamError && error.retryAfterMs) {
            res.setHeader("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
          }
          this.writeOpenAIError(res, 503, `no healthy upstream token available: ${String(error)}`, "server_error", "");
        }
        return;
      }

      let runId: string;
      try {
        runId = await this.deps.runs.acquire(lease.poolToken, agentId, abort.signal);
      } catch (error) {
        this.deps.tokens.invalidateSession(lease.poolToken, "run acquisition failed");
        this.writeOpenAIError(res, 502, `failed to start upstream agent run: ${String(error)}`, "server_error", "");
        return;
      }

      const upstreamBody = injectUpstreamMetadata(payload, requestedModel, runId, lease.instanceId);
      let upstream: Response;
      try {
        upstream = await this.deps.client.chatCompletions(lease.poolToken, upstreamBody, { signal: abort.signal });
      } catch (error) {
        this.writeOpenAIError(res, 502, `upstream request failed: ${String(error)}`, "server_error", "");
        return;
      }

      if (upstream.status >= 200 && upstream.status < 300) {
        const startedLabel = tokenLabel(lease.poolToken);
        await this.pipeUpstream(res, upstream);
        this.deps.log(
          `[${startedLabel}] completed (model: ${requestedModel}) in ${Date.now() - started}ms with status ${upstream.status}`,
        );
        return;
      }

      const errorBody = await upstream.text().catch(() => "");
      if (isSessionInvalid(upstream.status, errorBody)) {
        this.deps.log(`[${tokenLabel(lease.poolToken)}] free session invalid, refreshing and retrying`);
        this.deps.tokens.invalidateSession(lease.poolToken, errorBody.trim() || "session invalid");
        continue;
      }
      if (isRunInvalid(upstream.status, errorBody)) {
        this.deps.log(`[${tokenLabel(lease.poolToken)}] run invalid, rotating and retrying`);
        this.deps.runs.invalidate(lease.poolToken, agentId);
        continue;
      }
      if (upstream.status === 401) {
        this.deps.tokens.cooldown(lease.poolToken, TOKEN_COOLDOWN_MS, "upstream auth rejected token");
        this.deps.tokens.invalidateSession(lease.poolToken, "upstream auth rejected token");
      }

      this.writeUpstreamError(res, upstream.status, upstream.headers.get("Retry-After"), errorBody);
      return;
    }

    this.writeOpenAIError(res, 502, "upstream run expired twice in a row", "server_error", "");
  }

  private writeUpstreamError(res: ServerResponse, statusCode: number, retryAfter: string | null, body: string): void {
    if (retryAfter) res.setHeader("Retry-After", retryAfter);
    const trimmed = body.trim();
    let parsed: { error?: unknown; message?: unknown } | null = null;
    try {
      parsed = trimmed ? (JSON.parse(trimmed) as { error?: unknown; message?: unknown }) : null;
    } catch {
      parsed = null;
    }
    if (parsed) {
      if (typeof parsed.error === "string") {
        this.writeOpenAIError(res, statusCode, parsed.error, "upstream_error", parsed.error);
        return;
      }
      if (parsed.error && typeof parsed.error === "object") {
        const e = parsed.error as { message?: unknown; type?: unknown; code?: unknown };
        const message = typeof e.message === "string" ? e.message : trimmed.slice(0, 500);
        const type = typeof e.type === "string" ? e.type : "upstream_error";
        const code = typeof e.code === "string" ? e.code : "";
        this.writeOpenAIError(res, statusCode, message, type, code);
        return;
      }
      if (typeof parsed.message === "string") {
        this.writeOpenAIError(res, statusCode, parsed.message, "upstream_error", "");
        return;
      }
    }
    this.writeOpenAIError(res, statusCode, trimmed.slice(0, 500) || `upstream error (status ${statusCode})`, "upstream_error", "");
  }

  private writeOpenAIError(
    res: ServerResponse,
    statusCode: number,
    message: string,
    type: string,
    code: string,
  ): void {
    const error: Record<string, string> = { message: message || "error", type: type || "server_error" };
    if (code) error.code = code;
    this.writeJSON(res, statusCode, { error });
  }

  private writeJSON(res: ServerResponse, statusCode: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(body);
  }

  /** Copy an upstream response (JSON or SSE stream) back to the client. */
  private async pipeUpstream(res: ServerResponse, upstream: Response): Promise<void> {
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      // fetch() transparently decompresses upstream bodies but may retain the
      // original content-encoding header. Do not advertise compression for the
      // already-decoded bytes we pipe to the client.
      if (lower === "content-length" || lower === "content-encoding" || lower === "transfer-encoding" || lower === "connection" || lower === "keep-alive") {
        return;
      }
      headers[key] = value;
    });
    res.writeHead(upstream.status, headers);

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          res.write(Buffer.from(value));
          if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
            (res as unknown as { flush: () => void }).flush();
          }
        }
      }
      res.end();
    } catch (error) {
      // Client likely disconnected; upstream is aborted via the signal.
      if (error instanceof Error && error.name !== "AbortError") {
        this.deps.log(`[server] stream error: ${String(error)}`);
      }
      try {
        res.end();
      } catch {
        // Already closed.
      }
    } finally {
      reader.releaseLock();
    }
  }
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
      m && typeof m === "object" &&
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export { UpstreamError };
