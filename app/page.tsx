"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types & storage
// ---------------------------------------------------------------------------

interface Session {
  authToken: string;
  apiKey: string;
  user: { id?: string | null; name?: string | null; email?: string | null };
}

interface PendingLogin {
  fingerprintId: string;
  fingerprintHash: string;
  expiresAt: number;
  loginUrl: string;
}

const SESSION_KEY = "freebuff2api_session";
const PENDING_KEY = "freebuff2api_pending";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `codebuff-cli-${Math.random().toString(36).slice(2, 12)}`;
}

function readStored<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable; ignore.
  }
}

function clearStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type ToastKind = "ok" | "err";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

function maskKey(key: string): string {
  if (key.length <= 14) return "•".repeat(key.length);
  return `${key.slice(0, 10)}${"•".repeat(10)}${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [toast, setToast] = useState<{ msg: string; kind: ToastKind } | null>(null);

  // login flow
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");

  // dashboard
  const [revealKey, setRevealKey] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);

  // playground
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [prompt, setPrompt] = useState("Hi");
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState("");
  const [output, setOutput] = useState("");
  const [outputError, setOutputError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, kind: ToastKind = "ok") => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const baseURL = typeof window !== "undefined" ? `${window.location.origin}/v1` : "https://freebuff2api.freebuff.app/v1";

  const authHeaders = useCallback(
    (): Record<string, string> => (session ? { Authorization: `Bearer ${session.apiKey}` } : {}),
    [session],
  );

  const refreshModels = useCallback(async () => {
    if (!session) return;
    try {
      const resp = await fetch("/v1/models", { headers: authHeaders() });
      if (resp.ok) {
        const body = (await resp.json()) as { data?: { id: string }[] };
        const ids = body?.data?.map((m) => m.id) ?? [];
        setModels(ids);
        if (ids.length > 0 && !ids.includes(model)) setModel(ids[0]);
      }
    } catch {
      // Models list is best-effort.
    }
  }, [session, authHeaders, model]);

  const finishRegister = useCallback(
    async (authToken: string) => {
      setLoginBusy(true);
      try {
        const resp = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ authToken }),
        });
        const body = (await resp.json().catch(() => null)) as { apiKey?: string; user?: Session["user"]; error?: string } | null;
        if (!resp.ok || !body?.apiKey) {
          throw new Error(body?.error ?? `register failed (${resp.status})`);
        }
        const next: Session = { authToken, apiKey: body.apiKey, user: body.user ?? { email: null } };
        writeStored(SESSION_KEY, next);
        setSession(next);
        setPending(null);
        setWaiting(false);
        clearStored(PENDING_KEY);
        showToast("Signed in — API key ready");
        void refreshModels();
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : String(error));
        setWaiting(false);
      } finally {
        setLoginBusy(false);
      }
    },
    [refreshModels, showToast],
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(
    async (p: PendingLogin) => {
      try {
        const params = new URLSearchParams({
          fingerprintId: p.fingerprintId,
          fingerprintHash: p.fingerprintHash,
          expiresAt: String(p.expiresAt),
          loginUrl: p.loginUrl,
        });
        const resp = await fetch(`/api/auth/status?${params.toString()}`, { cache: "no-store" });
        const body = (await resp.json().catch(() => null)) as { user?: { authToken?: string } } | null;
        if (resp.ok && body?.user?.authToken) {
          stopPolling();
          void finishRegister(body.user.authToken);
          return true;
        }
        if (p.expiresAt > 0 && Date.now() > p.expiresAt) {
          stopPolling();
          setWaiting(false);
          setLoginError("This login link expired — start a new one.");
          return true;
        }
      } catch {
        // Transient network error; keep polling.
      }
      return false;
    },
    [finishRegister, stopPolling],
  );

  const startLogin = useCallback(async () => {
    setLoginBusy(true);
    setLoginError("");
    try {
      const fingerprintId = uuid();
      const resp = await fetch("/api/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprintId }),
      });
      const body = (await resp.json().catch(() => null)) as { loginUrl?: string; fingerprintHash?: string; expiresAt?: number; error?: string } | null;
      if (!resp.ok || !body?.loginUrl || !body?.fingerprintHash) {
        throw new Error(body?.error ?? `could not start login (${resp.status})`);
      }
      const p: PendingLogin = {
        fingerprintId,
        fingerprintHash: body.fingerprintHash,
        expiresAt: body.expiresAt ?? 0,
        loginUrl: body.loginUrl,
      };
      writeStored(PENDING_KEY, p);
      setPending(p);
      setWaiting(true);
      const win = window.open(p.loginUrl, "_blank");
      if (!win) showToast("Popup blocked — click “Open login page” below", "err");
      stopPolling();
      pollRef.current = setInterval(() => void pollStatus(p), 6000);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoginBusy(false);
    }
  }, [pollStatus, showToast, stopPolling]);

  const resumePending = useCallback(async () => {
    const p = readStored<PendingLogin>(PENDING_KEY);
    if (!p || (p.expiresAt > 0 && Date.now() > p.expiresAt)) return;
    setPending(p);
    setWaiting(true);
    stopPolling();
    pollRef.current = setInterval(() => void pollStatus(p), 6000);
  }, [pollStatus, stopPolling]);

  // Boot: validate a stored session, else restore a pending login, else idle.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = readStored<Session>(SESSION_KEY);
      if (stored?.authToken) {
        try {
          const resp = await fetch("/api/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ authToken: stored.authToken }),
          });
          const body = (await resp.json().catch(() => null)) as { apiKey?: string; user?: Session["user"] } | null;
          if (resp.ok && body?.apiKey) {
            const next: Session = { ...stored, apiKey: body.apiKey, user: body.user ?? stored.user };
            writeStored(SESSION_KEY, next);
            if (!cancelled) setSession(next);
          } else {
            clearStored(SESSION_KEY);
          }
        } catch {
          // Network error — keep the stored session and let the first API
          // call surface any problem.
          if (!cancelled) setSession(stored);
        }
      }
      if (!cancelled) {
        if (!readStored(SESSION_KEY)) await resumePending();
        setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [resumePending, stopPolling]);

  useEffect(() => {
    if (!session) return;
    void refreshModels();
  }, [session, refreshModels]);

  // ---- playground --------------------------------------------------------

  const runChat = useCallback(async () => {
    if (!session || !prompt.trim() || running) return;
    setRunning(true);
    setOutput("");
    setThinking("");
    setOutputError(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const resp = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: prompt }] }),
        signal: controller.signal,
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
              choices?: { delta?: { content?: string; reasoning_content?: string }; message?: { content?: string; reasoning_content?: string } }[];
            };
            const c = chunk.choices?.[0];
            const delta = c?.delta?.content ?? c?.message?.content ?? "";
            const reason = c?.delta?.reasoning_content ?? c?.message?.reasoning_content ?? "";
            if (reason) setThinking((prev) => prev + reason);
            if (delta) setOutput((prev) => prev + delta);
          } catch {
            // Ignore malformed frames.
          }
        }
      }
      if (!output && !thinking) setOutput("(no content in stream)");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setOutput((prev) => (prev ? prev + "\n\n⏹ stopped" : "⏹ stopped"));
      } else {
        setOutput(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
        setOutputError(true);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [session, prompt, running, model, authHeaders, output, thinking]);

  const stopChat = useCallback(() => abortRef.current?.abort(), []);

  // ---- logout ------------------------------------------------------------

  const logout = useCallback(async () => {
    setLogoutOpen(false);
    if (session) {
      try {
        await fetch("/api/auth/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: session.apiKey }),
        });
      } catch {
        // Best-effort revoke.
      }
    }
    clearStored(SESSION_KEY);
    clearStored(PENDING_KEY);
    stopPolling();
    setSession(null);
    setModels([]);
    setOutput("");
    setThinking("");
    showToast("Signed out — API key revoked", "ok");
  }, [session, showToast, stopPolling]);

  const curlUnix = `curl ${baseURL}/chat/completions \\
  -H "Authorization: Bearer ${session?.apiKey ?? "sk-fb-…"}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","stream":true,"messages":[{"role":"user","content":"Hi"}]}'`;

  const curlWindows = `curl.exe ${baseURL}/chat/completions -H "Authorization: Bearer ${session?.apiKey ?? "sk-fb-…"}" -H "Content-Type: application/json" -d "{\\"model\\":\\"${model}\\",\\"stream\\":true,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Hi\\"}]}"`;

  // -------------------------------------------------------------------------

  if (booting) {
    return (
      <div className="boot">
        <span className="boot-mark">fb</span>
        <span className="boot-text">freebuff2api</span>
      </div>
    );
  }

  return (
    <div>
      <div className="mesh" />
      <div className="grid-overlay" />

      {!session ? (
        <LoginView
          pending={pending}
          waiting={waiting}
          loginBusy={loginBusy}
          loginError={loginError}
          onStart={() => void startLogin()}
          onOpen={() => pending && window.open(pending.loginUrl, "_blank")}
          onCancel={() => {
            stopPolling();
            setWaiting(false);
            setPending(null);
            clearStored(PENDING_KEY);
          }}
        />
      ) : (
        <DashboardView
          session={session}
          models={models}
          model={model}
          setModel={setModel}
          prompt={prompt}
          setPrompt={setPrompt}
          running={running}
          thinking={thinking}
          output={output}
          outputError={outputError}
          revealKey={revealKey}
          setRevealKey={setRevealKey}
          baseURL={baseURL}
          curlUnix={curlUnix}
          curlWindows={curlWindows}
          logoutOpen={logoutOpen}
          setLogoutOpen={setLogoutOpen}
          onRun={() => void runChat()}
          onStop={stopChat}
          onLogout={() => void logout()}
          onCopy={(text, label) => {
            void copyText(text).then((ok) =>
              showToast(ok ? `${label} copied` : "Copy failed", ok ? "ok" : "err"),
            );
          }}
          showToast={showToast}
        />
      )}

      {toast && <div className={`toast toast-${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login view
// ---------------------------------------------------------------------------

function LoginView(props: {
  pending: PendingLogin | null;
  waiting: boolean;
  loginBusy: boolean;
  loginError: string;
  onStart: () => void;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const { pending, waiting, loginBusy, loginError, onStart, onOpen, onCancel } = props;
  const secondsLeft = pending && pending.expiresAt > 0 ? Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)) : null;

  return (
    <div className="wrap">
      <header className="nav">
        <div className="brand">
          <span className="mark">fb</span>
          freebuff2api
        </div>
        <span className="endpoint-badge">
          <span className="dot ok" />
          freebuff2api.freebuff.app
        </span>
      </header>

      <main className="login-main">
        <section className="hero">
          <span className="kicker">No subscriptions · No API keys · Free coding models</span>
          <h1>
            Free coding models,
            <br />
            <span className="grad">one OpenAI endpoint.</span>
          </h1>
          <p className="lede">
            freebuff2api gives you a personal OpenAI-compatible endpoint backed by Freebuff's free
            agents. Sign in with your freebuff.com account once, and every model request is served
            by your own session — streaming included.
          </p>

          <div className="login-box">
            {!waiting ? (
              <>
                <button className="btn btn-big" onClick={onStart} disabled={loginBusy}>
                  {loginBusy ? <span className="spin" /> : null}
                  Continue with Freebuff
                </button>
                <p className="box-hint">
                  Opens a one-time login link — you only do this once per browser.
                </p>
              </>
            ) : (
              <>
                <div className="waiting">
                  <span className="spin big" />
                  <p className="waiting-title">Waiting for your login…</p>
                  <p className="box-hint">
                    {secondsLeft !== null && secondsLeft > 0
                      ? `Link expires in ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s.`
                      : "Open the link and sign in on freebuff.com."}
                  </p>
                  {pending ? (
                    <button className="btn ghost" onClick={onOpen}>
                      Open login page
                    </button>
                  ) : null}
                </div>
                <div className="row-c">
                  <button className="link-btn" onClick={onCancel}>
                    Cancel
                  </button>
                </div>
              </>
            )}
            {loginError ? <p className="login-error">{loginError}</p> : null}
          </div>
        </section>

        <section className="feature-strip">
          <div className="feature">
            <span className="feature-n">01</span>
            <b>Sign in once</b>
            <p>Device-code login with your freebuff.com account. No password stored.</p>
          </div>
          <div className="feature">
            <span className="feature-n">02</span>
            <b>Get your API key</b>
            <p>An sk-fb-… key is minted for you and bound to your account session.</p>
          </div>
          <div className="feature">
            <span className="feature-n">03</span>
            <b>Point any client at it</b>
            <p>OpenAI-compatible /v1 — Claude Code, Cline, LobeChat, curl, anything.</p>
          </div>
        </section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard view
// ---------------------------------------------------------------------------

function DashboardView(props: {
  session: Session;
  models: string[];
  model: string;
  setModel: (m: string) => void;
  prompt: string;
  setPrompt: (p: string) => void;
  running: boolean;
  thinking: string;
  output: string;
  outputError: boolean;
  revealKey: boolean;
  setRevealKey: (v: boolean) => void;
  baseURL: string;
  curlUnix: string;
  curlWindows: string;
  logoutOpen: boolean;
  setLogoutOpen: (v: boolean) => void;
  onRun: () => void;
  onStop: () => void;
  onLogout: () => void;
  onCopy: (text: string, label: string) => void;
  showToast: (msg: string, kind?: ToastKind) => void;
}) {
  const { session, models, model, setModel, prompt, setPrompt, running, thinking, output, outputError } = props;
  const { revealKey, setRevealKey, baseURL, curlUnix, curlWindows, logoutOpen, setLogoutOpen } = props;
  const { onRun, onStop, onLogout, onCopy } = props;

  const displayKey = revealKey ? session.apiKey : maskKey(session.apiKey);
  const accountName = session.user?.name || session.user?.email || "Freebuff account";

  return (
    <div className="wrap">
      <header className="nav">
        <div className="brand">
          <span className="mark">fb</span>
          freebuff2api
        </div>
        <div className="nav-right">
          <span className="endpoint-badge">
            <span className="dot ok" />
            {session.user?.email ?? "account"}
          </span>
        </div>
      </header>

      <main className="dash-main">
        <section className="hero hero-small">
          <span className="kicker">Personal endpoint · ready</span>
          <h1>
            Your API, <span className="grad">live.</span>
          </h1>
          <p className="lede">Everything below is private to your freebuff.com session.</p>
        </section>

        <div className="grid-2">
          <section className="card pad">
            <h2>API Key</h2>
            <p className="sub">Minted for your account on first login.</p>
            <div className="key-row">
              <code className="key-value">{displayKey}</code>
              <div className="key-actions">
                <button className="btn icon" onClick={() => setRevealKey(!revealKey)} title={revealKey ? "Hide" : "Reveal"}>
                  {revealKey ? "Hide" : "Show"}
                </button>
                <button className="btn icon" onClick={() => onCopy(session.apiKey, "API key")} title="Copy">
                  Copy
                </button>
              </div>
            </div>
          </section>

          <section className="card pad">
            <h2>Base URL</h2>
            <p className="sub">Use with any OpenAI-compatible client.</p>
            <div className="key-row">
              <code className="key-value">{baseURL}</code>
              <div className="key-actions">
                <button className="btn icon" onClick={() => onCopy(baseURL, "Base URL")} title="Copy">
                  Copy
                </button>
              </div>
            </div>
          </section>
        </div>

        <section className="card pad code-card">
          <h2>Quick start — curl</h2>
          <p className="sub">Streaming chat against your personal endpoint.</p>
          <div className="tabs">
            <button className="tab" onClick={() => onCopy(curlUnix, "curl command")}>
              UNIX / Linux
            </button>
            <button className="tab" onClick={() => onCopy(curlWindows, "curl command")}>
              Windows
            </button>
          </div>
          <div className="code-wrap">
            <button className="copy-btn" onClick={() => onCopy(curlUnix, "curl command")}>
              copy
            </button>
            <pre className="code">
              <code>{curlUnix}</code>
            </pre>
          </div>
        </section>

        <section className="card pad">
          <div className="play-head">
            <h2>Model playground</h2>
            <p className="sub">Streaming replies with the model's thinking block.</p>
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
            {running ? (
              <button className="btn ghost" onClick={onStop}>
                Stop
              </button>
            ) : (
              <button className="btn" onClick={onRun} disabled={!prompt.trim()}>
                Run
              </button>
            )}
          </div>
          <textarea
            className="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask the model anything…"
            style={{ marginTop: 12 }}
          />

          {thinking ? (
            <details className="thinking" open>
              <summary>Thinking</summary>
              <pre>{thinking}</pre>
            </details>
          ) : null}

          <div className={`output${outputError ? " error" : ""}`}>
            {output || <span className="dim">{running ? "Streaming…" : "The streamed reply appears here."}</span>}
          </div>
        </section>

        <footer className="dash-footer">
          <button className="btn ghost danger" onClick={() => setLogoutOpen(true)}>
            Sign out
          </button>
        </footer>
      </main>

      {logoutOpen ? (
        <div className="modal-backdrop" onClick={() => setLogoutOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Sign out?</h3>
            <p>
              This revokes your API key and clears your account info from this browser. Your
              freebuff.com account itself is unaffected.
            </p>
            <div className="row right">
              <button className="btn ghost" onClick={() => setLogoutOpen(false)}>
                Cancel
              </button>
              <button className="btn danger-solid" onClick={onLogout}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
