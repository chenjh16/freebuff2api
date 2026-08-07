#!/usr/bin/env node
/**
 * 官方 freebuff CLI 最小对话探针（调试工具）
 *
 * 在没有可用 TTY 的执行器（Daytona/tmux 助手不可用）中，用
 * `script`（util-linux）伪造 PTY 驱动官方 CLI 的 TUI，发送一条最小消息，
 * 并在可选的 TLS MITM 代理下运行，以便抓取 CLI 的全部请求。
 *
 * 用法：
 *   node tools/cli-probe.mjs --model deepseek/deepseek-v4-flash
 *       --model <model>   目标模型（会读取/校验 ~/.config/manicode/settings.json）
 *       --mitm            同时启动 tools/mitm-ssl-proxy.mjs 并让 CLI 走代理
 *       --out <path>      输出文件前缀（默认 /tmp/cli-probe-<model>）
 *       --msg-time <ms>   发送消息的延迟（默认 45_000，等 TUI 就绪）
 *       --wait <ms>       等待回复的最长时间（默认 150_000）
 *
 * 产物：
 *   <out>.tui.log     CLI TUI 原始输出（含 ANSI）
 *   <out>.mitm.log    MITM 抓包日志（若 --mitm）
 *   stdout 摘要       关键请求序列 + 会话/模型信息
 *
 * 注意：会真实消耗免费 chat 额度；只用于调试自己的账号。
 */
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MITM_PORT = 18100;

function parseArgs(argv) {
  const args = { model: null, mitm: false, out: null, msgTime: 45_000, wait: 150_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.model = argv[++i];
    else if (a === "--mitm") args.mitm = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--msg-time") args.msgTime = Number(argv[++i]);
    else if (a === "--wait") args.wait = Number(argv[++i]);
  }
  return args;
}

function sanitize(buf) {
  return buf.toString("utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][0-9]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.model) {
    console.error("usage: node tools/cli-probe.mjs --model <model> [--mitm] [--out <prefix>] [--msg-time <ms>] [--wait <ms>]");
    process.exit(1);
  }
  const prefix = args.out ?? `/tmp/cli-probe-${args.model.replaceAll("/", "-")}`;
  const tuiLog = `${prefix}.tui.log`;
  const mitmLog = `${prefix}.mitm.log`;

  // 校验/提示 settings.json 的 freebuffModel（不修改；模型由调用方预置）
  try {
    const settingsPath = join(homedir(), ".config", "manicode", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (settings.freebuffModel !== args.model) {
      console.warn(`WARN: ~/.config/manicode/settings.json freebuffModel is "${settings.freebuffModel}", not "${args.model}". The TUI may use the configured model instead.`);
    }
  } catch {}

  let mitm = null;
  if (args.mitm) {
    try { execSync("pkill -f mitm-ssl-proxy", { stdio: "ignore" }); } catch { /* no matches */ }
    try { execSync("rm -f /tmp/fb-ca.crt /tmp/fb-ca.key", { stdio: "ignore" }); } catch {}
    mitm = spawn("node", ["tools/mitm-ssl-proxy.mjs"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    mitm.stdout.on("data", (d) => writeFileSync(mitmLog, d, { flag: "a" }));
    mitm.stderr.on("data", (d) => writeFileSync(mitmLog, d, { flag: "a" }));
    await sleep(4_000); // 等 CA 生成 + 监听
  }

  const env = {
    ...process.env,
    HTTPS_PROXY: args.mitm ? `http://127.0.0.1:${MITM_PORT}` : undefined,
    SSL_CERT_FILE: args.mitm ? "/tmp/fb-ca.crt" : undefined,
    COLUMNS: "120",
    LINES: "40",
    TERM: "xterm-256color",
  };
  for (const k of ["HTTPS_PROXY", "SSL_CERT_FILE"]) if (!env[k]) delete env[k];

  // script 分配 PTY 后先用 stty 设置尺寸，再启动 freebuff TUI
  const child = spawn("script", ["-q", "-c", "stty rows 40 cols 120 && freebuff", "/dev/null"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let raw = Buffer.alloc(0);

  const appendTui = (d) => writeFileSync(tuiLog, d, { flag: "a" });
  child.stdout.on("data", (d) => {
    raw = Buffer.concat([raw, d]);
    appendTui(d);
  });
  child.stderr.on("data", (d) => {
    appendTui(d);
  });

  const start = Date.now();
  const send = async (text) => {
    // 模拟逐字符键入，最后回车（\r）
    for (const ch of text) {
      if (!child.stdin.writable) return;
      child.stdin.write(ch);
      await sleep(15);
    }
    child.stdin.write("\r");
  };

  // 1) 等待 TUI 就绪后发送消息
  await sleep(args.msgTime);
  const snapshot = () => sanitize(raw).split("\n").filter((l) => l.trim()).slice(-14).join("\n");
  console.log(`[t=${Math.round((Date.now() - start) / 1000)}s] TUI snapshot before send:\n${snapshot()}`);

  // 1a) 若打开的是模型选择器（首次启动的 landing），先按 Enter 选中
  //     当前高亮模型（光标 › 所在项），再等待进入对话输入框。
  if (/Start coding for free|RECOMMENDED|UNLIMITED/.test(sanitize(raw)) && /›/.test(sanitize(raw))) {
    console.log(`[t=${Math.round((Date.now() - start) / 1000)}s] model picker detected; pressing Enter to select...`);
    try { child.stdin.write("\r"); } catch {}
    await sleep(8_000);
    console.log(`[t=${Math.round((Date.now() - start) / 1000)}s] after picker:\n${snapshot()}`);
  }

  console.log(`[t=${Math.round((Date.now() - start) / 1000)}s] sending message to TUI...`);
  await send("Reply with exactly: MODEL_PROBE_OK");
  await sleep(6_000);
  console.log(`[t=${Math.round((Date.now() - start) / 1000)}s] after send:\n${snapshot()}`);

  // 2) 等待回复：优先等 MITM 日志中出现 chat 请求且其响应完成；
  //    无 MITM 时退化为在 TUI 输出中找结束标记。
  const deadline = Date.now() + args.wait;
  let replied = false;
  while (Date.now() < deadline) {
    if (mitm) {
      // 找最后一个 chat 请求的位置，之后必须出现响应结束标记
      let log = "";
      try { log = readFileSync(mitmLog, "utf8"); } catch {}
      const chatIdx = log.lastIndexOf("/api/v1/chat/completions");
      const endIdx = log.lastIndexOf("===== END RESPONSE =====");
      if (chatIdx !== -1 && endIdx > chatIdx) { replied = true; break; }
    } else {
      const text = sanitize(raw);
      if (/\[response completed\]|MODEL_PROBE_OK\s*\n?\s*(⎘|▋|\u2713)/.test(text)) { replied = true; break; }
    }
    if (/Another instance of freebuff has taken over|Please log in/.test(sanitize(raw))) break;
    await sleep(2_000);
  }
  const elapsed = Math.round((Date.now() - start) / 1000);
  if (replied && mitm) {
    console.log(`[t=${elapsed}s] chat response completed; waiting for TUI render...`);
    await sleep(10_000); // 让 TUI 渲染完回复再退出
  }

  // 3) 退出 TUI（Ctrl+C，然后等待）
  try { child.stdin.write("\x03"); } catch {}
  await sleep(3_000);
  try { child.stdin.write("\x03"); } catch {}
  await sleep(1_000);
  child.kill("SIGKILL");

  const summary = sanitize(raw).split("\n").filter((l) => l.trim()).slice(-25).join("\n");
  console.log(`[t=${elapsed}s] CLI finished. replied=${replied}`);
  console.log("=== TUI output tail (sanitized) ===");
  console.log(summary.slice(-1500));

  if (mitm) {
    await sleep(500);
    mitm.kill("SIGKILL");
    console.log("=== MITM requests ===");
    const log = readFileSync(mitmLog, "utf8");
    const paths = [...log.matchAll(/(?:POST|GET|DELETE) (\/[^ ]+)/g)].map((m) => m[1]);
    console.log(paths.join("\n"));
  }
  console.log(`tui log: ${tuiLog}${args.mitm ? `, mitm log: ${mitmLog}` : ""}`);
  process.exit(replied ? 0 : 1);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
