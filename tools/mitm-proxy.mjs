#!/usr/bin/env node
/**
 * HTTP 明文 MITM 代理（调试工具）
 *
 * 作用：本地监听 HTTP 端口，把官方 freebuff CLI 的请求日志打印出来
 * （Authorization / cookie / x-freebuff-acting-user-id 自动脱敏），
 * 然后原样转发到真实后端 https://www.codebuff.com。
 *
 * 用途：把 freebuff CLI 的 HTTP_PROXY 指向本代理，即可观察到 CLI 发出的
 * 每一个请求的完整头与 body（用于逆向上游协议）。
 *
 * 局限：只能看到明文 HTTP 流量。CLI 默认走 HTTPS，请使用
 * tools/mitm-ssl-proxy.mjs（TLS 中间人版本）。
 *
 * 使用：
 *   node tools/mitm-proxy.mjs
 *   # 然后 export HTTP_PROXY=http://127.0.0.1:18099 再运行 freebuff
 */
import http from "node:http";
import https from "node:https";

const UPSTREAM = "https://www.codebuff.com";
const PORT = 18099;

function redact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const lk = k.toLowerCase();
    if (
      lk === "authorization" ||
      lk === "cookie" ||
      lk === "x-freebuff-acting-user-id" ||
      lk === "proxy-authorization"
    ) {
      out[k] = v ? `${v.slice(0, 12)}...<redacted>` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    console.log("\n===== OFFICIAL REQUEST =====");
    console.log(`${req.method} ${req.url}`);
    console.log(JSON.stringify(redact(req.headers), null, 2));
    console.log(`BODY(${body.length}): ${body.toString("utf8").slice(0, 4000)}`);
    console.log("-----");

    const target = new URL(UPSTREAM + req.url);
    const headers = { ...req.headers, host: target.host };
    const preq = https.request(
      {
        method: req.method,
        host: target.hostname,
        path: target.pathname + target.search,
        headers,
      },
      (pres) => {
        console.log("===== RESPONSE =====");
        console.log(`STATUS ${pres.statusCode}`);
        console.log(JSON.stringify(redact(pres.headers), null, 2));
        res.writeHead(pres.statusCode, pres.headers);
        let first = true;
        pres.on("data", (c) => {
          if (first) {
            console.log(`RESP FIRST(${c.length}): ${c.toString("utf8").slice(0, 2000)}`);
            first = false;
          }
          res.write(c);
        });
        pres.on("end", () => {
          console.log("===== END RESPONSE =====\n");
          res.end();
        });
      }
    );
    preq.on("error", (e) => {
      console.log("FORWARD ERROR:", e.message);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mitm_forward_failed", message: e.message }));
    });
    if (body.length) preq.write(body);
    preq.end();
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`MITM listening on ${PORT}, forwarding to ${UPSTREAM}`));
