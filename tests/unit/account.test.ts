import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

afterAll(() => {
  delete process.env.PROXY_SECRET;
  delete process.env.AUTH_TOKENS;
  delete process.env.PROXY_SECRET_FILE;
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

  test("prunes the mint cache so it cannot grow without bound", () => {
    const first = generateApiKey("prune-token-0");
    for (let i = 1; i < 10_100; i++) generateApiKey(`prune-token-${i}`);
    // Keys are stateless ciphertext: already-issued keys keep resolving even
    // after their cache entry is pruned.
    expect(resolveApiKeyToken(first)).toBe("prune-token-0");
    // The pruned token re-mints a fresh key on the next registration.
    const reminted = generateApiKey("prune-token-0");
    expect(reminted).not.toBe(first);
    expect(resolveApiKeyToken(reminted)).toBe("prune-token-0");
  });
});

describe("secret stability across processes/restarts", () => {
  test("PROXY_SECRET env keeps a key resolvable after a simulated restart", () => {
    // PROXY_SECRET is set in beforeAll. Mint, then drop the cached secret and
    // key map (as a fresh process would), then resolve: still works.
    const key = generateApiKey("restart-token");
    resetAccountStateForTests();
    expect(resolveApiKeyToken(key)).toBe("restart-token");
  });

  test("persisted secret file keeps a key resolvable without env secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb2api-test-"));
    const secretFile = join(dir, "secret");
    delete process.env.PROXY_SECRET;
    delete process.env.AUTH_TOKENS;
    process.env.PROXY_SECRET_FILE = secretFile;
    try {
      resetAccountStateForTests();
      const key = generateApiKey("file-token");
      // Simulate a fresh process: cached secret + key map are dropped, but the
      // persisted file is re-read, so the key must still decrypt.
      resetAccountStateForTests();
      expect(resolveApiKeyToken(key)).toBe("file-token");
    } finally {
      delete process.env.PROXY_SECRET_FILE;
      process.env.PROXY_SECRET = "unit-test-secret-0123456789abcdef";
      rmSync(dir, { recursive: true, force: true });
      resetAccountStateForTests();
    }
  });

  test("AUTH_TOKENS env also stabilizes the secret", () => {
    delete process.env.PROXY_SECRET;
    process.env.AUTH_TOKENS = "token-a,token-b";
    try {
      resetAccountStateForTests();
      const key = generateApiKey("tokens-token");
      resetAccountStateForTests();
      expect(resolveApiKeyToken(key)).toBe("tokens-token");
    } finally {
      delete process.env.AUTH_TOKENS;
      process.env.PROXY_SECRET = "unit-test-secret-0123456789abcdef";
      resetAccountStateForTests();
    }
  });
});
