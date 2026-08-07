/**
 * Device-code login for freebuff2api — mirrors the official CodebuffAI/freebuff
 * CLI login flow (cli/src/login/login-flow.ts + cli/src/utils/codebuff-api.ts):
 *
 *   1. POST {base}/api/auth/cli/code   { fingerprintId }
 *        -> { loginUrl, fingerprintHash, expiresAt }
 *   2. The user opens `loginUrl` in a browser and signs in on freebuff.com.
 *   3. GET  {base}/api/auth/cli/status ?fingerprintId=…&fingerprintHash=…&expiresAt=…
 *        -> { user: { id, name, email, authToken, … } } once signed in.
 *
 * Credentials are stored at ~/.config/freebuff2api/credentials.json (same
 * shape the official CLI uses, under a "default" key). An in-progress login is
 * persisted at ~/.config/freebuff2api/pending-login.json so an interrupted
 * login can be resumed with `freebuff2api login --resume`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LOGIN_BASE_URL = "https://freebuff.com";
export const LOGIN_POLL_INTERVAL_MS = 5_000;
export const LOGIN_POLL_TIMEOUT_MS = 5 * 60_000;
export const LOGIN_REQUEST_TIMEOUT_MS = 30_000;

/** The user record returned by the login flow; authToken is what we use. */
export interface StoredUser {
  id?: string;
  name: string;
  email: string;
  authToken: string;
  fingerprintId?: string;
  fingerprintHash?: string;
  credits?: number;
}

export interface LoginCode {
  loginUrl: string;
  fingerprintHash: string;
  expiresAt: number; // epoch ms
}

export interface PendingLogin {
  fingerprintId: string;
  fingerprintHash: string;
  expiresAt: number;
  loginUrl: string;
  createdAt: number;
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

export class LoginTimeoutError extends LoginError {
  constructor(timeoutMs: number) {
    super(
      `login timed out after ${Math.round(timeoutMs / 1000)}s — ` +
        'run "freebuff2api login --resume" to keep waiting with the same link',
    );
    this.name = "LoginTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Paths & persistence
// ---------------------------------------------------------------------------

export function configDir(): string {
  // Primarily useful for isolated test runs and explicit deployments; normal
  // users continue to use the platform's standard per-user config directory.
  const override = process.env.FREEBUFF2API_CONFIG_DIR?.trim();
  return override || join(homedir(), ".config", "freebuff2api");
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

function pendingLoginPath(): string {
  return join(configDir(), "pending-login.json");
}

function fingerprintPath(): string {
  return join(configDir(), "fingerprint");
}

function ensureConfigDir(): void {
  mkdirSync(configDir(), { recursive: true });
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Persistent install fingerprint — the "device identity" used by the official
 * CLI. We persist a random legacy-style id (`codebuff-cli-<random>`) so it
 * stays stable across runs, exactly like the official CLI's hardware-derived
 * fingerprint does across processes.
 */
export function getFingerprintId(): string {
  const path = fingerprintPath();
  const existing = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (existing) return existing;
  const id = `codebuff-cli-${randomBytes(6).toString("base64url").slice(0, 8)}`;
  ensureConfigDir();
  writeFileSync(path, id, "utf8");
  return id;
}

/** Load the saved user record, or null when not logged in. */
export function loadCredentials(): StoredUser | null {
  const data = readJson<{ default?: StoredUser }>(credentialsPath());
  const user = data?.default;
  return user && typeof user.authToken === "string" && user.authToken ? user : null;
}

export function saveCredentials(user: StoredUser): void {
  ensureConfigDir();
  writeFileSync(credentialsPath(), JSON.stringify({ default: user }, null, 2) + "\n", "utf8");
}

function loadPendingLogin(): PendingLogin | null {
  const pending = readJson<PendingLogin>(pendingLoginPath());
  if (!pending) return null;
  if (typeof pending.fingerprintId !== "string" || typeof pending.loginUrl !== "string") return null;
  return pending;
}

function savePendingLogin(pending: PendingLogin): void {
  ensureConfigDir();
  writeFileSync(pendingLoginPath(), JSON.stringify(pending, null, 2) + "\n", "utf8");
}

function clearPendingLogin(): void {
  if (existsSync(pendingLoginPath())) rmSync(pendingLoginPath());
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

async function requestJson(url: string, init: RequestInit): Promise<{ status: number; body: string }> {
  const resp = await fetch(url, init);
  return { status: resp.status, body: await resp.text() };
}

/** Step 1 — request a one-time login code and URL for the given fingerprint. */
export async function requestLoginCode(baseURL: string, fingerprintId: string): Promise<LoginCode> {
  let result: { status: number; body: string };
  try {
    result = await requestJson(`${baseURL}/api/auth/cli/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprintId }),
      signal: AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LoginError(`failed to reach ${baseURL}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new LoginError(`login code request failed with status ${result.status}: ${result.body.slice(0, 300)}`);
  }
  let parsed: { loginUrl?: unknown; fingerprintHash?: unknown; expiresAt?: unknown };
  try {
    parsed = JSON.parse(result.body) as typeof parsed;
  } catch {
    throw new LoginError(`login code response was not JSON: ${result.body.slice(0, 300)}`);
  }
  if (typeof parsed.loginUrl !== "string" || typeof parsed.fingerprintHash !== "string") {
    throw new LoginError(`unexpected login code response: ${result.body.slice(0, 300)}`);
  }
  const expiresAt =
    typeof parsed.expiresAt === "number" ? parsed.expiresAt : Date.parse(String(parsed.expiresAt ?? ""));
  return {
    loginUrl: parsed.loginUrl,
    fingerprintHash: parsed.fingerprintHash,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60_000,
  };
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onTick?: (attempt: number, elapsedMs: number) => void;
}

/**
 * Step 3 — poll /api/auth/cli/status until the user record arrives (the
 * backend answers 401 "Authentication failed" while the code is still pending,
 * which we silently keep retrying, matching the official client).
 */
export async function pollLoginStatus(
  baseURL: string,
  pending: PendingLogin,
  opts: PollOptions = {},
): Promise<StoredUser> {
  const intervalMs = opts.intervalMs ?? LOGIN_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? LOGIN_POLL_TIMEOUT_MS;
  const started = Date.now();
  let attempt = 0;

  const params = new URLSearchParams({
    fingerprintId: pending.fingerprintId,
    fingerprintHash: pending.fingerprintHash,
    expiresAt: String(pending.expiresAt),
  });

  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) throw new LoginTimeoutError(timeoutMs);
    attempt += 1;
    try {
      const resp = await fetch(`${baseURL}/api/auth/cli/status?${params}`, {
        signal: AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS),
      });
      if (resp.ok) {
        const parsed = (await resp.json().catch(() => null)) as { user?: StoredUser } | null;
        const user = parsed?.user;
        if (user && typeof user.authToken === "string" && user.authToken) {
          return user;
        }
      }
    } catch {
      // Transient network error — keep polling.
    }
    opts.onTick?.(attempt, elapsed);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface RunLoginOptions {
  baseURL: string;
  force?: boolean;
  resume?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  log: (message: string) => void;
}

/**
 * Orchestrate the login command: resume a pending login, or start a fresh one,
 * then poll until the user completes the browser sign-in and persist the
 * credentials.
 */
export async function runLoginCommand(opts: RunLoginOptions): Promise<void> {
  const baseURL = opts.baseURL.replace(/\/+$/, "");
  const log = opts.log;

  const existing = loadCredentials();
  const pending = loadPendingLogin();
  const pendingValid = pending ? pending.expiresAt > Date.now() : false;

  let active: PendingLogin;
  if (opts.resume && pendingValid) {
    // Resume takes precedence over an existing login: the user may have
    // started a fresh login (possibly for a different account) and is now
    // coming back to finish it.
    active = pending as PendingLogin;
    log("Continuing previous login…");
  } else if (existing && !opts.force) {
    log(`Already logged in as ${existing.name || existing.email} (${existing.email}).`);
    log(`Credentials: ${credentialsPath()}`);
    log('Use "freebuff2api login --force" to sign in again with a fresh token.');
    return;
  } else if (opts.resume && !pendingValid) {
    throw new LoginError(
      pending
        ? "previous pending login has expired — run \"freebuff2api login\" for a fresh link"
        : 'no pending login found — run "freebuff2api login" first',
    );
  } else {
    if (opts.force) clearPendingLogin();
    log("Generating login URL…");
    const fingerprintId = getFingerprintId();
    const code = await requestLoginCode(baseURL, fingerprintId);
    active = { ...code, fingerprintId, createdAt: Date.now() };
    savePendingLogin(active);
  }

  log("");
  log("Open this URL in your browser to log in:");
  log(`  ${active.loginUrl}`);
  log("");
  log("Waiting for login… (Ctrl+C to stop; resume later with --resume)");

  const user = await pollLoginStatus(baseURL, active, {
    intervalMs: opts.intervalMs,
    timeoutMs: opts.timeoutMs,
    onTick: (attempt, elapsed) => {
      if (attempt === 1 || attempt % 3 === 0) {
        log(`[login] still waiting… (${attempt} polls, ${Math.round(elapsed / 1000)}s elapsed)`);
      }
    },
  });

  saveCredentials(user);
  clearPendingLogin();
  log("");
  log(`✓ Logged in as ${user.name || user.email} (${user.email})`);
  log(`Credentials saved to ${credentialsPath()}`);
}
