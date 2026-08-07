"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Health {
  ok: boolean;
  configured?: boolean;
  upstream?: string;
  user_agent?: string;
  acting_user_id?: string | null;
  models?: { source: string; agentCount: number; modelCount: number };
  error?: string;
}

const CURL_SNIPPET = `curl https://freebuff2api.freebuff.app/v1/chat/completions \\
  -H "Authorization: Bearer sk-freebuff2api-2026" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "stream": true,
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'`;

export default function Home() {
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("freebuff2api-key") ?? "";
  });
  const [health, setHealth] = useState<Health | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [hint, setHint] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const [model, setModel] = useState("deepseek/deepseek-v4-flash");
  const [prompt, setPrompt] = useState("Explain the freebuff2api request flow in one short paragraph.");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [outputError, setOutputError] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const authHeaders = useCallback(
    (): Record<string, string> => (apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
    [apiKey],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    setHint("");
    try {
      const [healthResp, modelsResp] = await Promise.all([
        fetch("/healthz", { headers: authHeaders() }),
        fetch("/v1/models", { headers: authHeaders() }),
      ]);
      const h = (await healthResp.json().catch(() => null)) as Health | null;
      setHealth(h);
      if (healthResp.status === 401 || modelsResp.status === 401) {
        setHint("This endpoint requires an API key — paste sk-freebuff2api-2026 above.");
      } else if (h && h.configured === false) {
        setHint("The proxy is live but not yet configured: the deploy needs AUTH_TOKENS set (server-side).");
      }
      if (modelsResp.ok) {
        const body = (await modelsResp.json().catch(() => null)) as { data?: { id: string }[] } | null;
        const ids = body?.data?.map((m) => m.id) ?? [];
        setModels(ids);
        if (ids.length > 0 && !ids.includes(model)) setModel(ids[0]);
      }
    } catch {
      setHealth({ ok: false });
      setHint("Could not reach the API from the browser.");
    } finally {
      setBusy(false);
    }
  }, [authHeaders, model]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveKey = () => {
    window.localStorage.setItem("freebuff2api-key", apiKey.trim());
    void refresh();
  };

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(CURL_SNIPPET);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable; ignore.
    }
  };

  const runChat = async () => {
    if (!prompt.trim()) return;
    setRunning(true);
    setOutput("");
    setOutputError(false);
    try {
      const resp = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
        setOutput(body?.error?.message ?? `Request failed with status ${resp.status}`);
        setOutputError(true);
        return;
      }
      if (!resp.body) {
        setOutput("(empty response)");
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data) as {
              choices?: { delta?: { content?: string }; message?: { content?: string } }[];
            };
            const delta =
              chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
            if (delta) {
              text += delta;
              setOutput(text);
              outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
            }
          } catch {
            // Ignore malformed keep-alive frames.
          }
        }
      }
      if (!text) setOutput("(no content in stream)");
    } catch (error) {
      setOutput(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      setOutputError(true);
    } finally {
      setRunning(false);
    }
  };

  const online = health?.ok === true && health?.configured !== false;
  const configured = health?.configured !== false && online;
  const statusLabel = busy
    ? "checking…"
    : health === null
      ? "unreachable"
      : health.configured === false
        ? "live · needs AUTH_TOKENS"
        : online
          ? "live"
          : "live · needs AUTH_TOKENS";

  return (
    <div>
      <div className="mesh" />
      <div className="grid-overlay" />

      <div className="wrap">
        <header className="nav">
          <div className="brand">
            <span className="mark">fb</span>
            freebuff2api
          </div>
          <span className="endpoint-badge">
            <span className={`dot ${busy ? "warn" : online ? "ok" : "warn"}`} />
            freebuff2api.freebuff.app
          </span>
        </header>

        <main>
          <section className="hero">
            <span className="kicker">OpenAI-compatible · Free models · Streaming</span>
            <h1>Freebuff’s free models, behind one OpenAI endpoint.</h1>
            <p className="lede">
              freebuff2api is a thin reverse proxy that speaks the standard{" "}
              <code>/v1/chat/completions</code> protocol and relays requests to the Freebuff
              coding API — session, agent-run and CLI-gate handling included. Point any
              OpenAI-compatible client at it and drive Freebuff’s free agents.
            </p>
            <div className="meta">
              <span className="pill">
                base <b>https://freebuff2api.freebuff.app</b>
              </span>
              <span className="pill">
                auth <b>Bearer sk-freebuff2api-2026</b>
              </span>
              <span className="pill">
                status <b>{statusLabel}</b>
              </span>
            </div>
          </section>

          <div className="code-wrap">
            <button className="copy-btn" onClick={() => void copySnippet()}>
              {copied ? "copied ✓" : "copy"}
            </button>
            <pre className="code">{CURL_SNIPPET}</pre>
          </div>

          {hint && <div className="banner">{hint}</div>}

          <section className="card pad" style={{ marginTop: 26 }}>
            <h2>API console</h2>
            <p className="sub">
              Enter the proxy API key, load the live model list, then try a streaming chat right
              here.
            </p>
            <div className="field">
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="API key — sk-freebuff2api-2026"
                spellCheck={false}
              />
              <button className="btn" onClick={saveKey}>
                Save key
              </button>
              <button className="btn ghost" onClick={() => void refresh()} disabled={busy}>
                {busy ? <span className="spin" /> : null}
                Refresh
              </button>
            </div>
            <div className="row">
              <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)}>
                {models.length === 0 ? (
                  <option value={model}>{model}</option>
                ) : (
                  models.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))
                )}
              </select>
              <button className="btn" onClick={() => void runChat()} disabled={running || !prompt.trim()}>
                {running ? <span className="spin" /> : null}
                {running ? "Streaming…" : "Run chat"}
              </button>
            </div>
            <textarea
              className="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask the model anything…"
              style={{ marginTop: 12 }}
            />
            <div ref={outputRef} className={`output${outputError ? " error" : ""}`}>
              {output || <span className="dim">The streamed reply appears here.</span>}
            </div>
          </section>

          <div className="status-strip">
            <div className="status-cell">
              <div className="k">Upstream</div>
              <div className="v">{health?.upstream ?? "—"}</div>
            </div>
            <div className="status-cell">
              <div className="k">Model registry</div>
              <div className="v">
                {health?.models ? `${health.models.modelCount} models · ${health.models.source}` : "—"}
              </div>
            </div>
            <div className="status-cell">
              <div className="k">Acting user</div>
              <div className="v">{health?.acting_user_id ?? "—"}</div>
            </div>
            <div className="status-cell">
              <div className="k">Endpoint</div>
              <div className="v">/v1</div>
            </div>
          </div>

          <div className="grid-2">
            <section className="card pad">
              <h2>Endpoints</h2>
              <p className="sub">The full OpenAI-compatible surface.</p>
              <div className="ep">
                <span className="method post">POST</span>
                <span className="path">/v1/chat/completions</span>
                <span className="desc">Chat · JSON or SSE stream</span>
              </div>
              <div className="ep">
                <span className="method get">GET</span>
                <span className="path">/v1/models</span>
                <span className="desc">Available free models</span>
              </div>
              <div className="ep">
                <span className="method get">GET</span>
                <span className="path">/healthz</span>
                <span className="desc">Liveness + session state</span>
              </div>
            </section>

            <section className="card pad">
              <h2>Models</h2>
              <p className="sub">
                {models.length > 0
                  ? `${models.length} model${models.length === 1 ? "" : "s"} served by Freebuff free agents`
                  : "Enter the API key and press Refresh to load them."}
              </p>
              <div className="chips">
                {models.length === 0 ? (
                  <div className="empty">
                    No models loaded yet — the list is fetched live from <code>/v1/models</code>.
                  </div>
                ) : (
                  models.map((id) => (
                    <span key={id} className="chip">
                      {id}
                    </span>
                  ))
                )}
              </div>
            </section>
          </div>
        </main>

        <footer>
          <span>
            freebuff2api · MIT ·{" "}
            <a href="https://github.com/chenjh16/freebuff2api" target="_blank" rel="noreferrer">
              github.com/chenjh16/freebuff2api
            </a>
          </span>
          <span>
            docs:{" "}
            <a href="https://github.com/chenjh16/freebuff2api/tree/main/docs" target="_blank" rel="noreferrer">
              docs/
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}
