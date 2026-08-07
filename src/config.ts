/**
 * Configuration for freebuff2api.
 *
 * Values are resolved from (in priority order):
 *   1. Environment variables
 *   2. `config.json` in the working directory (if present)
 *   3. Built-in defaults
 *
 * Environment variable names mirror the upstream Go reference implementation:
 *   LISTEN_ADDR          - listen address, e.g. ":8080" (default ":8080")
 *   PORT                 - Freebuff-injected port; overrides the LISTEN_ADDR port
 *   UPSTREAM_BASE_URL    - Freebuff backend base URL (default "https://www.codebuff.com")
 *   AUTH_TOKENS          - comma-separated Freebuff auth tokens (REQUIRED)
 *   REQUEST_TIMEOUT      - upstream request timeout, Go duration syntax, e.g. "15m"
 *   ROTATION_INTERVAL    - how long a token pool stays preferred (default "6h")
 *   API_KEYS             - optional comma-separated keys clients must send to this proxy
 *   HTTP_PROXY           - optional HTTP(S) proxy URL used for upstream calls
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadCredentials } from "./login.ts";

export interface Config {
  /** Full listen address including host and port, e.g. ":8080". */
  listenAddr: string;
  /** Freebuff backend base URL, no trailing slash. */
  upstreamBaseURL: string;
  /** Base URL for the device-code login flow, no trailing slash. */
  loginBaseURL: string;
  /** Freebuff auth tokens, deduplicated, trimmed. */
  authTokens: string[];
  /** How long a token pool stays preferred before rotation (ms). */
  rotationIntervalMs: number;
  /** Upstream request timeout (ms). */
  requestTimeoutMs: number;
  /** User-Agent sent to the upstream API. */
  userAgent: string;
  /** Freebuff user id sent as x-freebuff-acting-user-id (from saved login). */
  actingUserId: string | null;
  /** Optional keys clients must present to this proxy. Empty = open. */
  apiKeys: string[];
  /** Optional upstream proxy URL. */
  httpProxy: string | null;
}

interface RawConfig {
  LISTEN_ADDR?: string;
  UPSTREAM_BASE_URL?: string;
  LOGIN_BASE_URL?: string;
  USER_AGENT?: string;
  AUTH_TOKENS?: string[];
  ROTATION_INTERVAL?: string;
  REQUEST_TIMEOUT?: string;
  API_KEYS?: string[];
  HTTP_PROXY?: string;
}

const DEFAULTS: RawConfig = {
  LISTEN_ADDR: ":8080",
  UPSTREAM_BASE_URL: "https://www.codebuff.com",
  LOGIN_BASE_URL: "https://freebuff.com",
  ROTATION_INTERVAL: "6h",
  REQUEST_TIMEOUT: "15m",
};

/** Parse a Go-style duration like "15m", "6h", "90s", "1h30m" into ms. */
export function parseDuration(value: string, fallbackMs: number): number {
  const input = value.trim();
  if (!input) return fallbackMs;

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  // A bare number is interpreted as milliseconds for convenient local config.
  if (/^\d+(?:\.\d+)?$/.test(input)) {
    const ms = Number.parseFloat(input);
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : fallbackMs;
  }

  // Accept concatenated Go-style components such as "1h30m" and "2m500ms".
  const component = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g;
  let cursor = 0;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = component.exec(input)) !== null) {
    if (match.index !== cursor) return fallbackMs;
    total += Number.parseFloat(match[1]) * multipliers[match[2]];
    cursor = component.lastIndex;
  }
  if (cursor !== input.length || !Number.isFinite(total) || total <= 0) return fallbackMs;
  return Math.round(total);
} 

function parseListenAddr(raw: string, portOverride?: string): string {
  const addr = raw.trim() || ":8080";
  if (!portOverride) return addr;
  const port = Number.parseInt(portOverride, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return addr;
  if (addr.startsWith(":")) return `:${port}`;
  const idx = addr.lastIndexOf(":");
  if (idx === -1) return `${addr}:${port}`;
  return `${addr.slice(0, idx)}:${port}`;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;\n\r]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function autoConfigPath(): string {
  // Look for config.json in CWD, then in the user's home directory.
  const candidates = [join(process.cwd(), "config.json")];
  const home = homedir();
  if (home) candidates.push(join(home, ".freebuff2api", "config.json"));
  return candidates.find((path) => existsSync(path)) ?? "";
}

function loadRawConfig(): RawConfig {
  const cfg: RawConfig = { ...DEFAULTS };
  const path = autoConfigPath();
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
      if (parsed.LISTEN_ADDR !== undefined) cfg.LISTEN_ADDR = parsed.LISTEN_ADDR;
      if (parsed.UPSTREAM_BASE_URL !== undefined) cfg.UPSTREAM_BASE_URL = parsed.UPSTREAM_BASE_URL;
      if (parsed.LOGIN_BASE_URL !== undefined) cfg.LOGIN_BASE_URL = parsed.LOGIN_BASE_URL;
      if (parsed.USER_AGENT !== undefined) cfg.USER_AGENT = parsed.USER_AGENT;
      if (parsed.AUTH_TOKENS !== undefined && Array.isArray(parsed.AUTH_TOKENS)) {
        cfg.AUTH_TOKENS = parsed.AUTH_TOKENS;
      }
      if (parsed.ROTATION_INTERVAL !== undefined) cfg.ROTATION_INTERVAL = parsed.ROTATION_INTERVAL;
      if (parsed.REQUEST_TIMEOUT !== undefined) cfg.REQUEST_TIMEOUT = parsed.REQUEST_TIMEOUT;
      if (parsed.API_KEYS !== undefined && Array.isArray(parsed.API_KEYS)) {
        cfg.API_KEYS = parsed.API_KEYS;
      }
      if (parsed.HTTP_PROXY !== undefined) cfg.HTTP_PROXY = parsed.HTTP_PROXY;
    } catch (error) {
      console.warn(`[config] failed to parse ${path}: ${String(error)}`);
    }
  }

  // Environment overrides.
  const env = process.env;
  if (env.LISTEN_ADDR) cfg.LISTEN_ADDR = env.LISTEN_ADDR;
  if (env.UPSTREAM_BASE_URL) cfg.UPSTREAM_BASE_URL = env.UPSTREAM_BASE_URL;
  if (env.LOGIN_BASE_URL) cfg.LOGIN_BASE_URL = env.LOGIN_BASE_URL;
  if (env.USER_AGENT) cfg.USER_AGENT = env.USER_AGENT;
  if (env.AUTH_TOKENS) cfg.AUTH_TOKENS = splitList(env.AUTH_TOKENS);
  if (env.ROTATION_INTERVAL) cfg.ROTATION_INTERVAL = env.ROTATION_INTERVAL;
  if (env.REQUEST_TIMEOUT) cfg.REQUEST_TIMEOUT = env.REQUEST_TIMEOUT;
  if (env.API_KEYS) cfg.API_KEYS = splitList(env.API_KEYS);
  if (env.HTTP_PROXY || env.https_proxy) cfg.HTTP_PROXY = env.HTTP_PROXY || env.https_proxy;

  return cfg;
}

export interface LoadConfigOptions {
  /** When false, missing auth tokens are allowed (used by `login`). Default true. */
  requireToken?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const raw = loadRawConfig();
  const requireToken = options.requireToken !== false;

  const upstreamBaseURL = (raw.UPSTREAM_BASE_URL ?? "").replace(/\/+$/, "");
  if (!upstreamBaseURL) {
    throw new Error("UPSTREAM_BASE_URL cannot be empty");
  }

  const loginBaseURL = (raw.LOGIN_BASE_URL ?? "").replace(/\/+$/, "");
  if (!loginBaseURL) {
    throw new Error("LOGIN_BASE_URL cannot be empty");
  }

  // Token resolution: env / config.json AUTH_TOKENS first, then the saved
  // `freebuff2api login` credentials (~/.config/freebuff2api/credentials.json).
  const authTokens = dedupe(raw.AUTH_TOKENS ?? []);
  const credentials = loadCredentials();
  if (authTokens.length === 0) {
    if (credentials?.authToken) authTokens.push(credentials.authToken);
  }
  if (authTokens.length === 0 && requireToken) {
    throw new Error(
      "No AUTH_TOKENS configured. Set the AUTH_TOKENS environment variable (or config.json), " +
        'or run "freebuff2api login" to sign in and store your credentials.',
    );
  }

  const apiKeys = dedupe(raw.API_KEYS ?? []);

  // Freebuff injects PORT for isolated workspaces; it wins over LISTEN_ADDR's port.
  const listenAddr = parseListenAddr(raw.LISTEN_ADDR ?? ":8080", process.env.PORT);

  return {
    listenAddr,
    upstreamBaseURL,
    loginBaseURL,
    authTokens,
    rotationIntervalMs: parseDuration(raw.ROTATION_INTERVAL ?? "6h", 6 * 3_600_000),
    requestTimeoutMs: parseDuration(raw.REQUEST_TIMEOUT ?? "15m", 15 * 60_000),
    // The free tier gates requests on the official client's compound SDK
    // user-agent: `ai-sdk/openai-compatible/<ver>/codebuff ai-sdk/provider-utils/<ver>
    // runtime/<runtime>` (captured from the official CLI). Override with USER_AGENT.
    userAgent:
      raw.USER_AGENT ??
      "ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser",
    actingUserId: credentials?.id ?? null,
    apiKeys,
    httpProxy: (raw.HTTP_PROXY ?? "").trim() || null,
  };
}
