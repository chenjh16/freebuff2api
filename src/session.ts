/**
 * Free session management.
 *
 * Freebuff's free tier is session-gated: clients create a session via
 * `POST /api/v1/freebuff/session` and receive an `instanceId` when active.
 * Under load the backend returns `queued` (the "waiting room"); the proxy then
 * returns 503 + Retry-After to the caller and keeps polling in the background.
 */

import { UpstreamClient, UpstreamError, type FreebuffSessionResponse } from "./upstream.ts";

export const FREE_SESSION_POLL_INTERVAL_MS = 5_000;

/** Cooldown applied to a token after the upstream rejects it with 401. */
export const TOKEN_COOLDOWN_MS = 30 * 60_000;

const QUEUED_STATUSES = new Set(["queued"]);
const ENDED_STATUSES = new Set(["none", "ended", "superseded"]);

export class WaitingRoomError extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly position?: number,
    readonly queueDepth?: number,
  ) {
    super(
      `waiting room: queued at position ${position ?? "?"} of ${queueDepth ?? "?"} — retry in ${Math.ceil(retryAfterMs / 1000)}s`,
    );
    this.name = "WaitingRoomError";
  }
}

export interface SessionSnapshot {
  status: string | null;
  instanceId: string | null;
  position: number | null;
  queueDepth: number | null;
  expiresAt: string | null;
  lastError: string | null;
}

interface CachedSession {
  status: string;
  model: string | null;
  instanceId: string | null;
  expiresAt: number; // epoch ms, 0 if unknown
  position: number;
  queueDepth: number;
  pollAt: number; // epoch ms
  retryAfterMs: number;
}

/**
 * Manages the free session lifecycle for a single auth token.
 * Concurrent callers share one refresh at a time.
 */
export class SessionPool {
  private session: CachedSession | null = null;
  private refreshPromise: Promise<CachedSession | null> | null = null;
  private lastError: string | null = null;

  constructor(
    readonly token: string,
    private readonly client: UpstreamClient,
    private readonly log: (message: string) => void = console.log,
  ) {}

  /** Returns the active instance id, or null when free mode is disabled. */
  async ensureSession(model?: string, signal?: AbortSignal): Promise<string | null> {
    for (;;) {
      const now = Date.now();
      const ready = this.readySessionLocked(now, model);
      if (ready.ready) {
        return ready.instanceId;
      }
      if (this.session && this.session.status === "queued" && now < this.session.pollAt) {
        throw new WaitingRoomError(
          this.session.pollAt - now,
          this.session.position,
          this.session.queueDepth,
        );
      }
      if (this.refreshPromise) {
        await this.refreshPromise;
        continue;
      }

      const promise = this.refresh(model, signal);
      this.refreshPromise = promise;
      try {
        const next = await promise;
        this.session = next;
      } catch (error) {
        this.session = null;
        this.lastError = error instanceof Error ? error.message : String(error);
        // Propagate instead of retrying in a tight loop: a failing upstream
        // (401 invalid token, 429 rate limit, network error) should fail this
        // request promptly so the server can return a clean 503 (with
        // Retry-After when known) rather than spinning on the session endpoint.
        throw error;
      } finally {
        this.refreshPromise = null;
      }
    }
  }

  invalidate(reason: string): void {
    this.session = null;
    if (reason) this.lastError = reason;
  }

  async end(signal?: AbortSignal): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session || session.status === "disabled" || !session.instanceId) return;
    try {
      await this.client.endSession(this.token, { signal });
    } catch {
      // Best-effort.
    }
  }

  snapshot(): SessionSnapshot {
    const s = this.session;
    return {
      status: s?.status ?? null,
      instanceId: s?.instanceId ?? null,
      position: s ? s.position : null,
      queueDepth: s ? s.queueDepth : null,
      expiresAt: s && s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
      lastError: this.lastError,
    };
  }

  private readySessionLocked(now: number, model?: string): { ready: boolean; instanceId: string | null } {
    const s = this.session;
    if (!s) return { ready: false, instanceId: null };
    if (s.status === "disabled") return { ready: true, instanceId: null };
    if (s.status === "active" && (!model || s.model === model)) {
      if (s.instanceId && (s.expiresAt === 0 || now < s.expiresAt - 5_000)) {
        return { ready: true, instanceId: s.instanceId };
      }
    }
    return { ready: false, instanceId: null };
  }

  private async refresh(model?: string, signal?: AbortSignal): Promise<CachedSession | null> {
    const current = this.session;
    let state: FreebuffSessionResponse;
    try {
      if (current && current.status === "queued" && current.instanceId) {
        state = await this.client.getSession(this.token, current.instanceId, { model, signal });
      } else {
        state = await this.client.createOrRefreshSession(this.token, { model, signal });
      }
    } catch (error) {
      throw error;
    }

    for (;;) {
      const status = (state.status ?? "").trim();
      switch (true) {
        case status === "disabled":
          return { status: "disabled", model: model ?? null, instanceId: null, expiresAt: 0, position: 0, queueDepth: 0, pollAt: 0, retryAfterMs: 0 };
        case status === "active": {
          const instanceId = (state.instanceId ?? "").trim();
          if (!instanceId) throw new Error("free session active response missing instanceId");
          const expiresAt = state.expiresAt ? Date.parse(state.expiresAt) : 0;
          return { status: "active", model: model ?? null, instanceId, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0, position: 0, queueDepth: 0, pollAt: 0, retryAfterMs: 0 };
        }
        case status === "queued": {
          const instanceId = (state.instanceId ?? "").trim();
          if (!instanceId) throw new Error("free session queued response missing instanceId");
          const position = Math.max(state.position ?? 1, 1);
          const queueDepth = Math.max(state.queueDepth ?? position, position);
          const retryAfterMs = queuedPollDelayMs(state.estimatedWaitMs);
          this.logQueuePosition(tokenLabel(this.token), position, queueDepth, state.estimatedWaitMs);
          return { status: "queued", model: model ?? null, instanceId, expiresAt: 0, position, queueDepth, pollAt: Date.now() + retryAfterMs, retryAfterMs };
        }
        case ENDED_STATUSES.has(status):
          state = await this.client.createOrRefreshSession(this.token, { model, signal });
          continue;
        case QUEUED_STATUSES.has(status): // unreachable; kept for clarity
          continue;
        default:
          // Terminal/odd statuses (country_blocked, banned, model_locked,
          // model_unavailable, ...): surface them as a finite error. Returning
          // a non-active cached session here would make ensureSession() retry
          // forever because the state is neither ready nor queued.
          //
          // model_locked tells us which model the account's one-hour session
          // is pinned to (the official CLI surfaces this and asks the user to
          // end the session before switching); include it for diagnostics.
          const lock =
            state.currentModel
              ? ` (session is locked to ${state.currentModel})`
              : state.requestedModel
                ? ` (requested: ${state.requestedModel})`
                : "";
          throw new UpstreamError(
            `free session unavailable for ${model ?? "requested model"}: ${status}${lock}${state.message ? ` (${state.message})` : ""}`,
            409,
            undefined,
            status,
            state.message,
          );
      }
    }
  }

  private logQueuePosition(label: string, position: number, queueDepth: number, estimatedWaitMs?: number): void {
    const parts = [`position ${position}/${queueDepth}`];
    if (estimatedWaitMs && estimatedWaitMs > 0) {
      parts.push(`~${Math.ceil(estimatedWaitMs / 1000)}s remaining`);
    }
    this.log(`[session:${label}] waiting room: ${parts.join(", ")}`);
  }
}

function queuedPollDelayMs(estimatedWaitMs?: number): number {
  if (!estimatedWaitMs || estimatedWaitMs <= 0) return FREE_SESSION_POLL_INTERVAL_MS;
  return Math.min(Math.max(estimatedWaitMs, 1_000), FREE_SESSION_POLL_INTERVAL_MS);
}

function tokenLabel(token: string): string {
  return token.length <= 10 ? token : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export { tokenLabel };

function isRetryableSessionFailure(error: unknown): boolean {
  if (error instanceof UpstreamError) return error.statusCode === 0 || error.statusCode >= 500;
  return error instanceof TypeError || (error instanceof Error && /timeout|network|fetch|socket/i.test(error.message));
}

/**
 * Manages one SessionPool per auth token with cooldown + round-robin rotation.
 */
export class TokenManager {
  private pools: SessionPool[] = [];
  private cooldownUntil = new Map<string, number>();
  private cooldownReason = new Map<string, string>();
  private nextIndex = 0;

  constructor(
    tokens: string[],
    private readonly client: UpstreamClient,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.pools = tokens.map((token) => new SessionPool(token, client, log));
  }

  get poolCount(): number {
    return this.pools.length;
  }

  /**
   * Pick the next non-cooldowned pool (round-robin). Throws if all tokens are
   * on cooldown.
   */
  private pickPool(): SessionPool {
    const now = Date.now();
    for (let i = 0; i < this.pools.length; i++) {
      const pool = this.pools[(this.nextIndex + i) % this.pools.length];
      const until = this.cooldownUntil.get(pool.token) ?? 0;
      if (until <= now) {
        this.nextIndex = (this.nextIndex + i + 1) % this.pools.length;
        return pool;
      }
    }
    const token = this.pools[0]?.token;
    const reason = token ? this.cooldownReason.get(token) : undefined;
    const until = token ? this.cooldownUntil.get(token) : 0;
    throw new Error(
      `all upstream tokens are on cooldown${reason ? ` (${reason})` : ""}` +
        (until ? ` until ${new Date(until).toISOString()}` : ""),
    );
  }

  /**
   * Acquire an upstream session for the next available token. Transient
   * session failures are tried against each other non-cooldowned token before
   * the error is returned to the HTTP layer; waiting-room responses are
   * returned immediately because they describe the account/session state.
   */
  async acquireSession(model?: string, signal?: AbortSignal): Promise<{ pool: SessionPool; instanceId: string | null }> {
    let lastError: unknown;
    const attempts = Math.max(1, this.pools.length);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const pool = this.pickPool();
      try {
        const instanceId = await pool.ensureSession(model, signal);
        return { pool, instanceId };
      } catch (error) {
        lastError = error;
        // A 401 here means the token itself was rejected by the upstream;
        // cooldown it so subsequent requests rotate to a healthy token.
        if (error instanceof UpstreamError && error.statusCode === 401) {
          this.cooldown(pool.token, TOKEN_COOLDOWN_MS, "upstream auth rejected token");
        }
        if (error instanceof WaitingRoomError || !isRetryableSessionFailure(error)) {
          throw error;
        }
        this.log(`[session:${tokenLabel(pool.token)}] transient session failure; trying another token`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "no upstream token available"));
  }

  /** Cooldown a token after an auth failure. */
  cooldown(token: string, ms: number, reason: string): void {
    this.cooldownUntil.set(token, Date.now() + ms);
    this.cooldownReason.set(token, reason);
    this.log(`[session:${tokenLabel(token)}] cooldown for ${Math.round(ms / 60_000)}m: ${reason}`);
  }

  invalidateSession(token: string, reason: string): void {
    const pool = this.pools.find((p) => p.token === token);
    pool?.invalidate(reason);
  }

  async endAll(signal?: AbortSignal): Promise<void> {
    await Promise.allSettled(this.pools.map((pool) => pool.end(signal)));
  }

  snapshots(): Record<string, SessionSnapshot> {
    const out: Record<string, SessionSnapshot> = {};
    for (const pool of this.pools) {
      const snapshot = pool.snapshot();
      snapshot.lastError = snapshot.lastError ?? this.cooldownReason.get(pool.token) ?? null;
      out[tokenLabel(pool.token)] = snapshot;
    }
    return out;
  }
}
