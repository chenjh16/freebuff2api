import { describe, expect, test } from "bun:test";

import { ModelRegistry, parseFreeAgents } from "../../src/models.ts";

const AGENT_SRC = `
export const freeAgents: Record<string, FreeAgent> = {
  'agent-a': new Set([MODEL_A, 'openai/gpt-5.6-luna']),
  'agent-b': new Set([mimoModels.mimoV25, 'deepseek/deepseek-v4-flash']),
  'agent-c': new Set([ALIAS_D]),
  'agent-empty': new Set([]),
};
`;

const CONSTANTS_SRC = `
export const MODEL_A = 'deepseek/deepseek-v4-pro';
export const mimoModels = { mimoV25: 'mimo/mimo-v2.5', mimoV3: 'mimo/mimo-v3' };
export const ALIAS_D = MODEL_A;
`;

describe("parseFreeAgents", () => {
  test("resolves string constants, namespace members and chained aliases", () => {
    const result = parseFreeAgents(AGENT_SRC, CONSTANTS_SRC);
    expect(result.get("agent-a")).toEqual(["deepseek/deepseek-v4-pro", "openai/gpt-5.6-luna"]);
    expect(result.get("agent-b")).toEqual(["mimo/mimo-v2.5", "deepseek/deepseek-v4-flash"]);
    expect(result.get("agent-c")).toEqual(["deepseek/deepseek-v4-pro"]);
    expect(result.has("agent-empty")).toBe(false);
  });

  test("dedupes repeated model ids within a set", () => {
    const src = `export const X = { 'a': new Set(['m/m1', 'm/m1', MODEL_X]) };`;
    const constants = `export const MODEL_X = 'm/m1';`;
    const result = parseFreeAgents(src, constants);
    expect(result.get("a")).toEqual(["m/m1"]);
  });

  test("drops unresolvable identifiers", () => {
    const src = `export const X = { 'a': new Set([UNKNOWN_CONST, 'known/model']) };`;
    const result = parseFreeAgents(src, "");
    expect(result.get("a")).toEqual(["known/model"]);
  });

  test("ignores blocks with no resolvable models", () => {
    const src = `export const X = { 'a': new Set([UNKNOWN]) };`;
    expect(parseFreeAgents(src, "").size).toBe(0);
  });
});

describe("ModelRegistry", () => {
  test("loads the curated fallback when the upstream source is unreachable", async () => {
    const registry = new ModelRegistry(
      async () => {
        throw new Error("network offline");
      },
      () => {},
    );
    await registry.start();
    expect(registry.status().source).toBe("fallback");
    // The proxy surface only accepts `freebuff/<model>` ids.
    expect(registry.hasModel("freebuff/deepseek/deepseek-v4-flash")).toBe(true);
    expect(registry.hasModel("deepseek/deepseek-v4-flash")).toBe(false);
    // Most-specific free agent wins over the aggregate base2-free.
    expect(registry.agentForModel("freebuff/deepseek/deepseek-v4-flash")).toBe("base2-free-deepseek-flash");
    expect(registry.agentForModel("freebuff/deepseek/deepseek-v4-pro")).toBe("base2-free-deepseek");
    expect(registry.agentForModel("freebuff/openai/gpt-5.6-luna")).toBe("base2-free-luna");
    expect(registry.agentForModel("freebuff/minimax/minimax-m3")).toBe("base2-free-minimax-m3");
    expect(registry.agentForModel("freebuff/z-ai/glm-5.2")).toBe("base2-free-glm");
    expect(registry.agentForModel("freebuff/google/gemini-3.5-flash-lite")).toBe("file-picker-max");
    expect(registry.agentForModel("deepseek/deepseek-v4-flash")).toBeUndefined();
    expect(registry.agentIds().length).toBeGreaterThan(10);
    // The catalog lists the Freebuff namespace only.
    expect(registry.models().length).toBeGreaterThan(5);
    expect(registry.models()).toContain("freebuff/deepseek/deepseek-v4-flash");
    expect(registry.models()).not.toContain("deepseek/deepseek-v4-flash");
    registry.stop();
  });

  test("uses the remote mapping when the fetch succeeds", async () => {
    const fetchFn = async (url: string) =>
      new Response(url.includes("free-agents.ts") ? AGENT_SRC : CONSTANTS_SRC, { status: 200 });
    const registry = new ModelRegistry(fetchFn, () => {});
    await registry.start();
    expect(registry.status().source).toBe("remote");
    expect(registry.agentForModel("freebuff/deepseek/deepseek-v4-flash")).toBe("agent-b");
    expect(registry.agentForModel("freebuff/openai/gpt-5.6-luna")).toBe("agent-a");
    registry.stop();
  });

  test("falls back when the remote source parses to zero agents", async () => {
    const fetchFn = async () => new Response("export const nothing = 1;", { status: 200 });
    const registry = new ModelRegistry(fetchFn, () => {});
    await registry.start();
    expect(registry.status().source).toBe("fallback");
    expect(registry.hasModel("freebuff/deepseek/deepseek-v4-flash")).toBe(true);
    registry.stop();
  });

  test("models() returns a sorted copy and is immune to mutation", () => {
    const registry = new ModelRegistry(async () => ({ ok: false } as Response), () => {});
    const models = registry.models();
    expect(models).toEqual([]);
    models.push("mutated");
    expect(registry.models()).toEqual([]);
  });

  test("freebuff/-prefixed ids canonicalize; bare ids are rejected", async () => {
    const registry = new ModelRegistry(
      async () => {
        throw new Error("network offline");
      },
      () => {},
    );
    await registry.start();
    expect(registry.hasModel(`freebuff/deepseek/deepseek-v4-flash`)).toBe(true);
    expect(registry.agentForModel(`freebuff/deepseek/deepseek-v4-flash`)).toBe("base2-free-deepseek-flash");
    expect(registry.canonicalModel(`freebuff/deepseek/deepseek-v4-flash`)).toBe("deepseek/deepseek-v4-flash");
    // Bare registry ids no longer route: the prefix is mandatory at the proxy
    // surface, even though the id already contains a model-vendor namespace.
    expect(registry.hasModel("deepseek/deepseek-v4-flash")).toBe(false);
    expect(registry.agentForModel("deepseek/deepseek-v4-flash")).toBeUndefined();
    // A registry id that merely starts with another namespace is untouched.
    expect(registry.hasModel(`freebuff/z-ai/glm-5.2`)).toBe(true);
    expect(registry.agentForModel(`freebuff/z-ai/glm-5.2`)).toBe("base2-free-glm");
    expect(registry.hasModel("freebuff/openai/gpt-5.6-luna")).toBe(true);
    registry.stop();
  });
});
