/**
 * Optional public/no-auth upstream for models that are explicitly allowlisted.
 *
 * This client intentionally owns the outbound headers. It never forwards the
 * downstream Authorization, x-api-key, Cookie, or Freebuff account token.
 * Fallback is decided by the shared handler before a successful response is
 * returned; a stream that has already started cannot be safely replayed.
 */

import { UpstreamError } from "./upstream.ts";

export const DEFAULT_PUBLIC_UPSTREAM_BASE_URL = "https://opencode.ai/zen/v1";

/**
 * Conservative default: the public endpoint currently exposes many models,
 * but only these explicitly advertised free-tier ids are routed anonymously.
 * Operators can replace the list with PUBLIC_UPSTREAM_MODELS.
 */
export const DEFAULT_PUBLIC_UPSTREAM_MODELS = [
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "ling-3.0-flash-free",
  "ling-3.0-tiny-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
  "longcat-2.0-free",
] as const;

export const DEFAULT_PUBLIC_UPSTREAM_ALLOWED_HOSTS = ["opencode.ai"] as const;

export interface PublicUpstreamClientOptions {
  baseURL: string;
  models: string[];
  timeoutMs: number;
  allowedHosts?: string[];
  /** Only tests may use local HTTP endpoints. Production config rejects them. */
  allowInsecureHttp?: boolean;
  fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export class PublicUpstreamClient {
  readonly baseURL: string;
  private readonly modelsSet: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: PublicUpstreamClientOptions) {
    const parsed = validatePublicUpstreamURL(options.baseURL, options.allowedHosts ?? [...DEFAULT_PUBLIC_UPSTREAM_ALLOWED_HOSTS], options.allowInsecureHttp ?? false);
    this.baseURL = parsed.toString().replace(/\/+$/, "");
    this.modelsSet = new Set(options.models.map((model) => model.trim()).filter(Boolean));
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  models(): string[] {
    return [...this.modelsSet];
  }

  hasModel(model: string): boolean {
    return this.modelsSet.has(model);
  }

  async chatCompletions(body: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      // Do not merge inbound headers here. In particular, no downstream API
      // key, browser cookie, or Freebuff account token may reach this host.
      return await this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
        },
        body,
        signal: requestSignal,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new UpstreamError(`public upstream request timed out after ${this.timeoutMs}ms`, 0);
      }
      throw error;
    }
  }
}

export function validatePublicUpstreamURL(raw: string, allowedHosts: string[], allowInsecureHttp = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("PUBLIC_UPSTREAM_BASE_URL must be a valid URL");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = new Set(allowedHosts.map((item) => item.trim().toLowerCase()).filter(Boolean));
  if (!allowed.has(host)) {
    throw new Error(`PUBLIC_UPSTREAM_BASE_URL host ${host} is not in PUBLIC_UPSTREAM_ALLOWED_HOSTS`);
  }
  if (parsed.protocol !== "https:" && !(allowInsecureHttp && parsed.protocol === "http:")) {
    throw new Error("PUBLIC_UPSTREAM_BASE_URL must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("PUBLIC_UPSTREAM_BASE_URL must not contain userinfo");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed;
}

/** Statuses where retrying the authenticated Freebuff path is safe. */
export function isPublicUpstreamFallbackStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}
