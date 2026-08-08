/**
 * Fixed, explicitly allowlisted public/no-auth upstreams.
 *
 * This module deliberately does not implement arbitrary proxy URLs, cookie
 * replay, OAuth harvesting, or shared/static credentials. Every provider owns
 * its outbound headers and only receives the downstream JSON body. The router
 * exposes one aggregated model catalog and retries only transient provider
 * failures before the handler falls back to authenticated Freebuff.
 */

import { randomUUID } from "node:crypto";
import { UpstreamError } from "./upstream.ts";

export const DEFAULT_PUBLIC_UPSTREAM_BASE_URL = "https://opencode.ai/zen/v1";
export const DEFAULT_POLLINATIONS_UPSTREAM_BASE_URL = "https://gen.pollinations.ai/v1";
export const DEFAULT_FELO_UPSTREAM_BASE_URL = "https://felo.ai";

export const DEFAULT_OPENCODE_MODELS = [
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
] as const;

/**
 * Pollinations models documented by OmniRoute as callable without a key.
 * Premium/optional-key models are intentionally excluded: a 401 from those
 * models must not make this proxy advertise an unusable anonymous route.
 */
export const DEFAULT_POLLINATIONS_MODELS = [
  "openai",
  "openai-fast",
  "openai-large",
  "qwen-coder",
  "mistral",
  "gemini-flash-lite-3.1",
  "deepseek",
  "grok",
  "perplexity-fast",
  "perplexity-reasoning",
] as const;

/** Felo's reverse-engineered, no-credential model/category aliases. */
export const DEFAULT_FELO_MODELS = [
  "felo-chat",
  "felo-search",
  "felo-scholar",
  "felo-social",
  "felo-document",
] as const;

/**
 * Canonical public model IDs. OpenCode keeps its historical bare IDs for
 * compatibility; additional providers are namespaced to avoid collisions.
 */
export const DEFAULT_PUBLIC_UPSTREAM_MODELS = [
  ...DEFAULT_OPENCODE_MODELS,
  ...DEFAULT_POLLINATIONS_MODELS.map((model) => `pollinations/${model}`),
  ...DEFAULT_FELO_MODELS.map((model) => `felo/${model}`),
] as const;

export const DEFAULT_PUBLIC_UPSTREAM_ALLOWED_HOSTS = ["opencode.ai", "gen.pollinations.ai", "felo.ai"] as const;
export const DEFAULT_PUBLIC_UPSTREAM_PROVIDERS = ["opencode", "pollinations", "felo"] as const;

export type PublicUpstreamProviderId = "opencode" | "pollinations" | "felo";

export interface PublicUpstreamClientOptions {
  baseURL: string;
  models: string[];
  timeoutMs: number;
  providerId?: "opencode" | "pollinations";
  allowedHosts?: string[];
  /** Only tests may use local HTTP endpoints. Production config rejects them. */
  allowInsecureHttp?: boolean;
  fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

function copyResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function modelWithoutProviderPrefix(model: string, providerId: string): string {
  const prefix = `${providerId}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/** OpenAI-compatible public client for OpenCode and Pollinations. */
export class PublicUpstreamClient {
  readonly baseURL: string;
  readonly providerId: "opencode" | "pollinations";
  private readonly modelsSet: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: PublicUpstreamClientOptions) {
    this.providerId = options.providerId ?? "opencode";
    const defaultHosts = this.providerId === "pollinations" ? ["gen.pollinations.ai"] : ["opencode.ai"];
    const parsed = validatePublicUpstreamURL(
      options.baseURL,
      options.allowedHosts ?? defaultHosts,
      options.allowInsecureHttp ?? false,
    );
    this.baseURL = parsed.toString().replace(/\/+$/, "");
    this.modelsSet = new Set(options.models.map((model) => model.trim()).filter(Boolean));
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  models(): string[] {
    return [...this.modelsSet];
  }

  hasModel(model: string): boolean {
    if (this.providerId === "opencode") return this.modelsSet.has(model);
    // Namespaced providers must stay strict. Bare `openai` must not silently
    // route to Pollinations (or collide with a Freebuff/OpenCode model).
    return model.startsWith(`${this.providerId}/`) && this.modelsSet.has(model);
  }

  async chatCompletions(body: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let outboundBody = body;
    if (this.providerId === "pollinations") {
      try {
        const payload = JSON.parse(body) as Record<string, unknown>;
        if (typeof payload.model === "string") payload.model = modelWithoutProviderPrefix(payload.model, "pollinations");
        outboundBody = JSON.stringify(payload);
      } catch {
        // The shared handler validates JSON before reaching this client.
      }
    }
    try {
      // Never merge inbound headers. No downstream API key, cookie, or
      // Freebuff account token may reach a public provider.
      return await this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "*/*" },
        body: outboundBody,
        signal: requestSignal,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new UpstreamError(`${this.providerId} public upstream request timed out after ${this.timeoutMs}ms`, 0);
      }
      throw error;
    }
  }
}

const FELO_MODEL_CATEGORIES: Record<string, string> = {
  "felo-chat": "chat",
  "felo-search": "google",
  "felo-scholar": "scholar",
  "felo-social": "social",
  "felo-document": "document",
};

function feloModel(model: string): string {
  const raw = model.startsWith("felo/") ? model.slice("felo/".length) : model;
  return Object.prototype.hasOwnProperty.call(FELO_MODEL_CATEGORIES, raw) ? raw : "felo-chat";
}

function feloPrompt(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser) return "";
  if (typeof lastUser.content === "string") return lastUser.content;
  if (!Array.isArray(lastUser.content)) return "";
  return lastUser.content
    .map((part) => (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, string>).text : ""))
    .filter(Boolean)
    .join("\n");
}

function feloThreadPayload(model: string, prompt: string): Record<string, unknown> {
  const id = randomUUID();
  return {
    query: prompt,
    search_uuid: id,
    lang: "",
    agent_lang: "en",
    search_options: { langcode: "en-US" },
    search_video: true,
    query_from: "default",
    category: FELO_MODEL_CATEGORIES[feloModel(model)],
    model: "",
    auto_routing: true,
    mode: "concise",
    device_id: randomUUID().replaceAll("-", ""),
    source_message_rid: "",
    documents: [],
    document_action: "",
    slides_source: { type: "ask_question", files: {} },
    slide_template_uid: "",
    selected_resource_ids: [],
    process_id: id,
    stream_protocol: "message_center_v1",
    enable_task_state: true,
  };
}

function feloStreamUrl(streamKey: string): string {
  return `${DEFAULT_FELO_UPSTREAM_BASE_URL}/api/message/v1/stream/${encodeURIComponent(streamKey)}?offset=0`;
}

function parseFeloLine(line: string, previous: string): { text: string; next: string } {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:{")) return { text: "", next: previous };
  try {
    const outer = JSON.parse(trimmed.slice(5)) as { content?: unknown };
    if (typeof outer.content !== "string") return { text: "", next: previous };
    const content = JSON.parse(outer.content) as { data?: { type?: string; data?: { text?: unknown } } };
    const snapshot = content.data?.type === "answer" && typeof content.data.data?.text === "string" ? content.data.data.text : null;
    if (snapshot === null) return { text: "", next: previous };
    return snapshot.startsWith(previous) ? { text: snapshot.slice(previous.length), next: snapshot } : { text: snapshot, next: snapshot };
  } catch {
    return { text: "", next: previous };
  }
}

function feloSse(response: Response): Response {
  if (!response.body) return new Response(JSON.stringify({ error: { message: "Felo returned no stream body" } }), { status: 502, headers: { "Content-Type": "application/json" } });
  let previous = "";
  let buffer = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const transformed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseFeloLine(line, previous);
        previous = parsed.next;
        if (parsed.text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: parsed.text } }] })}\n\n`));
      }
    },
    flush(controller) {
      if (buffer) {
        const parsed = parseFeloLine(buffer, previous);
        previous = parsed.next;
        if (parsed.text) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: parsed.text } }] })}\n\n`));
        }
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  }));
  return new Response(transformed, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

/** Felo is no-auth but not OpenAI-compatible; this adapter translates its web SSE protocol. */
export class FeloPublicUpstreamClient {
  readonly providerId = "felo" as const;
  private readonly modelsSet: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: { models: string[]; timeoutMs: number; fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }) {
    validatePublicUpstreamURL(DEFAULT_FELO_UPSTREAM_BASE_URL, ["felo.ai"]);
    this.modelsSet = new Set(options.models);
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  models(): string[] { return [...this.modelsSet]; }
  hasModel(model: string): boolean {
    // Keep Felo's public namespace mandatory so `felo-chat` cannot collide
    // with another provider's model id.
    return model.startsWith("felo/") && this.modelsSet.has(model);
  }

  async chatCompletions(body: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const payload = JSON.parse(body) as Record<string, unknown>;
    const prompt = feloPrompt(payload);
    if (!prompt) return new Response(JSON.stringify({ error: { message: "Felo requires a user message" } }), { status: 400, headers: { "Content-Type": "application/json" } });
    const headers = {
      Accept: "*/*",
      "Content-Type": "application/json",
      Origin: DEFAULT_FELO_UPSTREAM_BASE_URL,
      Referer: `${DEFAULT_FELO_UPSTREAM_BASE_URL}/search?q=hello`,
      "User-Agent": "Mozilla/5.0 (compatible; freebuff2api public adapter)",
    };
    const thread = await this.fetchFn(`${DEFAULT_FELO_UPSTREAM_BASE_URL}/api-proxy/main/search/threads`, {
      method: "POST", headers, body: JSON.stringify(feloThreadPayload(typeof payload.model === "string" ? payload.model : "felo-chat", prompt)), signal: requestSignal,
    });
    if (!thread.ok) return thread;
    const threadBody = await thread.json().catch(() => null) as { stream_key?: unknown } | null;
    if (typeof threadBody?.stream_key !== "string" || !threadBody.stream_key) return new Response(JSON.stringify({ error: { message: "Felo did not return a stream key" } }), { status: 502, headers: { "Content-Type": "application/json" } });
    const stream = await this.fetchFn(feloStreamUrl(threadBody.stream_key), {
      method: "GET", headers: { Accept: "*/*", Origin: DEFAULT_FELO_UPSTREAM_BASE_URL, Referer: headers.Referer, "User-Agent": headers["User-Agent"] }, signal: requestSignal,
    });
    if (!stream.ok) return stream;
    if (payload.stream !== false) return feloSse(stream);
    const raw = await stream.text();
    let previous = "";
    for (const line of raw.split("\n")) previous = parseFeloLine(line, previous).next;
    return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: previous }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
}

export interface PublicUpstreamRouterLike {
  models(): string[];
  hasModel(model: string): boolean;
  chatCompletions(body: string, signal?: AbortSignal): Promise<Response>;
}

/**
 * Aggregates fixed public providers. A transient failure is tried against a
 * second matching provider (if configured); the final transient response is
 * returned so the shared handler can fall back to Freebuff with its normal
 * error classification.
 */
export class PublicUpstreamRouter implements PublicUpstreamRouterLike {
  constructor(private readonly clients: PublicUpstreamRouterLike[]) {}
  models(): string[] { return [...new Set(this.clients.flatMap((client) => client.models()))]; }
  hasModel(model: string): boolean { return this.clients.some((client) => client.hasModel(model)); }

  async chatCompletions(body: string, signal?: AbortSignal): Promise<Response> {
    let lastResponse: Response | null = null;
    let lastError: unknown = null;
    for (const client of this.clients) {
      if (!client.hasModel(readModel(body))) continue;
      try {
        const response = await client.chatCompletions(body, signal);
        if (!isPublicUpstreamFallbackStatus(response.status)) return response;
        const text = await response.text().catch(() => "");
        lastResponse = copyResponse(response, text);
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    if (lastResponse) return lastResponse;
    if (lastError) throw lastError;
    throw new UpstreamError("no configured public upstream supports the requested model", 404);
  }
}

function readModel(body: string): string {
  try {
    const model = (JSON.parse(body) as { model?: unknown }).model;
    return typeof model === "string" ? model.trim() : "";
  } catch {
    return "";
  }
}

export function createPublicUpstreamRouter(options: {
  providers: string[];
  models: string[];
  timeoutMs: number;
  baseURL?: string;
}): PublicUpstreamRouter {
  const configuredModels = new Set(options.models);
  const includes = (provider: PublicUpstreamProviderId, model: string): boolean => {
    const canonical = provider === "opencode" ? model : `${provider}/${model}`;
    return configuredModels.has(canonical);
  };
  const clients: PublicUpstreamRouterLike[] = [];
  for (const provider of options.providers) {
    if (provider === "opencode") {
      const models = DEFAULT_OPENCODE_MODELS.filter((model) => includes("opencode", model));
      if (models.length) clients.push(new PublicUpstreamClient({ baseURL: options.baseURL ?? DEFAULT_PUBLIC_UPSTREAM_BASE_URL, models: models as string[], timeoutMs: options.timeoutMs, providerId: "opencode" }));
    } else if (provider === "pollinations") {
      const models = DEFAULT_POLLINATIONS_MODELS
        .filter((model) => includes("pollinations", model))
        .map((model) => `pollinations/${model}`);
      if (models.length) clients.push(new PublicUpstreamClient({ baseURL: DEFAULT_POLLINATIONS_UPSTREAM_BASE_URL, models, timeoutMs: options.timeoutMs, providerId: "pollinations" }));
    } else if (provider === "felo") {
      const models = DEFAULT_FELO_MODELS
        .filter((model) => includes("felo", model))
        .map((model) => `felo/${model}`);
      if (models.length) clients.push(new FeloPublicUpstreamClient({ models, timeoutMs: options.timeoutMs }));
    }
  }
  return new PublicUpstreamRouter(clients);
}

export function validatePublicUpstreamURL(raw: string, allowedHosts: string[], allowInsecureHttp = false): URL {
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { throw new Error("PUBLIC_UPSTREAM_BASE_URL must be a valid URL"); }
  const host = parsed.hostname.toLowerCase();
  const allowed = new Set(allowedHosts.map((item) => item.trim().toLowerCase()).filter(Boolean));
  if (!allowed.has(host)) throw new Error(`PUBLIC_UPSTREAM_BASE_URL host ${host} is not in PUBLIC_UPSTREAM_ALLOWED_HOSTS`);
  if (parsed.protocol !== "https:" && !(allowInsecureHttp && parsed.protocol === "http:")) throw new Error("PUBLIC_UPSTREAM_BASE_URL must use https");
  if (parsed.username || parsed.password) throw new Error("PUBLIC_UPSTREAM_BASE_URL must not contain userinfo");
  parsed.hash = "";
  parsed.search = "";
  return parsed;
}

/** Statuses where retrying another public provider or authenticated Freebuff is safe. */
export function isPublicUpstreamFallbackStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}
