"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Repository linked from the header (mirrors freebuff.com's header style). */
const GITHUB_URL = "https://github.com/chenjh16/freebuff2api";
const GITHUB_API_URL = "https://api.github.com/repos/chenjh16/freebuff2api";

// ---------------------------------------------------------------------------
// Types & storage
// ---------------------------------------------------------------------------

interface Session {
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
const GATE_KEY = "freebuff2api_site_token";
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

/**
 * Ask the server whether a site access token unlocks the console.
 * `enabled: false` means no SITE_ACCESS_TOKEN is configured — the site is
 * open and every token is accepted.
 */
async function callGateVerify(token: string): Promise<{ ok: boolean; enabled: boolean }> {
  try {
    const resp = await fetch("/api/gate/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
    const body = (await resp.json().catch(() => null)) as { ok?: boolean; enabled?: boolean } | null;
    if (body?.enabled === false) return { ok: true, enabled: false };
    return { ok: resp.ok && body?.ok === true, enabled: true };
  } catch {
    // Cannot reach the verify endpoint — stay locked.
    return { ok: false, enabled: true };
  }
}

/** Remove ?token=… from the URL so it is not shared or re-read later. */
function stripTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.toString());
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

  // site access gate
  const [gateOpen, setGateOpen] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState("");

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

  const baseURL = typeof window !== "undefined" ? `${window.location.origin}/v1` : "https://open.freebuff.app/v1";

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
    async (transactionId: string) => {
      setLoginBusy(true);
      try {
        const resp = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId }),
        });
        const body = (await resp.json().catch(() => null)) as { apiKey?: string; user?: Session["user"]; error?: string } | null;
        if (!resp.ok || !body?.apiKey) {
          throw new Error(body?.error ?? `register failed (${resp.status})`);
        }
        const next: Session = { apiKey: body.apiKey, user: body.user ?? { email: null } };
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
        const resp = await fetch("/api/auth/status", { cache: "no-store" });
        const body = (await resp.json().catch(() => null)) as { transactionId?: string } | null;
        if (resp.ok && body?.transactionId) {
          stopPolling();
          void finishRegister(body.transactionId);
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

  const unlock = useCallback(async (token: string) => {
    setGateBusy(true);
    setGateError("");
    const verdict = await callGateVerify(token);
    if (verdict.ok) {
      writeStored(GATE_KEY, token);
      setGateOpen(true);
    } else {
      setGateError("Invalid access token.");
    }
    setGateBusy(false);
  }, []);

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
      // The transaction is held in an HttpOnly cookie on the server; pending
      // browser state is only UI metadata and contains no account credential.
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

  // Boot: unlock the site gate, then validate a stored session, else restore
  // a pending login, else idle.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. Site access gate — unlock via ?token=…, a previously verified
      // stored token, or when the gate is disabled server-side.
      const urlToken = new URLSearchParams(window.location.search).get("token");
      const storedToken = readStored<string>(GATE_KEY);
      const candidate = urlToken ?? storedToken ?? "";
      const verdict = await callGateVerify(candidate);
      if (cancelled) return;
      if (verdict.ok) {
        setGateOpen(true);
        if (urlToken) {
          writeStored(GATE_KEY, urlToken);
          stripTokenFromUrl();
        }
      } else {
        if (urlToken) {
          // A URL-supplied token was rejected — clear it and show the gate.
          stripTokenFromUrl();
          setGateError("That access token was rejected.");
        }
        setGateOpen(false);
        setBooting(false);
        return; // stay locked — do not touch session/pending state
      }

      // Only the derived API key and non-sensitive profile are persisted. The
      // upstream account token is never returned to or stored by the browser.
      // Discard the legacy record if it contains only the old raw token.
      const stored = readStored<Partial<Session> & { authToken?: unknown }>(SESSION_KEY);
      if (stored?.apiKey && typeof stored.apiKey === "string") {
        const next: Session = { apiKey: stored.apiKey, user: stored.user ?? { email: null } };
        writeStored(SESSION_KEY, next);
        if (!cancelled) setSession(next);
      } else if (stored) {
        clearStored(SESSION_KEY);
      }
      if (!cancelled && !stored?.apiKey) await resumePending();
      if (!cancelled) setBooting(false);
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
    let streamedOutput = "";
    let streamedThinking = "";
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
            if (reason) {
              streamedThinking += reason;
              setThinking((prev) => prev + reason);
            }
            if (delta) {
              streamedOutput += delta;
              setOutput((prev) => prev + delta);
            }
          } catch {
            // Ignore malformed frames.
          }
        }
      }
      if (!streamedOutput && !streamedThinking) setOutput("(no content in stream)");
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
  }, [session, prompt, running, model, authHeaders]);

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
        <img className="boot-logo" src="/logo-icon.png" alt="Freebuff" width="24" height="24" />
        <span className="boot-text">freebuff</span>
      </div>
    );
  }

  if (!gateOpen) {
    return (
      <div>
        <div className="mesh" />
        <div className="grid-overlay" />
        <GateView busy={gateBusy} error={gateError} onSubmit={(token) => void unlock(token)} />
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
// Site header (freebuff.com-style brand + adaptive host + GitHub link)
// ---------------------------------------------------------------------------

function useGitHubStars(): number | null {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(GITHUB_API_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.stargazers_count === "number") setStars(d.stargazers_count);
      })
      .catch(() => {
        // Star count is decorative; ignore failures.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return stars;
}

/** Current site host, e.g. `open.freebuff.app` or the preview URL. */
function siteHost(): string {
  return typeof window !== "undefined" ? window.location.host : "open.freebuff.app";
}

function SiteHeader({ right }: { right?: React.ReactNode }) {
  const stars = useGitHubStars();
  return (
    <header className="nav">
      <a className="brand" href="https://freebuff.com" target="_blank" rel="noopener noreferrer">
        <img className="brand-logo" src="/logo-icon.png" alt="Freebuff" width="24" height="24" />
        <span className="brand-text">freebuff</span>
      </a>
      <div className="nav-right">
        <span className="endpoint-badge" title="API base host">
          <span className="dot ok" />
          {siteHost()}
        </span>
        <a
          className="gh-btn"
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Star freebuff2api on GitHub"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="gh-icon">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.523 2 12 2Z"
            />
          </svg>
          <span className="gh-stars">{stars !== null ? stars.toLocaleString() : "Star"}</span>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="gh-star">
            <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
          </svg>
        </a>
        {right}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Site access gate (shown when SITE_ACCESS_TOKEN is configured and the
// visitor has not presented a valid token yet)
// ---------------------------------------------------------------------------

function GateView(props: { busy: boolean; error: string; onSubmit: (token: string) => void }) {
  const { busy, error, onSubmit } = props;
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="gate-wrap">
      <a className="gate-brand" href="https://freebuff.com" target="_blank" rel="noopener noreferrer">
        <img className="boot-logo" src="/logo-icon.png" alt="Freebuff" width="28" height="28" />
        <span className="boot-text">freebuff</span>
      </a>

      <div className="gate-card">
        <div className="gate-lock">
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>
        <h1>Restricted access</h1>
        <p>This console is private. Enter the site access token to continue.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const token = value.trim();
            if (token && !busy) onSubmit(token);
          }}
        >
          <input
            ref={inputRef}
            className="gate-input"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Site access token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          <button className="btn btn-big" type="submit" disabled={busy || !value.trim()}>
            {busy ? <span className="spin" /> : null}
            Unlock
          </button>
        </form>
        {error ? <p className="login-error">{error}</p> : null}
      </div>

      <p className="gate-hint">This deployment is access-restricted.</p>
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
      <SiteHeader />

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
      <SiteHeader right={<span className="endpoint-badge">{session.user?.email ?? "account"}</span>} />

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
