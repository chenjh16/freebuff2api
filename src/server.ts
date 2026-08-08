/**
 * OpenAI-compatible HTTP server (node:http adapter).
 *
 *   GET  /healthz               public liveness status
 *   GET  /v1/models             available free models
 *   POST /v1/chat/completions   OpenAI chat completions → Freebuff backend
 *
 * The actual request handling lives in `src/handler.ts` as a web-native
 * `Request → Response` handler, shared with the Next.js route handlers used by
 * the hosted deployment. This class only adapts node:http streams to the Web
 * Request/Response API.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHandler, DEFAULT_MAX_BODY_BYTES, BodyTooLargeError, type HandlerDeps } from "./handler.ts";
import type { Config } from "./config.ts";
import type { ModelRegistry } from "./models.ts";
import type { RunManager } from "./runs.ts";
import type { TokenManager } from "./session.ts";
import type { UpstreamClient } from "./upstream.ts";
import { UpstreamError } from "./upstream.ts";

export interface ServerDeps extends HandlerDeps {
  cfg: Config;
  client: UpstreamClient;
  registry: ModelRegistry;
  tokens: TokenManager;
  runs: RunManager;
  log: (message: string) => void;
}

const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;

export class Server {
  private readonly server = createServer((req, res) => {
    void this.dispatch(req, res);
  });
  private readonly handle: (request: Request) => Promise<Response>;
  private activeRequests = 0;
  private waitingRequests: { resolve: (release: () => void) => void; reject: (error: Error) => void }[] = [];
  private closing = false;
  private readonly maxWaitingRequests = 128;

  constructor(private readonly deps: ServerDeps) {
    this.handle = createHandler(deps);
  }

  listen(port: number, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.removeListener("error", reject);
        this.deps.log(`listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    this.closing = true;
    for (const waiter of this.waitingRequests.splice(0)) {
      waiter.reject(new Error("server is shutting down"));
    }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Return the OS-assigned listening port (mainly useful to test harnesses). */
  listeningPort(): number | null {
    const address = this.server.address();
    return address && typeof address === "object" ? address.port : null;
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let release: () => void;
    try {
      release = await this.acquireRequestSlot();
    } catch (error) {
      // Distinguish a shutdown from an overloaded request queue so clients get
      // an actionable status instead of a misleading "shutting down".
      const queueFull = error instanceof Error && /queue/i.test(error.message);
      writeOpenAIError(
        res,
        503,
        queueFull ? "too many concurrent requests, try again" : "server is shutting down",
        "server_error",
        queueFull ? "request_queue_full" : "server_closing",
      );
      req.resume();
      return;
    }
    const abort = new AbortController();
    try {
      const onAborted = () => abort.abort();
      req.once("aborted", onAborted);
      req.once("close", () => {
        if (!req.complete) abort.abort();
      });
      res.once("close", onAborted);

      const request = await toWebRequest(req, res, this.deps.cfg, abort.signal);
      const response = await this.handle(request);
      await writeResponse(res, response, abort.signal);
    } catch (error) {
      // 413 responses are already written by toWebRequest before it throws;
      // nothing to log or recover from.
      if (error instanceof ResponseSentError) return;
      this.deps.log(`[server] unhandled error: ${String(error)}`);
      if (!res.headersSent) {
        writeOpenAIError(res, 500, "internal server error", "server_error", "");
      } else {
        res.end();
      }
    } finally {
      release();
    }
  }

  private acquireRequestSlot(): Promise<() => void> {
    if (this.closing) return Promise.reject(new Error("server is shutting down"));
    const limit = this.deps.cfg.maxConcurrentRequests || DEFAULT_MAX_CONCURRENT_REQUESTS;
    if (this.activeRequests < limit) {
      this.activeRequests += 1;
      return Promise.resolve(() => this.releaseRequestSlot());
    }
    if (this.waitingRequests.length >= this.maxWaitingRequests) {
      return Promise.reject(new Error("server request queue is full"));
    }
    return new Promise((resolve, reject) => {
      this.waitingRequests.push({
        resolve: (release) => resolve(release),
        reject,
      });
    });
  }

  private releaseRequestSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const next = this.waitingRequests.shift();
    if (next) {
      this.activeRequests += 1;
      next.resolve(() => this.releaseRequestSlot());
    }
  }
}

/** Convert a node:http request into a Web `Request` (body size-limited). */
async function toWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  signal: AbortSignal,
): Promise<Request> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }

  const maxBodyBytes = cfg.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
  const declaredLength = Number.parseInt(req.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    writeOpenAIError(res, 413, `request body exceeds ${maxBodyBytes} bytes`, "invalid_request_error", "body_too_large");
    req.resume();
    throw new ResponseSentError();
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body: string | undefined;
  if (hasBody) {
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        writeOpenAIError(res, 413, `request body exceeds ${maxBodyBytes} bytes`, "invalid_request_error", "body_too_large");
        throw new ResponseSentError();
      }
      throw error;
    }
  }

  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    body: hasBody ? body : undefined,
    signal,
  });
}

/** Write a Web `Response` (status, headers, body — JSON or SSE stream) back to node:http. */
async function writeResponse(res: ServerResponse, response: Response, signal?: AbortSignal): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"].includes(lower)) {
      return;
    }
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const canContinue = res.write(Buffer.from(value));
        if (!canContinue) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onClose = () => {
              cleanup();
              reject(new Error("client disconnected"));
            };
            const cleanup = () => {
              res.off("drain", onDrain);
              res.off("close", onClose);
            };
            res.once("drain", onDrain);
            res.once("close", onClose);
          });
        }
        if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
          (res as unknown as { flush: () => void }).flush();
        }
      }
    }
    res.end();
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      // Client likely disconnected; nothing else to do.
    }
    try {
      res.end();
    } catch {
      // Already closed.
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function writeOpenAIError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  type: string,
  code: string,
): void {
  const error: Record<string, string> = { message: message || "error", type: type || "server_error" };
  if (code) error.code = code;
  const body = JSON.stringify({ error });
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(body);
}

/** Thrown after the adapter has already written an error response (e.g. 413). */
class ResponseSentError extends Error {
  constructor() {
    super("response already sent");
    this.name = "ResponseSentError";
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      req.resume();
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export { UpstreamError };
