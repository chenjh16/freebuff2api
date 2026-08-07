/**
 * Account registry for the hosted web login flow.
 *
 * A visitor signs in with their freebuff.com account on the site; the server
 * validates the account token (GET /api/v1/me) and mints an API key in the
 * form `sk-fb-<iv+tag+ciphertext>` — the account token encrypted with
 * AES-256-GCM using a server secret. The proxy then resolves any presented
 * `sk-fb-…` key back to the account token (src/handler.ts), so ordinary
 * OpenAI-compatible clients only ever need the API key.
 *
 * Stateless by design: keys survive server restarts / instance rotation as
 * long as the secret is stable. Secret precedence:
 *
 *   1. `PROXY_SECRET` env  — set it on the hosted deployment so every
 *      instance and every redeploy shares the same secret.
 *   2. `AUTH_TOKENS` env    — stable while the token list does not change.
 *   3. persisted file       — generated once and stored at `PROXY_SECRET_FILE`
 *      (default `<cwd>/.data/proxy-secret`); reused across process restarts
 *      on the same filesystem, so keys survive restarts without any env var.
 *   4. per-process random   — last resort only; keys then reset on restart.
 *
 * Fixes `invalid proxy api key` (401 authentication_error) that appeared when
 * a key minted by /api/auth/register could not be decrypted by a different
 * process (serverless instance, preview, restart) because the fallback secret
 * was `ephemeral:${pid}:${Date.now()}`.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const API_KEY_PREFIX = "sk-fb-";

/** Keys explicitly revoked (logout). In-memory; a restart forgets it. */
const REVOKED = new Set<string>();
/** token → minted key, so re-registering the same account returns the same key. */
const KEY_BY_TOKEN = new Map<string, string>();

/** Where the fallback secret is persisted when no env secret is configured. */
function persistedSecretPath(): string {
  const file = process.env.PROXY_SECRET_FILE?.trim();
  if (file) return file;
  return join(process.cwd(), ".data", "proxy-secret");
}

/**
 * Read the persisted secret, or generate and persist one. Returns a 32-byte
 * derived key, or null when the filesystem is unavailable (read-only
 * serverless filesystems without PROXY_SECRET — callers fall back to a
 * per-process random secret in that case).
 */
function loadOrCreatePersistedSecret(): Buffer | null {
  try {
    const path = persistedSecretPath();
    if (existsSync(path)) {
      const raw = readFileSync(path);
      if (raw.length >= 16) return createHash("sha256").update(`freebuff2api:file:${raw.toString("hex")}`).digest();
    }
    const raw = randomBytes(32);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, raw, { mode: 0o600 });
    return createHash("sha256").update(`freebuff2api:file:${raw.toString("hex")}`).digest();
  } catch {
    return null;
  }
}

function deriveSecret(): Buffer {
  const fromEnv = process.env.PROXY_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) return createHash("sha256").update(`freebuff2api:${fromEnv}`).digest();
  const fromTokens = process.env.AUTH_TOKENS?.trim();
  if (fromTokens) return createHash("sha256").update(`freebuff2api:tokens:${fromTokens}`).digest();
  const fromFile = loadOrCreatePersistedSecret();
  if (fromFile) return fromFile;
  return createHash("sha256").update(`freebuff2api:ephemeral:${process.pid}:${Date.now()}`).digest();
}

let secret: Buffer | null = null;
function getSecret(): Buffer {
  if (!secret) secret = deriveSecret();
  return secret;
}

/** Mint (or reuse) the API key for an account token. */
export function generateApiKey(authToken: string): string {
  const existing = KEY_BY_TOKEN.get(authToken);
  if (existing && !REVOKED.has(existing)) return existing;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getSecret(), iv);
  const encrypted = Buffer.concat([cipher.update(authToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const key = `${API_KEY_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
  KEY_BY_TOKEN.set(authToken, key);
  return key;
}

/**
 * Resolve an API key to the upstream account token, or undefined when the key
 * is unknown, tampered with, or revoked.
 */
export function resolveApiKeyToken(apiKey: string): string | undefined {
  if (!apiKey.startsWith(API_KEY_PREFIX)) return undefined;
  if (REVOKED.has(apiKey)) return undefined;
  try {
    const raw = Buffer.from(apiKey.slice(API_KEY_PREFIX.length), "base64url");
    if (raw.length < 12 + 16 + 1) return undefined;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", getSecret(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(data, undefined, "utf8") + decipher.final("utf8");
  } catch {
    return undefined;
  }
}

/** Revoke a key: it stops resolving (in-memory) and is dropped from the map. */
export function revokeApiKey(apiKey: string): void {
  if (!apiKey.startsWith(API_KEY_PREFIX)) return;
  REVOKED.add(apiKey);
  for (const [token, key] of KEY_BY_TOKEN) {
    if (key === apiKey) KEY_BY_TOKEN.delete(token);
  }
}

/** Test-only: forget cached secret + revocations so tests can control env. */
export function resetAccountStateForTests(): void {
  secret = null;
  REVOKED.clear();
  KEY_BY_TOKEN.clear();
}
