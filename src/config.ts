/**
 * Configuration for freebuff2api.
 *
 * Values are resolved from environment variables, `config.json`, saved login
 * credentials, and built-in defaults. HTTP_PROXY is intentionally resolved
 * separately as CLI > config.json > environment.
 *
 * Environment variable names mirror the upstream Go reference implementation:
 *   LISTEN_ADDR          - listen address, e.g. ":23333" (default ":23333")
 *   PORT                 - Freebuff-injected port; overrides the LISTEN_ADDR port
 *   UPSTREAM_BASE_URL    - Freebuff backend base URL (default "https://www.codebuff.com")
 *   AUTH_TOKENS          - comma-separated Freebuff auth tokens (REQUIRED)
 *   REQUEST_TIMEOUT      - upstream request timeout, Go duration syntax, e.g. "15m"
 *   ROTATION_INTERVAL    - how long a token pool stays preferred (default "6h")
 *   API_KEYS             - optional comma-separated keys clients must send to this proxy
 *   HTTP_PROXY           - optional HTTP(S) proxy URL used for upstream calls
 *   MAX_BODY_SIZE        - maximum chat request body, e.g. "16mb" (default "16mb")
 *   MAX_CONCURRENT_REQUESTS - maximum in-flight chat requests (default 32)
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
  /** Maximum accepted chat request body size in bytes. */
  maxBodyBytes: number;
  /** Maximum number of concurrent chat requests. */
  maxConcurrentRequests: number;
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
  MAX_BODY_SIZE?: string;
  MAX_CONCURRENT_REQUESTS?: string;
}

const DEFAULTS: RawConfig = {
  LISTEN_ADDR: ":23333",
  UPSTREAM_BASE_URL: "https://www.codebuff.com",
  LOGIN_BASE_URL: "https://freebuff.com",
  ROTATION_INTERVAL: "6h",
  REQUEST_TIMEOUT: "15m",
  MAX_BODY_SIZE: "16MB",
  MAX_CONCURRENT_REQUESTS: "32",
};

const DEFAULT_MAX_BODY_BYTES = 16_000_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;

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

export function parseListenAddr(raw: string, portOverride?: string): string {
  const addr = raw.trim() || ":23333";
  if (!portOverride) return addr;
  const port = Number.parseInt(portOverride, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return addr;
  if (addr.startsWith(":")) return `:${port}`;
  const idx = addr.lastIndexOf(":");
  if (idx === -1) return `${addr}:${port}`;
  return `${addr.slice(0, idx)}:${port}`;
}

export function parseByteSize(value: string, fallbackBytes: number): number {
  const input = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/.exec(input);
  if (!match) return fallbackBytes;
  const amount = Number.parseFloat(match[1]);
  const units: Record<string, number> = {
    b: 1,
    kb: 1_000,
    kib: 1_024,
    mb: 1_000_000,
    mib: 1_048_576,
    gb: 1_000_000_000,
    gib: 1_073_741_824,
  };
  const bytes = amount * (units[match[2] ?? "b"] ?? 1);
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : fallbackBytes;
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

function autoConfigPath(explicitPath?: string): string {
  if (explicitPath?.trim()) return explicitPath.trim();
  // Look for config.json in CWD, then in the user's home directory.
  const candidates = [join(process.cwd(), "config.json")];
  const home = homedir();
  if (home) candidates.push(join(home, ".freebuff2api", "config.json"));
  return candidates.find((path) => existsSync(path)) ?? "";
}

interface ConfigOverrides {
  configPath?: string;
  listenAddr?: string;
  port?: string;
  upstreamBaseURL?: string;
  loginBaseURL?: string;
  authTokens?: string[];
  userAgent?: string;
  rotationInterval?: string;
  requestTimeout?: string;
  apiKeys?: string[];
  httpProxy?: string;
  maxBodySize?: string;
  maxConcurrentRequests?: string;
}

function loadRawConfig(configPath?: string): RawConfig {
  const cfg: RawConfig = { ...DEFAULTS };
  const path = autoConfigPath(configPath);
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
      if (parsed.MAX_BODY_SIZE !== undefined) cfg.MAX_BODY_SIZE = parsed.MAX_BODY_SIZE;
      if (parsed.MAX_CONCURRENT_REQUESTS !== undefined) cfg.MAX_CONCURRENT_REQUESTS = parsed.MAX_CONCURRENT_REQUESTS;
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
  // HTTP_PROXY is intentionally different: config.json wins over the environment.
  // Bun's lowercase/HTTPS variants remain useful environment fallbacks.
  if (!cfg.HTTP_PROXY && (env.HTTP_PROXY || env.HTTPS_PROXY || env.https_proxy)) {
    cfg.HTTP_PROXY = env.HTTP_PROXY || env.HTTPS_PROXY || env.https_proxy;
  }
  if (env.MAX_BODY_SIZE) cfg.MAX_BODY_SIZE = env.MAX_BODY_SIZE;
  if (env.MAX_CONCURRENT_REQUESTS) cfg.MAX_CONCURRENT_REQUESTS = env.MAX_CONCURRENT_REQUESTS;

  return cfg;
}

export interface LoadConfigOptions extends ConfigOverrides {
  /** When false, missing auth tokens are allowed (used by `login`). Default true. */
  requireToken?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const raw = loadRawConfig(options.configPath);
  const requireToken = options.requireToken !== false;

  const configuredUpstreamBaseURL = (options.upstreamBaseURL ?? raw.UPSTREAM_BASE_URL ?? "").replace(/\/+$/, "");
  if (!configuredUpstreamBaseURL) {
    throw new Error("UPSTREAM_BASE_URL cannot be empty");
  }

  const configuredLoginBaseURL = (options.loginBaseURL ?? raw.LOGIN_BASE_URL ?? "").replace(/\/+$/, "");
  if (!configuredLoginBaseURL) {
    throw new Error("LOGIN_BASE_URL cannot be empty");
  }

  // Token resolution: env / config.json AUTH_TOKENS first, then the saved
  // `freebuff2api login` credentials (~/.config/freebuff2api/credentials.json).
  const authTokens = dedupe(options.authTokens ?? raw.AUTH_TOKENS ?? []);
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

  const apiKeys = dedupe(options.apiKeys ?? raw.API_KEYS ?? []);

  // Explicit CLI values win over managed PORT/environment values.
  const listenAddr = parseListenAddr(
    options.listenAddr ?? raw.LISTEN_ADDR ?? ":23333",
    options.port ?? (options.listenAddr ? undefined : process.env.PORT),
  );
  // Unlike the other legacy environment settings, HTTP_PROXY has an explicit
  // three-level precedence: CLI > config.json > environment. loadRawConfig has
  // already selected config.json over the environment; this option is the CLI
  // layer and is therefore applied last.
  const httpProxy = (options.httpProxy ?? raw.HTTP_PROXY ?? "").trim() || null;

  return {
    listenAddr,
    upstreamBaseURL: configuredUpstreamBaseURL,
    loginBaseURL: configuredLoginBaseURL,
    authTokens,
    rotationIntervalMs: parseDuration(options.rotationInterval ?? raw.ROTATION_INTERVAL ?? "6h", 6 * 3_600_000),
    requestTimeoutMs: parseDuration(options.requestTimeout ?? raw.REQUEST_TIMEOUT ?? "15m", 15 * 60_000),
    // The free tier gates requests on the official client's compound SDK
    // user-agent: `ai-sdk/openai-compatible/<ver>/codebuff ai-sdk/provider-utils/<ver>
    // runtime/<runtime>` (captured from the official CLI). Override with USER_AGENT.
    userAgent:
      options.userAgent ??
      raw.USER_AGENT ??
      "ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser",
    actingUserId: credentials?.id ?? null,
    apiKeys,
    httpProxy,
    maxBodyBytes: parseByteSize(options.maxBodySize ?? raw.MAX_BODY_SIZE ?? "16MB", DEFAULT_MAX_BODY_BYTES),
    maxConcurrentRequests: Math.max(
      1,
      Math.round(Number.parseInt(options.maxConcurrentRequests ?? raw.MAX_CONCURRENT_REQUESTS ?? "32", 10) || DEFAULT_MAX_CONCURRENT_REQUESTS),
    ),
  };
}
