import { beforeAll, describe, expect, test } from "bun:test";

import {
  API_KEY_PREFIX,
  generateApiKey,
  resetAccountStateForTests,
  resolveApiKeyToken,
  revokeApiKey,
} from "../../app/lib/account.ts";

beforeAll(() => {
  process.env.PROXY_SECRET = "unit-test-secret-0123456789abcdef";
  resetAccountStateForTests();
});

describe("account API keys (sk-fb-*)", () => {
  test("mints and resolves an encrypted key", () => {
    const key = generateApiKey("token-abc-123");
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(resolveApiKeyToken(key)).toBe("token-abc-123");
  });

  test("returns the same key for the same token", () => {
    expect(generateApiKey("same-token")).toBe(generateApiKey("same-token"));
  });

  test("different tokens get different keys", () => {
    expect(generateApiKey("t1")).not.toBe(generateApiKey("t2"));
  });

  test("non-prefixed keys never resolve", () => {
    expect(resolveApiKeyToken("sk-env-key")).toBeUndefined();
    expect(resolveApiKeyToken("")).toBeUndefined();
    expect(resolveApiKeyToken("sk-fb-")).toBeUndefined();
  });

  test("tampered keys do not resolve (GCM auth tag)", () => {
    const key = generateApiKey("token");
    const tampered = key.slice(0, -2) + (key.endsWith("aa") ? "bb" : "aa");
    expect(resolveApiKeyToken(tampered)).toBeUndefined();
  });

  test("revoked keys stop resolving", () => {
    const key = generateApiKey("revoke-me");
    revokeApiKey(key);
    expect(resolveApiKeyToken(key)).toBeUndefined();
  });

  test("generateApiKey mints a fresh key after revocation", () => {
    const key = generateApiKey("again");
    revokeApiKey(key);
    const next = generateApiKey("again");
    expect(next).not.toBe(key);
    expect(resolveApiKeyToken(next)).toBe("again");
  });
});
