#!/usr/bin/env node
/**
 * TLS 中间人（MITM）代理（调试工具）— 本仓库逆向的核心工具
 *
 * 作用：对 HTTPS 流量做中间人解密，把官方 freebuff CLI 发往
 * https://www.codebuff.com 的每个请求（含 body）打印出来
 * （Authorization / x-freebuff-acting-user-id 自动脱敏），并原样转发。
 *
 * 为什么需要它：freebuff CLI 的会话创建、agent-runs、chat 等请求都是
 * HTTPS。只有看到 CLI 发出的"真实成功请求"，才能逆向出免费模式网关
 * 到底检查什么（最终发现：system 消息中的 CLI 身份短语，见
 * ../docs/zh/04-请求格式破解.md）。
 *
 * 原理：
 *   1. 本地监听 18100 端口，接受 CONNECT 隧道
 *   2. 用本地 CA 为每个目标域名签发临时证书（需要 openssl）
 *   3. CLI 需要信任该 CA（SSL_CERT_FILE）才会接受中间人证书
 *   4. 解密后打印明文请求 → 转发到真实 443 → 打印响应 → 回传
 *
 * 使用（三个终端）：
 *   终端1:  node tools/mitm-ssl-proxy.mjs          # 启动代理
 *   终端2:  export HTTPS_PROXY=http://127.0.0.1:18100
 *           export SSL_CERT_FILE=/tmp/fb-ca.crt     # 信任本地 CA
 *           freebuff                                 # 运行官方 CLI
 *   终端3:  观察终端1打印的请求日志；可配合
 *           node tools/e2e-test.mjs 等脚本做对照实验
 *
 * 依赖：openssl（签发证书用）、Node 18+。
 * 注意：仅供调试自己的账号使用，请勿用于攻击他人流量。
 */
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import { execSync } from "node:child_process";

const PORT = 18100;
const CA_KEY = "/tmp/fb-ca.key";
const CA_CRT = "/tmp/fb-ca.crt";
const MAX_LOG_BODY = 6000;
const certCache = new Map();

// 生成并写入本地 CA（若不存在）
function ensureCA() {
  if (fs.existsSync(CA_KEY) && fs.existsSync(CA_CRT)) return;
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${CA_KEY} -out ${CA_CRT} -days 30 -subj "/CN=freebuff2api-local-ca" 2>/dev/null`);
  console.log(`CA written: ${CA_CRT}`);
}
ensureCA();

function getCert(host) {
  if (certCache.has(host)) return certCache.get(host);
  const key = `/tmp/fbcert-${host}.key`;
  const csr = `/tmp/fbcert-${host}.csr`;
  const crt = `/tmp/fbcert-${host}.crt`;
  const ext = `/tmp/fbcert-${host}.ext`;
  fs.writeFileSync(ext, `subjectAltName=DNS:${host}\n`);
  execSync(
    `openssl req -new -newkey rsa:2048 -nodes -keyout ${key} -out ${csr} -subj "/CN=${host}" 2>/dev/null`
  );
  execSync(
    `openssl x509 -req -in ${csr} -CA ${CA_CRT} -CAkey ${CA_KEY} -CAcreateserial -out ${crt} -days 1 -extfile ${ext} 2>/dev/null`
  );
  const entry = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  certCache.set(host, entry);
  return entry;
}

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (["authorization", "cookie", "x-freebuff-acting-user-id"].includes(lk)) {
      out[k] = v ? `${v.slice(0, 10)}...<redacted>` : v;
    } else out[k] = v;
  }
  return out;
}

function handleHttp(upstreamHost) {
  return (tlsSock) => {
    let buf = Buffer.alloc(0);
    let up = null; // upstream socket while a request is being served
    let respBuf = Buffer.alloc(0);
    let respBodySeen = 0;
    let respContentLength = -1; // -1 unknown
    let respChunked = false;

    function logRequest(req) {
      console.log("\n===== OFFICIAL REQUEST =====");
      console.log(req.head.split("\r\n")[0]);
      console.log(JSON.stringify(redactHeaders(req.headers), null, 2));
      const body = req.bodyBytes.toString("utf8");
      console.log(
        `BODY(${req.contentLength}): ${
          body.length > MAX_LOG_BODY
            ? body.slice(0, MAX_LOG_BODY) + "\n...[truncated]"
            : body
        }`
      );
      console.log("-----");
    }

    function pump() {
      // Called whenever new client bytes arrive or a response completes.
      if (up) return; // a request is in flight upstream; wait for response end

      // Parse next request head.
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString("utf8");
      const headers = {};
      const lines = head.split("\r\n");
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].indexOf(":");
        if (c > 0)
          headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
      }
      const contentLength = parseInt(headers["content-length"] || "0", 10);
      const bodyStart = idx + 4;
      const available = buf.length - bodyStart;
      if (available < contentLength) return; // wait for the full body

      const bodyBytes = buf.slice(bodyStart, bodyStart + contentLength);
      buf = buf.slice(bodyStart + contentLength);
      const req = { head, headers, contentLength, bodyBytes };
      logRequest(req);

      up = tls.connect({
        host: upstreamHost,
        port: 443,
        servername: upstreamHost,
        rejectUnauthorized: true,
      });
      up.on("error", (e) => {
        console.log("UPSTREAM ERR:", e.message);
        tlsSock.destroy();
      });
      up.on("connect", () => {
        up.write(head + "\r\n\r\n");
        if (bodyBytes.length) up.write(bodyBytes);
      });
      up.on("data", (c) => {
        // Always relay immediately.
        tlsSock.write(c);
        respBuf = Buffer.concat([respBuf, c]);
        // Parse response head once.
        if (respContentLength === -1) {
          const ri = respBuf.indexOf("\r\n\r\n");
          if (ri !== -1) {
            const rhead = respBuf.slice(0, ri).toString("utf8");
            console.log("===== RESPONSE =====");
            console.log(rhead.slice(0, 600));
            const mlen = rhead.match(/content-length:\s*(\d+)/i);
            respContentLength = mlen ? parseInt(mlen[1], 10) : 0;
            respChunked = /transfer-encoding:\s*chunked/i.test(rhead);
            respBodySeen = respBuf.length - (ri + 4);
            if (!mlen && !respChunked) respContentLength = 0;
          }
        } else {
          respBodySeen += c.length;
        }
        // Check completeness.
        const done =
          (respContentLength >= 0 && respBodySeen >= respContentLength) ||
          (respChunked && /0\r\n\r\n$/.test(respBuf.toString("utf8")));
        if (done) {
          const ri = respBuf.indexOf("\r\n\r\n");
          if (ri !== -1) {
            const body = respBuf.slice(ri + 4).toString("utf8");
            console.log(`RESP BODY: ${body.slice(0, 600)}`);
          }
          console.log("===== END RESPONSE =====\n");
          respBuf = Buffer.alloc(0);
          respContentLength = -1;
          respChunked = false;
          respBodySeen = 0;
          const served = up;
          up = null;
          served.end();
          // Serve any pipelined/next request already buffered.
          pump();
        }
      });
      up.on("end", () => {
        if (up) {
          console.log("===== UPSTREAM CLOSED =====\n");
          up = null;
          tlsSock.end();
        }
      });
      up.on("close", () => {
        if (up) {
          up = null;
          tlsSock.end();
        }
      });
    }

    tlsSock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      pump();
    });
    tlsSock.on("error", () => {});
  };
}

const server = net.createServer((socket) => {
  socket.once("data", (chunk) => {
    const req = chunk.toString("utf8");
    const m = req.match(/^CONNECT ([^:]+):(\d+) /);
    if (!m) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.end();
      return;
    }
    const host = m[1];
    console.log(`[CONNECT] ${host}:${m[2]}`);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const { key, cert } = getCert(host);
    const tlsSock = new tls.TLSSocket(socket, { isServer: true, key, cert });
    tlsSock.on("secure", () => handleHttp(host)(tlsSock));
    tlsSock.on("error", () => {});
  });
  socket.on("error", () => {});
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`TLS MITM on ${PORT} (CA: ${CA_CRT})`)
);
