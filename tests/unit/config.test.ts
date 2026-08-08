import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseByteSize, parseDuration } from "../../src/config.ts";

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
  "HTTPS_PROXY",
  "https_proxy",
  "MAX_BODY_SIZE",
  "MAX_CONCURRENT_REQUESTS",
  "PUBLIC_UPSTREAM_ENABLED",
  "PUBLIC_UPSTREAM_PROVIDERS",
  "PUBLIC_UPSTREAM_BASE_URL",
  "PUBLIC_UPSTREAM_MODELS",
  "PUBLIC_UPSTREAM_IMAGE_MODELS",
  "PUBLIC_UPSTREAM_TIMEOUT",
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

describe("parseByteSize", () => {
  test("parses common byte units", () => {
    expect(parseByteSize("16mb", 0)).toBe(16_000_000);
    expect(parseByteSize("16MiB", 0)).toBe(16 * 1024 * 1024);
    expect(parseByteSize("bad", 123)).toBe(123);
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
    process.env.PUBLIC_UPSTREAM_ENABLED = "false";
    expect(() => loadConfig()).toThrow(/AUTH_TOKENS/);
  });

  test("requireToken:false allows a token-less config (login command)", () => {
    const cfg = loadConfig({ requireToken: false });
    expect(cfg.authTokens).toEqual([]);
    expect(cfg.actingUserId).toBeNull();
  });

  test("enables the public route without requiring an account token", () => {
    const cfg = loadConfig();
    expect(cfg.authTokens).toEqual([]);
    expect(cfg.publicUpstreamEnabled).toBe(true);
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
    expect(cfg.listenAddr).toBe(":23333");
    expect(cfg.maxBodyBytes).toBe(16_000_000);
    expect(cfg.maxConcurrentRequests).toBe(32);
    expect(cfg.publicUpstreamEnabled).toBe(true);
    expect(cfg.publicUpstreamBaseURL).toBe("https://opencode.ai/zen/v1");
    expect(cfg.publicUpstreamProviders).toEqual(["opencode", "pollinations", "felo"]);
    expect(cfg.publicUpstreamModels).toContain("big-pickle");
    expect(cfg.publicUpstreamModels).toContain("pollinations/openai");
    expect(cfg.publicUpstreamModels).toContain("felo/felo-chat");
    expect(cfg.publicUpstreamImageModels).toContain("pollinations/flux");
    expect(cfg.publicUpstreamImageModels).toContain("pollinations/turbo");
    expect(cfg.publicUpstreamTimeoutMs).toBe(20_000);
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

  test("HTTP_PROXY precedence is CLI > config.json > environment", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.HTTP_PROXY = "http://env.proxy:8080";
    const path = join(configBase, "config.json");
    writeFileSync(path, JSON.stringify({ HTTP_PROXY: "http://file.proxy:8080" }), "utf8");

    expect(loadConfig({ configPath: path }).httpProxy).toBe("http://file.proxy:8080");
    expect(loadConfig({ configPath: path, httpProxy: "http://cli.proxy:8080" }).httpProxy).toBe("http://cli.proxy:8080");
  });

  test("enables the public upstream by default and allows explicit opt-out", () => {
    process.env.AUTH_TOKENS = "tok";
    expect(loadConfig().publicUpstreamEnabled).toBe(true);

    process.env.PUBLIC_UPSTREAM_ENABLED = "false";
    expect(loadConfig().publicUpstreamEnabled).toBe(false);
  });

  test("parses the public upstream configuration", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.PUBLIC_UPSTREAM_ENABLED = "true";
    process.env.PUBLIC_UPSTREAM_PROVIDERS = "opencode,pollinations";
    process.env.PUBLIC_UPSTREAM_MODELS = "big-pickle, pollinations/openai, big-pickle";
    process.env.PUBLIC_UPSTREAM_TIMEOUT = "3s";
    const cfg = loadConfig();
    expect(cfg.publicUpstreamEnabled).toBe(true);
    expect(cfg.publicUpstreamProviders).toEqual(["opencode", "pollinations"]);
    expect(cfg.publicUpstreamModels).toEqual(["big-pickle", "pollinations/openai"]);
    expect(cfg.publicUpstreamTimeoutMs).toBe(3_000);
  });

  test("parses PUBLIC_UPSTREAM_IMAGE_MODELS with dedupe and defaults", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.PUBLIC_UPSTREAM_IMAGE_MODELS = "pollinations/flux, pollinations/turbo, pollinations/flux";
    const cfg = loadConfig();
    expect(cfg.publicUpstreamImageModels).toEqual(["pollinations/flux", "pollinations/turbo"]);

    delete process.env.PUBLIC_UPSTREAM_IMAGE_MODELS;
    expect(loadConfig().publicUpstreamImageModels).toEqual(["pollinations/flux", "pollinations/turbo", "pollinations/zimage"]);
  });

  test("rejects an unallowlisted public upstream host", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.PUBLIC_UPSTREAM_BASE_URL = "https://evil.example/v1";
    expect(() => loadConfig()).toThrow(/not in PUBLIC_UPSTREAM_ALLOWED_HOSTS/);
  });

  test("parses body and concurrency limits from environment", () => {
    process.env.AUTH_TOKENS = "tok";
    process.env.MAX_BODY_SIZE = "8MiB";
    process.env.MAX_CONCURRENT_REQUESTS = "7";
    const cfg = loadConfig();
    expect(cfg.maxBodyBytes).toBe(8 * 1024 * 1024);
    expect(cfg.maxConcurrentRequests).toBe(7);
  });
});
