import { describe, expect, test } from "bun:test";

import { TokenManager } from "../../src/session.ts";
import { UpstreamError } from "../../src/upstream.ts";

function active(instanceId: string) {
  return { status: "active", instanceId, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

describe("TokenManager session failover", () => {
  test("tries another token after a transient session failure", async () => {
    const calls: string[] = [];
    const client = {
      createOrRefreshSession: async (token: string) => {
        calls.push(token);
        if (token === "bad") throw new UpstreamError("temporary upstream outage", 503);
        return active("good-instance");
      },
      getSession: async () => active("unused"),
    };

    const manager = new TokenManager(["bad", "good"], client as never, () => {});
    const result = await manager.acquireSession("deepseek/deepseek-v4-flash");
    expect(result.pool.token).toBe("good");
    expect(result.instanceId).toBe("good-instance");
    expect(calls).toEqual(["bad", "good"]);
  });

  test("does not fail over waiting-room responses", async () => {
    const calls: string[] = [];
    const client = {
      createOrRefreshSession: async (token: string) => {
        calls.push(token);
        return { status: "queued", instanceId: `${token}-instance`, position: 2, queueDepth: 4, estimatedWaitMs: 30_000 };
      },
      getSession: async () => ({ status: "queued", instanceId: "queued-instance", position: 2, queueDepth: 4 }),
    };

    const manager = new TokenManager(["first", "second"], client as never, () => {});
    await expect(manager.acquireSession("deepseek/deepseek-v4-flash")).rejects.toMatchObject({ name: "WaitingRoomError" });
    expect(calls).toEqual(["first"]);
  });

  test("surfaces model-unavailable session states instead of retrying forever", async () => {
    let calls = 0;
    const client = {
      createOrRefreshSession: async () => {
        calls += 1;
        return { status: "model_unavailable", message: "model is not currently available" };
      },
      getSession: async () => ({ status: "model_unavailable" }),
    };

    const manager = new TokenManager(["only-token"], client as never, () => {});
    await expect(manager.acquireSession("crof/greg-2-super")).rejects.toMatchObject({
      name: "UpstreamError",
      statusCode: 409,
      errorCode: "model_unavailable",
    });
    expect(calls).toBe(1);
  });

  test("model_locked names the locked model and does not retry", async () => {
    let calls = 0;
    const client = {
      createOrRefreshSession: async () => {
        calls += 1;
        return {
          status: "model_locked",
          currentModel: "openai/gpt-5.6-luna",
          requestedModel: "deepseek/deepseek-v4-flash",
        };
      },
      getSession: async () => ({ status: "model_locked" }),
    };

    const manager = new TokenManager(["only-token"], client as never, () => {});
    const error = await manager.acquireSession("deepseek/deepseek-v4-flash").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).statusCode).toBe(409);
    expect((error as UpstreamError).errorCode).toBe("model_locked");
    expect(String(error)).toContain("openai/gpt-5.6-luna");
    expect(calls).toBe(1);
  });
});
