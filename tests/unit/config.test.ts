import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseDuration } from "../../src/config.ts";

const ENV_KEYS = [
  "AUTH_TOKENS",
  "LISTEN_ADDR",
  "PORT",
  "UPSTREAM_BASE_URL",
  "LOGIN_BASE_URL",
  "USER_AGENT",
  "API_KEYS",
  "REQUEST_TIMEOUT",
  "ROTATION_INTERVAL",
  "HTTP_PROXY",
  "https_proxy",
  "FREEBUFF2API_CONFIG_DIR",
];

let saved: Record<string, string | undefined> = {};
let configBase = "";

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Isolate saved credentials without relying on Bun's cached homedir().
  configBase = mkdtempSync(join(tmpdir(), "fb2api-cfg-"));
  process.env.FREEBUFF2API_CONFIG_DIR = configBase;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(configBase, { recursive: true, force: true });
});

describe("parseDuration", () => {
  test("parses Go-style durations", () => {
    expect(parseDuration("15m", 0)).toBe(15 * 60_000);
    expect(parseDuration("6h", 0)).toBe(6 * 3_600_000);
    expect(parseDuration("90s", 0)).toBe(90_000);
    expect(parseDuration("1h30m", 0)).toBe(5_400_000);
    expect(parseDuration("500ms", 0)).toBe(500);
    expect(parseDuration("1d", 0)).toBe(86_400_000);
    expect(parseDuration("2", 0)).toBe(2); // bare number = ms
  });

  test("falls back on garbage or empty input", () => {
    expect(parseDuration("banana", 42)).toBe(42);
    expect(parseDuration("", 42)).toBe(42);
    expect(parseDuration("  ", 42)).toBe(42);
    expect(parseDuration("-5m", 42)).toBe(42);
  });
});

describe("loadConfig", () => {
  test("resolves tokens from AUTH_TOKENS with splitting and dedupe", () => {
    process.env.AUTH_TOKENS = "tok-a,tok-b;tok-c\ntok-a";
    const cfg = loadConfig();
    expect(cfg.authTokens).toEqual(["tok-a", "tok-b", "tok-c"]);
  });

  test("falls back to saved login credentials when AUTH_TOKENS is empty", () => {
    const credsDir = configBase;
    mkdirSync(credsDir, { recursive: true });
    writeFileSync(
      join(credsDir, "credentials.json"),
      JSON.stringify({ default: { id: "user-1", name: "Tester", email: "t@t.t", authToken: "cred-token" } }),
      "utf8",
    );
    const cfg = loadConfig();
    expect(cfg.authTokens).toEqual(["cred-token"]);
    expect(cfg.actingUserId).toBe("user-1");
  });

  test("throws when no token is available and requireToken is true", () => {
    expect(() => loadConfig()).toThrow(/AUTH_TOKENS/);
  });

  test("requireToken:false allows a token-less config (login command)", () => {
    const cfg = loadConfig({ requireToken: false });
    expect(cfg.authTokens).toEqual([]);
    expect(cfg.actingUserId).toBeNull();
  });

  test("trims trailing slashes from base URLs and applies defaults", () => {
    process.env.UPSTREAM_BASE_URL = "https://www.codebuff.com///";
    process.env.AUTH_TOKENS = "tok";
    const cfg = loadConfig();
    expect(cfg.upstreamBaseURL).toBe("https://www.codebuff.com");
    expect(cfg.loginBaseURL).toBe("https://freebuff.com");
    expect(cfg.userAgent).toContain("ai-sdk/openai-compatible");
    expect(cfg.rotationIntervalMs).toBe(6 * 3_600_000);
    expect(cfg.requestTimeoutMs).toBe(15 * 60_000);
    expect(cfg.apiKeys).toEqual([]);
    expect(cfg.httpProxy).toBeNull();
  });

  test("applies REQUEST_TIMEOUT / ROTATION_INTERVAL env overrides", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.REQUEST_TIMEOUT = "30s";
    process.env.ROTATION_INTERVAL = "1h";
    const cfg = loadConfig();
    expect(cfg.requestTimeoutMs).toBe(30_000);
    expect(cfg.rotationIntervalMs).toBe(3_600_000);
  });

  test("parses API_KEYS with dedupe", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.API_KEYS = "k1, k2;k1";
    const cfg = loadConfig();
    expect(cfg.apiKeys).toEqual(["k1", "k2"]);
  });

  test("PORT env wins over the LISTEN_ADDR port (managed workspaces)", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.LISTEN_ADDR = ":8080";
    process.env.PORT = "3000";
    expect(loadConfig().listenAddr).toBe(":3000");

    process.env.LISTEN_ADDR = "127.0.0.1:9000";
    expect(loadConfig().listenAddr).toBe("127.0.0.1:3000");
  });

  test("ignores an invalid PORT and keeps LISTEN_ADDR", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.LISTEN_ADDR = ":8080";
    process.env.PORT = "not-a-port";
    expect(loadConfig().listenAddr).toBe(":8080");

    delete process.env.PORT;
    process.env.LISTEN_ADDR = "127.0.0.1:9000";
    expect(loadConfig().listenAddr).toBe("127.0.0.1:9000");
  });

  test("captures HTTP_PROXY (and https_proxy) as httpProxy", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.HTTP_PROXY = "http://127.0.0.1:7890";
    expect(loadConfig().httpProxy).toBe("http://127.0.0.1:7890");

    delete process.env.HTTP_PROXY;
    process.env.https_proxy = "http://127.0.0.1:7891";
    expect(loadConfig().httpProxy).toBe("http://127.0.0.1:7891");
  });
});
