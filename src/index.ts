#!/usr/bin/env bun
/**
 * freebuff2api — OpenAI-compatible reverse proxy for the Freebuff coding API.
 *
 * Usage:
 *   freebuff2api                start the proxy server
 *   freebuff2api login          device-code login (prints a URL to open in your browser)
 *   freebuff2api login --resume continue a previous interrupted login
 *   freebuff2api login --force  start a fresh login, ignoring saved credentials
 *   freebuff2api --help         show help
 *
 * Configuration: an auth token is required (see config.ts / config.example.json);
 * run "freebuff2api login" or set AUTH_TOKENS.
 */

import { loadConfig } from "./config.ts";
import { ModelRegistry } from "./models.ts";
import { RunManager } from "./runs.ts";
import { Server } from "./server.ts";
import { TokenManager } from "./session.ts";
import { UpstreamClient } from "./upstream.ts";
import { LoginError, runLoginCommand } from "./login.ts";

function log(message: string): void {
  console.log(`[freebuff2api] ${message}`);
}

function printUsage(): void {
  console.log(`freebuff2api — OpenAI-compatible reverse proxy for the Freebuff coding API

Usage:
  freebuff2api                start the proxy server
  freebuff2api login          device-code login; prints a URL to open in your browser
  freebuff2api login --resume continue a previous interrupted login
  freebuff2api login --force  ignore saved credentials and start a fresh login
  freebuff2api --help         show this help

Environment:
  AUTH_TOKENS                 freebuff auth token(s), comma-separated
                              (AUTH_TOKENS > config.json > saved login credentials)
  UPSTREAM_BASE_URL           freebuff backend base URL (default https://www.codebuff.com)
  LOGIN_BASE_URL              base URL used by "login" (default https://freebuff.com)
  LISTEN_ADDR                 listen address (default :8080; PORT wins in managed workspaces)
  REQUEST_TIMEOUT             upstream request timeout, e.g. 15m (default 15m)
  ROTATION_INTERVAL           agent run rotation interval, e.g. 6h (default 6h)
  API_KEYS                    optional keys clients must present to this proxy
  HTTP_PROXY                  optional upstream HTTP(S) proxy`);
}

async function runLogin(args: string[]): Promise<void> {
  const force = args.includes("--force");
  const resume = args.includes("--resume");
  let cfg;
  try {
    cfg = loadConfig({ requireToken: false });
  } catch (error) {
    console.error(`[freebuff2api] configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  try {
    await runLoginCommand({
      baseURL: cfg.loginBaseURL,
      force,
      resume,
      log: (message) => console.log(message),
    });
  } catch (error) {
    console.error(error instanceof LoginError ? `[login] ${error.message}` : `[login] ${String(error)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    printUsage();
    return;
  }
  if (args[0] === "login") {
    await runLogin(args.slice(1));
    return;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (error) {
    console.error(`[freebuff2api] configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const client = new UpstreamClient({
    baseURL: cfg.upstreamBaseURL,
    requestTimeoutMs: cfg.requestTimeoutMs,
    userAgent: cfg.userAgent,
    actingUserId: cfg.actingUserId,
  });

  const registry = new ModelRegistry(fetch, log);
  await registry.start();

  const tokens = new TokenManager(cfg.authTokens, client, log);
  const runs = new RunManager(client, cfg.rotationIntervalMs, log);
  const server = new Server({ cfg, client, registry, tokens, runs, log });

  log(`upstream: ${cfg.upstreamBaseURL}`);
  log(`tokens: ${cfg.authTokens.length} configured, api keys: ${cfg.apiKeys.length > 0 ? "required" : "open"}`);

  try {
    await server.listen(portFromAddr(cfg.listenAddr));
  } catch (error) {
    console.error(`[freebuff2api] failed to listen: ${String(error)}`);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down…`);
    const timeout = setTimeout(() => process.exit(0), 10_000);
    timeout.unref?.();
    try {
      await server.close();
      await runs.finishAll();
      await tokens.endAll();
    } catch (error) {
      log(`shutdown error: ${String(error)}`);
    } finally {
      registry.stop();
      log("shutdown complete");
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function portFromAddr(addr: string): number {
  const idx = addr.lastIndexOf(":");
  const port = Number.parseInt(addr.slice(idx + 1), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8080;
}

void main();
