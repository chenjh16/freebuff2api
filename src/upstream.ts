/**
 * HTTP client for the Freebuff backend API.
 *
 * Wire protocol (verified against the official CodebuffAI/freebuff client):
 *   POST   /api/v1/freebuff/session     create/refresh a free session (empty body)
 *   GET    /api/v1/freebuff/session     poll a queued session (instance + compact headers)
 *   DELETE /api/v1/freebuff/session     end a session
 *   POST   /api/v1/agent-runs           START / FINISH an agent run
 *   POST   /api/v1/chat/completions     OpenAI-compatible chat (streaming supported)
 *
 * All requests authenticate with `Authorization: Bearer <token>`.
 */

export interface FreebuffSessionResponse {
  status: string;
  instanceId?: string;
  position?: number;
  queueDepth?: number;
  queuedAt?: string;
  expiresAt?: string;
  remainingMs?: number;
  estimatedWaitMs?: number;
  gracePeriodRemainingMs?: number;
  message?: string;
  /** Present on 409 model_locked responses: the model the account's active session is locked to. */
  currentModel?: string;
  /** Present on 409 model_locked / model_unavailable responses: the model that was requested. */
  requestedModel?: string;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterMs?: number,
    readonly errorCode?: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const ms = seconds * 1_000;
    return Number.isFinite(ms) ? Math.ceil(ms) : undefined;
  }
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

/**
 * The official CLI's non-SDK requests (session, agent-runs, me, healthz, …)
 * are sent by Bun's fetch with its default user-agent. The free-tier gate
 * distinguishes "CLI-created" sessions from direct API calls, so session and
 * run endpoints must carry this UA; only the SDK chat call uses the ai-sdk UA.
 */
export const CLI_USER_AGENT = "Bun/1.3.14";

export interface UpstreamClientOptions {
  baseURL: string;
  requestTimeoutMs: number;
  userAgent: string;
  /** Freebuff user id; sent as x-freebuff-acting-user-id on every request. */
  actingUserId?: string | null;
}

export class UpstreamClient {
  readonly baseURL: string;
  private readonly requestTimeoutMs: number;
  private readonly userAgent: string;
  private readonly actingUserId: string | null;

  constructor(options: UpstreamClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.userAgent = options.userAgent;
    this.actingUserId = options.actingUserId ?? null;
  }

  private url(path: string): string {
    return `${this.baseURL}${path}`;
  }

  private async request(
    method: string,
    path: string,
    token: string,
    opts: {
      body?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.requestTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "User-Agent": this.userAgent,
      ...(this.actingUserId ? { "x-freebuff-acting-user-id": this.actingUserId } : {}),
      ...opts.headers,
    };
    if (opts.body !== undefined && headers["Content-Type"] === undefined) {
      headers["Content-Type"] = "application/json";
    }

    try {
      // NOTE: Bun's fetch honors HTTP_PROXY/HTTPS_PROXY/ALL_PROXY environment
      // variables natively, which provides the HTTP_PROXY config option on the
      // default runtime with zero dependencies.
      const response = await fetch(this.url(path), {
        method,
        headers,
        body: opts.body,
        signal,
      });
      if (process.env.DEBUG_UPSTREAM === "1") {
        const sanitized: Record<string, string> = { ...headers };
        if (sanitized.Authorization) sanitized.Authorization = "Bearer <redacted>";
        if (sanitized.authorization) sanitized.authorization = "Bearer <redacted>";
        const bodyHead = opts.body ? opts.body.slice(0, 500) : "";
        console.log(
          `[upstream-debug] ${method} ${this.url(path)}\n  headers: ${JSON.stringify(sanitized)}\n  body: ${bodyHead}\n  -> status ${response.status} ${response.statusText}`,
        );
        const text = await response.clone().text().catch(() => "");
        console.log(`[upstream-debug]   body: ${text.slice(0, 500)}`);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new UpstreamError(`upstream request timed out after ${this.requestTimeoutMs}ms`, 0);
      }
      throw error;
    }
  }

  /**
   * Create or refresh a free session. 404 (free mode unavailable) maps to
   * `{ status: "disabled" }`; other non-2xx raise UpstreamError with the parsed
   * body so callers can react to waiting-room / ban states.
   */
  async createOrRefreshSession(token: string, opts: { model?: string; signal?: AbortSignal } = {}): Promise<FreebuffSessionResponse> {
    // Match the official CLI: POST has no request body and no explicit Accept
    // header. The selected model is pinned on this mutation only.
    const headers: Record<string, string> = { "User-Agent": CLI_USER_AGENT };
    if (opts.model) headers["x-freebuff-model"] = opts.model;
    const resp = await this.request("POST", "/api/v1/freebuff/session", token, {
      headers,
      signal: opts.signal,
    });

    if (resp.status === 404) return { status: "disabled" };
    return this.parseSessionResponse(resp, "POST");
  }

  /** Poll a queued session identified by its instance id. */
  async getSession(token: string, instanceId: string, opts: { model?: string; signal?: AbortSignal } = {}): Promise<FreebuffSessionResponse> {
    const resp = await this.request("GET", "/api/v1/freebuff/session", token, {
      // The official CLI uses the compact response form while polling. The
      // model is pinned on the original POST and is intentionally not repeated
      // on this read-only request.
      headers: {
        "x-freebuff-instance-id": instanceId,
        "x-freebuff-compact-session": "1",
        "User-Agent": CLI_USER_AGENT,
      },
      signal: opts.signal,
    });
    if (resp.status === 404) return { status: "disabled" };
    return this.parseSessionResponse(resp, "GET");
  }

  /** End a free session (best-effort). */
  async endSession(token: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const resp = await this.request("DELETE", "/api/v1/freebuff/session", token, {
      headers: { Accept: "application/json", "User-Agent": CLI_USER_AGENT },
      signal: opts.signal,
    });
    if (resp.status === 404 || (resp.status >= 200 && resp.status < 300)) return;
    const body = await resp.text().catch(() => "");
    throw new UpstreamError(`free session delete failed with status ${resp.status}`, resp.status, undefined, undefined, body);
  }

  /** Start an agent run; returns the runId. */
  async startRun(token: string, agentId: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const resp = await this.request("POST", "/api/v1/agent-runs", token, {
      // ancestorRunIds: [] matches the official CLI's START body exactly.
      body: JSON.stringify({ action: "START", agentId, ancestorRunIds: [] }),
      headers: { Accept: "application/json", "User-Agent": CLI_USER_AGENT },
      signal: opts.signal,
    });
    const body = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new UpstreamError(
        `start run failed with status ${resp.status}: ${body.slice(0, 500)}`,
        resp.status,
        undefined,
        undefined,
        body,
      );
    }
    let parsed: { runId?: string };
    try {
      parsed = JSON.parse(body) as { runId?: string };
    } catch {
      throw new UpstreamError(`start run returned invalid JSON: ${body.slice(0, 200)}`, resp.status);
    }
    if (!parsed.runId) {
      throw new UpstreamError(`start run response missing runId: ${body.slice(0, 200)}`, resp.status);
    }
    return parsed.runId;
  }

  /** Finish an agent run (best-effort; used on shutdown). */
  async finishRun(token: string, runId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const resp = await this.request("POST", "/api/v1/agent-runs", token, {
      body: JSON.stringify({
        action: "FINISH",
        runId,
        status: "completed",
        totalSteps: 0,
        directCredits: 0,
        totalCredits: 0,
      }),
      headers: { Accept: "application/json", "User-Agent": CLI_USER_AGENT },
      signal: opts.signal,
    });
    if (resp.status < 200 || resp.status >= 300) {
      // Best-effort: never throw on shutdown cleanup.
      return;
    }
    await resp.body?.cancel().catch(() => undefined);
  }

  /**
   * Proxy a chat completions request upstream. Returns the upstream Response
   * (streaming or not) for the caller to pipe back. Non-2xx responses are
   * returned as-is so the caller can inspect status/body for retryable states.
   */
  async chatCompletions(
    token: string,
    body: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Response> {
    // The official SDK sends Accept: */* on chat requests (captured via MITM).
    return this.request("POST", "/api/v1/chat/completions", token, {
      body,
      headers: { Accept: "*/*" },
      signal: opts.signal,
    });
  }

  /**
   * Fetch the current user for a token (`GET /api/v1/me`). Used by the hosted
   * web login flow to validate an account token before minting an API key.
   */
  async me(
    token: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ id?: string; name?: string; email?: string }> {
    // The upstream /api/v1/me only accepts a fixed set of fields (verified
    // live: id, email, discord_id, stripe_customer_id, banned, ...) — name is
    // not among them.
    const resp = await this.request("GET", "/api/v1/me?fields=id,email", token, {
      headers: { Accept: "application/json", "User-Agent": CLI_USER_AGENT },
      signal: opts.signal,
    });
    const body = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new UpstreamError(
        `me request failed with status ${resp.status}: ${body.slice(0, 300)}`,
        resp.status,
        undefined,
        undefined,
        body,
      );
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      // Fall through.
    }
    if (!parsed) {
      throw new UpstreamError(`me response was not JSON: ${body.slice(0, 300)}`, resp.status);
    }
    return {
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
    };
  }

  private async parseSessionResponse(resp: Response, method: string): Promise<FreebuffSessionResponse> {
    const body = await resp.text();
    const retryAfterMs = parseRetryAfterMs(resp.headers.get("Retry-After"));

    if (resp.status === 403) {
      const parsed = this.tryParse(body);
      if (parsed && (parsed.status === "country_blocked" || parsed.status === "banned")) {
        return parsed as unknown as FreebuffSessionResponse;
      }
    }
    if (resp.status === 409 && method === "POST") {
      const parsed = this.tryParse(body);
      if (parsed && (parsed.status === "model_locked" || parsed.status === "model_unavailable")) {
        return parsed as unknown as FreebuffSessionResponse;
      }
    }
    if (resp.status === 429 && method === "POST") {
      const parsed = this.tryParse(body);
      const code = typeof parsed?.message === "string" ? parsed.message : undefined;
      throw new UpstreamError(
        `free session rate limited (status 429)${code ? `: ${code}` : ""}`,
        resp.status,
        retryAfterMs,
        code,
        body,
      );
    }
    if (resp.status < 200 || resp.status >= 300) {
      const parsed = this.tryParse(body);
      // errorCode carries the parsed `message` (falling back to `status`) so
      // callers can preserve the upstream's reason instead of masking it.
      const code =
        parsed && typeof parsed.message === "string"
          ? parsed.message
          : parsed && typeof parsed.status === "string"
            ? parsed.status
            : undefined;
      throw new UpstreamError(
        `free session request failed with status ${resp.status}: ${body.slice(0, 500)}`,
        resp.status,
        retryAfterMs,
        code,
        body,
      );
    }

    const parsed = this.tryParse(body);
    if (!parsed || !parsed.status) {
      throw new UpstreamError(`free session response missing status: ${body.slice(0, 200)}`, resp.status);
    }
    return parsed as unknown as FreebuffSessionResponse;
  }

  private tryParse(body: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
