/**
 * Agent run management.
 *
 * Freebuff tracks credit usage per "run" (`/api/v1/agent-runs`). A run is
 * started once per (token, agent) and reused across requests until it is
 * invalidated by the backend (runId not found / not running) or rotated after
 * the configured rotation interval. Runs are finished best-effort on shutdown.
 */

import { UpstreamClient } from "./upstream.ts";

interface CachedRun {
  runId: string;
  startedAt: number;
}

export class RunManager {
  private runs = new Map<string, CachedRun>();
  private pending = new Map<string, Promise<string>>();

  constructor(
    private readonly client: UpstreamClient,
    private readonly rotationIntervalMs: number,
    private readonly log: (message: string) => void = console.log,
  ) {}

  private key(token: string, agentId: string): string {
    return `${token}\u0000${agentId}`;
  }

  /** Get the cached runId if fresh; otherwise start a new run. */
  async acquire(token: string, agentId: string, signal?: AbortSignal): Promise<string> {
    const key = this.key(token, agentId);
    const cached = this.runs.get(key);
    if (cached && Date.now() - cached.startedAt < this.rotationIntervalMs) {
      return cached.runId;
    }
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const promise = this.startAndCache(key, token, agentId, signal);
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }
  }

  private async startAndCache(key: string, token: string, agentId: string, signal?: AbortSignal): Promise<string> {
    const current = this.runs.get(key);
    if (current && Date.now() - current.startedAt < this.rotationIntervalMs) return current.runId;
    const runId = await this.client.startRun(token, agentId, { signal });
    this.runs.set(key, { runId, startedAt: Date.now() });
    this.log(`[runs] started run ${runId} (agent: ${agentId})`);
    return runId;
  }

  /** Invalidate a run so the next request starts a fresh one. */
  invalidate(token: string, agentId: string): void {
    const key = this.key(token, agentId);
    const cached = this.runs.get(key);
    if (cached) {
      this.log(`[runs] invalidated run ${cached.runId} (agent: ${agentId})`);
      this.runs.delete(key);
    }
  }

  /** Best-effort FINISH of every known run (used on shutdown). */
  async finishAll(signal?: AbortSignal): Promise<void> {
    const entries = [...this.runs.entries()];
    this.runs.clear();
    await Promise.allSettled(
      entries.map(async ([key, run]) => {
        const [token, agentId] = key.split("\u0000");
        try {
          await this.client.finishRun(token, run.runId, { signal });
          this.log(`[runs] finished run ${run.runId} (agent: ${agentId})`);
        } catch {
          // Best-effort.
        }
      }),
    );
  }
}
