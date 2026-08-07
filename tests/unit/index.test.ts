import { describe, expect, test } from "bun:test";

import { parseArgs, portFromAddr } from "../../src/index.ts";

describe("CLI parsing", () => {
  test("uses serve mode and parses server overrides", () => {
    expect(parseArgs([
      "--listen-addr", "127.0.0.1:9000",
      "--port", "9001",
      "--http-proxy", "http://127.0.0.1:7890",
      "--max-body-size", "8MiB",
      "--max-concurrent", "4",
      "--config", "/tmp/freebuff2api.json",
    ])).toMatchObject({
      command: "serve",
      listenAddr: "127.0.0.1:9000",
      port: "9001",
      httpProxy: "http://127.0.0.1:7890",
      maxBodySize: "8MiB",
      maxConcurrentRequests: "4",
      configPath: "/tmp/freebuff2api.json",
    });
  });

  test("parses login flags", () => {
    expect(parseArgs(["login", "--force"])).toMatchObject({ command: "login", force: true });
    expect(parseArgs(["login", "--resume"])).toMatchObject({ command: "login", resume: true });
  });

  test("rejects missing option values and unknown options", () => {
    expect(() => parseArgs(["--port"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--not-a-real-option"])).toThrow(/unknown option/);
  });
});

describe("listen port fallback", () => {
  test("defaults invalid or empty values to 23333", () => {
    expect(portFromAddr(":23333")).toBe(23333);
    expect(portFromAddr("")).toBe(23333);
    expect(portFromAddr(":0")).toBe(23333);
    expect(portFromAddr(":70000")).toBe(23333);
  });

  test("extracts valid ports from host:port forms", () => {
    expect(portFromAddr("127.0.0.1:9000")).toBe(9000);
    expect(portFromAddr("9001")).toBe(9001);
  });
});
