import { describe, expect, test } from "bun:test";

import { RunManager } from "../../src/runs.ts";

function fakeClient() {
  const starts: { token: string; agentId: string }[] = [];
  const finishes: { token: string; runId: string }[] = [];
  let next = 0;
  const client = {
    starts,
    finishes,
    startRun: async (token: string, agentId: string) => {
      starts.push({ token, agentId });
      return `run-${++next}`;
    },
    finishRun: async (token: string, runId: string) => {
      finishes.push({ token, runId });
    },
  };
  return client;
}

describe("RunManager", () => {
  test("coalesces concurrent starts for the same (token, agent)", async () => {
    const client = fakeClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = client.startRun;
    client.startRun = async (token: string, agentId: string) => {
      await gate;
      return original(token, agentId);
    };
    const manager = new RunManager(client as never, 60_000, () => {});
    const first = manager.acquire("t1", "agent-a");
    const second = manager.acquire("t1", "agent-a");
    release();
    expect(await first).toBe(await second);
    expect(client.starts).toHaveLength(1);
  });

  test("reuses a cached run while it is fresh", async () => {
    const client = fakeClient();
    const manager = new RunManager(client as never, 60_000, () => {});
    const first = await manager.acquire("t1", "agent-a");
    const second = await manager.acquire("t1", "agent-a");
    expect(first).toBe(second);
    expect(first).toBe("run-1");
    expect(client.starts).toHaveLength(1);
  });

  test("starts a new run after the rotation interval", async () => {
    const client = fakeClient();
    // A negative interval makes every cached run look stale.
    const manager = new RunManager(client as never, -1, () => {});
    const first = await manager.acquire("t1", "agent-a");
    const second = await manager.acquire("t1", "agent-a");
    expect(first).not.toBe(second);
    expect(client.starts).toHaveLength(2);
  });

  test("caches runs per (token, agent) pair", async () => {
    const client = fakeClient();
    const manager = new RunManager(client as never, 60_000, () => {});
    await manager.acquire("t1", "agent-a");
    await manager.acquire("t2", "agent-a");
    await manager.acquire("t1", "agent-b");
    expect(client.starts).toHaveLength(3);
    expect(client.starts.map((s) => s.token)).toEqual(["t1", "t2", "t1"]);
    expect(client.starts.map((s) => s.agentId)).toEqual(["agent-a", "agent-a", "agent-b"]);
  });

  test("invalidate forces a fresh run on the next acquire", async () => {
    const client = fakeClient();
    const manager = new RunManager(client as never, 60_000, () => {});
    const first = await manager.acquire("t1", "agent-a");
    manager.invalidate("t1", "agent-a");
    const second = await manager.acquire("t1", "agent-a");
    expect(first).not.toBe(second);
    expect(client.starts).toHaveLength(2);
  });

  test("invalidate is a no-op for unknown runs", async () => {
    const client = fakeClient();
    const manager = new RunManager(client as never, 60_000, () => {});
    expect(() => manager.invalidate("t1", "never-started")).not.toThrow();
  });

  test("finishAll finishes every known run best-effort and clears the cache", async () => {
    const client = fakeClient();
    const manager = new RunManager(client as never, 60_000, () => {});
    await manager.acquire("t1", "agent-a");
    await manager.acquire("t2", "agent-a");

    // A throwing finishRun must not break the sweep (Promise.allSettled).
    const manager2 = new RunManager(
      {
        startRun: client.startRun,
        finishRun: async () => {
          throw new Error("upstream gone");
        },
      } as never,
      60_000,
      () => {},
    );
    await manager2.acquire("t1", "agent-a");
    await manager2.acquire("t2", "agent-a");
    await manager2.finishAll();

    // After finishAll the cache is cleared: the next acquire starts fresh.
    const after = await manager2.acquire("t1", "agent-a");
    // manager2 started run-3 and run-4 before clearing its cache.
    expect(after).toBe("run-5");
  });
});
