/**
 * Model registry: keeps the agent → model mapping in sync with the official
 * Freebuff client by fetching `common/src/constants/free-agents.ts` (plus the
 * constant files it imports) from the CodebuffAI/freebuff repository.
 *
 * The upstream file declares sets like:
 *   'base2-free': new Set([ FREEBUFF_MINIMAX_M3_MODEL_ID, ... ])
 * so the parser resolves both string literals and identifier constants,
 * including `namespace.member` aliases (e.g. mimoModels.mimoV25) and chained
 * re-exports (e.g. `export const A = mimoModels.mimoV25`).
 *
 * A curated fallback mapping is used when the remote source is unreachable.
 */

const RAW_SOURCE_URL =
  "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/free-agents.ts";

const CONSTANT_FILES = [
  "freebuff-models.ts",
  "freebuff-model-ids.ts",
  "gemini.ts",
  "anthropic.ts",
  "model-config.ts",
];

const REFRESH_INTERVAL_MS = 6 * 3_600_000; // 6h

// Curated fallback using current model ids from the upstream source
// (verified 2026-08-06). Keeps the proxy usable if the fetch fails.
const FALLBACK_AGENT_MODELS: Record<string, string[]> = {
  "base2-free": [
    "minimax/minimax-m3",
    "openai/gpt-5.6-luna",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "mimo/mimo-v2.5",
  ],
  "base2-free-deepseek": ["deepseek/deepseek-v4-pro"],
  "base2-free-deepseek-flash": ["deepseek/deepseek-v4-flash"],
  "base2-free-mimo": ["mimo/mimo-v2.5"],
  "base2-free-minimax-m3": ["minimax/minimax-m3"],
  "base2-free-luna": ["openai/gpt-5.6-luna"],
  "base2-free-glm": ["z-ai/glm-5.2"],
  "file-picker": ["google/gemini-3.5-flash-lite"],
  "file-picker-max": ["google/gemini-3.5-flash-lite"],
  "file-lister": ["google/gemini-3.5-flash-lite"],
  "researcher-web": ["google/gemini-3.5-flash-lite"],
  "researcher-docs": ["google/gemini-3.5-flash-lite"],
  "basher": ["google/gemini-3.5-flash-lite"],
  "editor-lite": ["minimax/minimax-m3"],
  "code-reviewer-lite": ["minimax/minimax-m3"],
};

export interface ModelRegistryStatus {
  source: "remote" | "fallback";
  updatedAt: string | null;
  agentCount: number;
  modelCount: number;
}

export class ModelRegistry {
  private agentModels = new Map<string, string[]>();
  private modelToAgent = new Map<string, string>();
  private allModels: string[] = [];
  private source: "remote" | "fallback" = "fallback";
  private updatedAt: string | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
    private readonly log: (message: string) => void = console.log,
  ) {}

  async start(): Promise<void> {
    // Serve the curated fallback catalog immediately so /v1/models and model
    // routing work before the first upstream fetch completes (also during
    // hosted cold starts, where buildHandler no longer awaits start()). The
    // remote mapping fully replaces it once the first refresh succeeds.
    this.loadFallback();
    this.timer = setInterval(() => {
      void this.refresh().then((succeeded) => {
        if (!succeeded) this.log("[models] refresh failed; keeping current mapping");
      });
    }, REFRESH_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    const ok = await this.refresh();
    if (!ok) this.log("[models] startup refresh failed; keeping fallback mapping");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  models(): string[] {
    // The catalog exposes the Freebuff namespace only: every registry id is
    // listed as `freebuff/<model>`. Bare registry ids stay internal — they are
    // exactly what the upstream session/run/chat APIs expect — and are never
    // advertised or routable at the proxy surface.
    return [...this.allModels].map((model) => `freebuff/${model}`).sort();
  }

  hasModel(model: string): boolean {
    return this.agentForModel(model) !== undefined;
  }

  /**
   * Only `freebuff/<model>` ids route here; bare registry ids are rejected so
   * every model id at the proxy surface names its provider explicitly.
   */
  agentForModel(model: string): string | undefined {
    if (!model.startsWith("freebuff/")) return undefined;
    return this.modelToAgent.get(model.slice("freebuff/".length));
  }

  /**
   * Resolve a `freebuff/<model>` id to the bare registry id the upstream
   * session/run APIs expect (e.g. `deepseek/deepseek-v4-flash`).
   */
  canonicalModel(model: string): string {
    return this.unprefix(model);
  }

  /**
   * Freebuff models are addressed only as `freebuff/<model>` at the proxy
   * surface. Registry ids may themselves contain slashes (e.g.
   * `deepseek/deepseek-v4-flash`), so only the exact `freebuff/` namespace is
   * stripped.
   */
  private unprefix(model: string): string {
    return model.startsWith("freebuff/") ? model.slice("freebuff/".length) : model;
  }

  agentIds(): string[] {
    return [...this.agentModels.keys()];
  }

  status(): ModelRegistryStatus {
    return {
      source: this.source,
      updatedAt: this.updatedAt,
      agentCount: this.agentModels.size,
      modelCount: this.allModels.length,
    };
  }

  private async refresh(): Promise<boolean> {
    try {
      const files = await Promise.all([
        fetchText(this.fetchFn, RAW_SOURCE_URL),
        ...CONSTANT_FILES.map((file) =>
          fetchText(
            this.fetchFn,
            `https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/${file}`,
          ),
        ),
      ]);
      const agentModels = parseFreeAgents(files[0], files.slice(1).join("\n"));
      if (agentModels.size === 0) {
        this.log("[models] parsed 0 agents from upstream source; using fallback");
        return false;
      }
      const before = new Set(this.allModels);
      this.applyMapping(agentModels, "remote");
      const added = [...this.allModels].filter((model) => !before.has(model));
      const removed = [...before].filter((model) => !this.allModels.includes(model));
      if (added.length > 0 || removed.length > 0) {
        this.log(
          `[models] catalog changed: +${added.length} -${removed.length} (${this.allModels.length} total)` +
            `${added.length > 0 ? ` added: ${added.slice(0, 6).join(", ")}` : ""}` +
            `${removed.length > 0 ? ` removed: ${removed.slice(0, 6).join(", ")}` : ""}`,
        );
      }
      this.log(
        `[models] updated ${agentModels.size} agents, ${this.allModels.length} models: ${this.allModels.slice(0, 12).join(", ")}${this.allModels.length > 12 ? ", …" : ""}`,
      );
      return true;
    } catch (error) {
      this.log(`[models] fetch failed: ${String(error)}`);
      return false;
    }
  }

  private applyMapping(agentModels: Map<string, string[]>, source: "remote" | "fallback"): void {
    // Collect every agent that can serve a model, then prefer the most specific
    // free agent id (e.g. `base2-free-deepseek-flash` over the aggregate
    // `base2-free`) — the official CLI starts the per-model agent for the
    // session's model, and the backend expects that run/agent pairing.
    const agentsByModel = new Map<string, string[]>();
    const allModels = new Set<string>();
    for (const [agent, models] of agentModels) {
      for (const model of models) {
        allModels.add(model);
        const list = agentsByModel.get(model) ?? [];
        if (!list.includes(agent)) list.push(agent);
        agentsByModel.set(model, list);
      }
    }
    const modelToAgent = new Map<string, string>();
    for (const [model, agents] of agentsByModel) {
      // Prefer the per-model free agents (base2-free-*), then longer/more
      // specific ids, then any remaining candidate.
      const freeScore = (id: string) =>
        id.startsWith("base2-free-") ? 2 : id.startsWith("base2-free") ? 1 : 0;
      agents.sort(
        (a, b) =>
          freeScore(b) - freeScore(a) ||
          b.length - a.length ||
          (a < b ? -1 : 1),
      );
      modelToAgent.set(model, agents[0]);
    }
    this.agentModels = agentModels;
    this.modelToAgent = modelToAgent;
    this.allModels = [...allModels].sort();
    this.source = source;
    this.updatedAt = new Date().toISOString();
  }

  private loadFallback(): void {
    this.applyMapping(new Map(Object.entries(FALLBACK_AGENT_MODELS)), "fallback");
    this.log(
      `[models] loaded fallback mapping: ${this.allModels.length} models across ${this.agentModels.size} agents`,
    );
  }
}

async function fetchText(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
): Promise<string> {
  const resp = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`fetch ${url} failed with status ${resp.status}`);
  return resp.text();
}

/** Extract `export const NAME = 'value'` string constants. */
function buildStringConstants(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*'([^']+)'/g;
  for (const match of source.matchAll(re)) map.set(match[1], match[2]);
  return map;
}

/**
 * Extract `export const NAME = { ... }` objects (balanced-brace aware) with
 * their depth-1 `member: 'value'` pairs, for namespace aliases such as
 * `mimoModels.mimoV25`.
 */
function buildObjectAliases(source: string): Map<string, Map<string, string>> {
  const aliases = new Map<string, Map<string, string>>();
  const re = /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*\{/g;
  for (const match of source.matchAll(re)) {
    const start = match.index + match[0].length - 1;
    const end = findBalancedBrace(source, start);
    if (end === -1) continue;
    const body = source.slice(start, end);
    const members = new Map<string, string>();
    const pairRe = /([A-Za-z0-9_]+)\s*:\s*'([^']+)'/g;
    for (const pair of body.matchAll(pairRe)) {
      if (!members.has(pair[1])) members.set(pair[1], pair[2]);
    }
    aliases.set(match[1], members);
  }
  return aliases;
}

/** Extract chained re-exports: `export const NAME = OTHER_IDENT`. */
function buildIdentAliases(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*([A-Za-z_][A-Za-z0-9_.]*)\s*;?\s*$/gm;
  for (const match of source.matchAll(re)) {
    // Skip object/array literals (handled elsewhere) and plain strings.
    if (/^['"[]/.test(match[2])) continue;
    map.set(match[1], match[2]);
  }
  return map;
}

function findBalancedBrace(source: string, openIndex: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

class ConstantResolver {
  private readonly stringConstants: Map<string, string>;
  private readonly objectAliases: Map<string, Map<string, string>>;
  private readonly identAliases: Map<string, string>;

  constructor(constantsSource: string) {
    this.stringConstants = buildStringConstants(constantsSource);
    this.objectAliases = buildObjectAliases(constantsSource);
    this.identAliases = buildIdentAliases(constantsSource);
  }

  resolve(token: string, seen: Set<string> = new Set()): string | null {
    if (seen.has(token)) return null;
    seen.add(token);

    // String literal.
    if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
      return token.slice(1, -1);
    }

    // Namespace member: mimoModels.mimoV25
    const ns = token.split(".");
    if (ns.length === 2) {
      const member = this.objectAliases.get(ns[0])?.get(ns[1]);
      if (member) return member;
    }

    // Direct string constant.
    const direct = this.stringConstants.get(token);
    if (direct !== undefined) return direct;

    // Chained re-export: A = B (B itself or ns.member or another const).
    const alias = this.identAliases.get(token);
    if (alias) return this.resolve(alias, seen);

    return null;
  }
}

/** Parse `'agentId': new Set([ ... ])` blocks from free-agents.ts. */
export function parseFreeAgents(source: string, constantsSource: string): Map<string, string[]> {
  const resolver = new ConstantResolver(constantsSource);
  const result = new Map<string, string[]>();
  const blockRe = /'([^']+)':\s*new\s+Set\(\[([\s\S]*?)\]\)/g;
  for (const match of source.matchAll(blockRe)) {
    const agentId = match[1];
    const models: string[] = [];
    const seen = new Set<string>();
    const tokenRe = /'([^']+)'|([A-Za-z_][A-Za-z0-9_.]*)/g;
    for (const tokenMatch of match[2].matchAll(tokenRe)) {
      // Quoted capture is already the literal model id; identifier capture must
      // be resolved against the constant files.
      const resolved =
        tokenMatch[1] !== undefined ? tokenMatch[1] : resolver.resolve(tokenMatch[2]);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        models.push(resolved);
      }
    }
    if (models.length > 0) result.set(agentId, models);
  }
  return result;
}
