import { describe, expect, test } from "bun:test";

import { isSiteGateEnabled, siteGateTokens, verifySiteToken } from "../../app/lib/gate";

function env(value: string | undefined): Record<string, string | undefined> {
  return { SITE_ACCESS_TOKEN: value };
}

describe("siteGateTokens", () => {
  test("parses comma/whitespace lists and dedupes", () => {
    expect(siteGateTokens(env(" a , b\nc;b "))).toEqual(["a", "b", "c"]);
  });

  test("empty or missing env yields no tokens", () => {
    expect(siteGateTokens(env(""))).toEqual([]);
    expect(siteGateTokens(env("   "))).toEqual([]);
    expect(siteGateTokens({})).toEqual([]);
  });
});

describe("isSiteGateEnabled", () => {
  test("true only when a non-empty token is configured", () => {
    expect(isSiteGateEnabled(env("tok-1"))).toBe(true);
    expect(isSiteGateEnabled(env("tok-1,tok-2"))).toBe(true);
    expect(isSiteGateEnabled(env(""))).toBe(false);
    expect(isSiteGateEnabled({})).toBe(false);
  });
});

describe("verifySiteToken", () => {
  test("accepts any configured token", () => {
    const e = env("tok-a,tok-b");
    expect(verifySiteToken("tok-a", e)).toBe(true);
    expect(verifySiteToken("tok-b", e)).toBe(true);
  });

  test("rejects unknown, empty, and non-string tokens", () => {
    const e = env("tok-a");
    expect(verifySiteToken("tok-c", e)).toBe(false);
    expect(verifySiteToken("", e)).toBe(false);
    expect(verifySiteToken(undefined, e)).toBe(false);
    expect(verifySiteToken(null, e)).toBe(false);
    expect(verifySiteToken(42, e)).toBe(false);
    expect(verifySiteToken({}, e)).toBe(false);
  });

  test("is case-sensitive", () => {
    const e = env("Tok-1");
    expect(verifySiteToken("Tok-1", e)).toBe(true);
    expect(verifySiteToken("tok-1", e)).toBe(false);
  });

  test("never accepts anything when the gate is disabled", () => {
    expect(verifySiteToken("anything", env(""))).toBe(false);
    expect(verifySiteToken("anything", {})).toBe(false);
  });
});
