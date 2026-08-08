#!/usr/bin/env bun
/**
 * freebuff2api — OpenAI-compatible reverse proxy for the Freebuff coding API.
 */

import { pathToFileURL } from "node:url";
import { loadConfig, type LoadConfigOptions } from "./config.ts";
import { ModelRegistry } from "./models.ts";
import { RunManager } from "./runs.ts";
import { Server } from "./server.ts";
import { TokenManager } from "./session.ts";
import { UpstreamClient } from "./upstream.ts";
import { createPublicUpstreamRouter } from "./public-upstream.ts";
import { LoginError, runLoginCommand } from "./login.ts";

export interface CLIOptions extends LoadConfigOptions {
  command: "serve" | "login";
  force?: boolean;
  resume?: boolean;
}

function log(message: string): void {
  console.log(`[freebuff2api] ${message}`);
}

export function printUsage(): void {
  console.log(`freebuff2api — OpenAI-compatible reverse proxy for the Freebuff coding API

Usage:
  freebuff2api [options]                 start the proxy server
  freebuff2api login [--resume|--force]  device-code login
  freebuff2api --help                    show this help

Server options (CLI values override config.json and environment values):
  --listen-addr <addr>       listen address (default :23333)
  --port <port>              override only the listen port
  --upstream <url>           Freebuff backend base URL
  --login-base-url <url>     base URL used by login
  --http-proxy <url>         upstream HTTP(S) proxy
  --max-body-size <size>     maximum chat body, e.g. 16MB (default 16MB)
  --max-concurrent <count>   maximum in-flight chats (default 32)
  --config <path>            explicit config.json path

Environment/configuration:
  AUTH_TOKENS, UPSTREAM_BASE_URL, LOGIN_BASE_URL, LISTEN_ADDR, PORT
  REQUEST_TIMEOUT, ROTATION_INTERVAL, API_KEYS, USER_AGENT
  HTTP_PROXY                 proxy precedence: CLI > config.json > environment
  MAX_BODY_SIZE              default 16MB
  MAX_CONCURRENT_REQUESTS    default 32
  PUBLIC_UPSTREAM_ENABLED     default true; set false to disable public providers
  PUBLIC_UPSTREAM_PROVIDERS    comma-separated fixed providers: opencode,pollinations,felo
  PUBLIC_UPSTREAM_MODELS      comma-separated aggregated public model allowlist
  PUBLIC_UPSTREAM_TIMEOUT     default 20s

Examples:
  freebuff2api --port 23333
  freebuff2api --listen-addr 127.0.0.1:9000 --http-proxy http://127.0.0.1:7890
  freebuff2api login --force
`);
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseArgs(args: string[]): CLIOptions {
  const options: CLIOptions = { command: "serve" };
  if (args[0] === "login") {
    options.command = "login";
    args = args.slice(1);
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--force": options.force = true; break;
      case "--resume": options.resume = true; break;
      case "--listen-addr": options.listenAddr = requireValue(args, i++, arg); break;
      case "--port": options.port = requireValue(args, i++, arg); break;
      case "--upstream": options.upstreamBaseURL = requireValue(args, i++, arg); break;
      case "--login-base-url": options.loginBaseURL = requireValue(args, i++, arg); break;
      case "--http-proxy": options.httpProxy = requireValue(args, i++, arg); break;
      case "--max-body-size": options.maxBodySize = requireValue(args, i++, arg); break;
      case "--max-concurrent": options.maxConcurrentRequests = requireValue(args, i++, arg); break;
      case "--config": options.configPath = requireValue(args, i++, arg); break;
      case "--help": case "-h": case "help": break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function applyProxyConfig(proxy: string | null): void {
  // Bun fetch reads these variables for both HTTP and HTTPS destinations.
  // loadConfig has already applied CLI > config.json > environment precedence.
  if (proxy) {
    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;
  }
}

async function runLogin(options: CLIOptions): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig({ ...options, requireToken: false });
  } catch (error) {
    console.error(`[freebuff2api] configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  applyProxyConfig(cfg.httpProxy);
  try {
    await runLoginCommand({
      baseURL: cfg.loginBaseURL,
      force: options.force,
      resume: options.resume,
      log: (message) => console.log(message),
    });
  } catch (error) {
    console.error(error instanceof LoginError ? `[login] ${error.message}` : `[login] ${String(error)}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h") || rawArgs[0] === "help") {
    printUsage();
    return;
  }

  let options: CLIOptions;
  try {
    options = parseArgs(rawArgs);
  } catch (error) {
    console.error(`[freebuff2api] argument error: ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    process.exitCode = 2;
    return;
  }
  if (options.command === "login") {
    await runLogin(options);
    return;
  }

  let cfg;
  try {
    cfg = loadConfig(options);
  } catch (error) {
    console.error(`[freebuff2api] configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  applyProxyConfig(cfg.httpProxy);

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
  const publicUpstream = cfg.publicUpstreamEnabled
    ? createPublicUpstreamRouter({
        providers: cfg.publicUpstreamProviders,
        models: cfg.publicUpstreamModels,
        baseURL: cfg.publicUpstreamBaseURL,
        timeoutMs: cfg.publicUpstreamTimeoutMs,
      })
    : undefined;
  const server = new Server({ cfg, client, publicUpstream, registry, tokens, runs, log });

  log(`upstream: ${cfg.upstreamBaseURL}`);
  log(`tokens: ${cfg.authTokens.length} configured, api keys: ${cfg.apiKeys.length > 0 ? "required" : "open"}`);
  log(`request body limit: ${cfg.maxBodyBytes} bytes; concurrency limit: ${cfg.maxConcurrentRequests}`);
  log(`public upstream: ${cfg.publicUpstreamEnabled ? `${cfg.publicUpstreamProviders.join(",")} (${cfg.publicUpstreamModels.length} allowlisted models)` : "disabled"}`);
  if (cfg.httpProxy) log(`upstream proxy: ${cfg.httpProxy}`);

  const target = listenTarget(cfg.listenAddr);
  try {
    await server.listen(target.port, target.host);
  } catch (error) {
    console.error(`[freebuff2api] failed to listen: ${String(error)}`);
    process.exitCode = 1;
    return;
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

function listenTarget(addr: string): { host: string; port: number } {
  const trimmed = addr.trim() || ":23333";
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { host: "0.0.0.0", port: portFromAddr(trimmed) };
  const host = trimmed.slice(0, idx) || "0.0.0.0";
  return { host, port: portFromAddr(trimmed.slice(idx + 1)) };
}

export function portFromAddr(addr: string): number {
  const port = Number.parseInt(addr.replace(/^.*:/, ""), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 23333;
}

/**
 * Entry guard that works under every supported runtime: Bun (source or
 * bundle), Node ESM (`node dist/index.js`), and Node's type stripping.
 * Unlike `import.meta.main` (Bun-only), it also survives `bun build
 * --target=node`, which rewrites import.meta.main into a CJS-only helper.
 */
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) void main();
