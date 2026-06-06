"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import type {
  DevpodCapabilities,
  DevpodStatusResponse,
} from "@/lib/types";

// DevPodPanel — left-sidebar widget on /dashboard/chat that mirrors
// the user's DevPod connection state.
//
// Poll model:
//   * /api/devpod/status?username=… every 30s while mounted.
//   * Aborts in-flight requests when the username changes or the
//     panel unmounts.
//   * On 200 + connected=false we render the "offline / how to
//     connect" copy. On connected=true we render live + capability
//     badges + Run tests / Disconnect.
//
// This component intentionally owns the connect-token fetch too.
// We'd otherwise duplicate that fetch logic on the settings page;
// keeping it here means the chat sidebar can show the snippet
// without making the user navigate to /settings.

const POLL_INTERVAL_MS = 30_000;

interface Props {
  // Required: the chat page only renders this component once the
  // Supabase session has resolved a GitHub login. That keeps the
  // polling effect single-purpose (always has a username) and
  // means we never render an "unknown user" placeholder.
  githubUsername: string;
}

// Match the "live / offline" view that the chat page wants to show.
// `loading` is the very-first-render state before the first poll
// completes; we render a dimmed dot then.
type ConnectionState =
  | { state: "loading" }
  | { state: "offline" }
  | { state: "live"; data: Required<DevpodStatusResponse> };

interface ExecResult {
  pending: boolean;
  output: string | null;
  error: string | null;
}

export function DevPodPanel({ githubUsername }: Props) {
  const [conn, setConn] = useState<ConnectionState>({ state: "loading" });
  const [open, setOpen] = useState(false);

  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);

  const [exec, setExec] = useState<ExecResult | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const pollAbortRef = useRef<AbortController | null>(null);

  // Status polling. We intentionally re-fetch on the SAME interval
  // regardless of state — flipping live -> offline (e.g. CLI
  // crash) needs to happen visibly within ~30s, and the request
  // cost is negligible.
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      pollAbortRef.current?.abort();
      const ac = new AbortController();
      pollAbortRef.current = ac;
      try {
        const res = await fetch(
          `/api/devpod/status?username=${encodeURIComponent(githubUsername)}`,
          { signal: ac.signal, cache: "no-store" },
        );
        if (cancelled || ac.signal.aborted) return;
        if (!res.ok) {
          // Treat any error as "offline" — better to lie quiet than
          // to surface a transient 500 as a red banner.
          setConn({ state: "offline" });
          return;
        }
        const body = (await res.json()) as DevpodStatusResponse;
        if (cancelled) return;
        if (body.connected && body.tunnel_url && body.last_ping && body.expires_at) {
          setConn({
            state: "live",
            data: {
              connected: true,
              tunnel_url: body.tunnel_url,
              workspace_id: body.workspace_id ?? null,
              last_ping: body.last_ping,
              expires_at: body.expires_at,
              capabilities: body.capabilities ?? {
                run_command: true,
                run_tests: true,
                start_app: true,
                expose_port: true,
              },
            },
          });
        } else {
          setConn({ state: "offline" });
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        if (cancelled) return;
        setConn({ state: "offline" });
      }
    }

    void tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      pollAbortRef.current?.abort();
    };
  }, [githubUsername]);

  // Lazy-load the connect token: only when the user clicks
  // "Connect" to expand the snippet section. Keeping this in the
  // click handler (rather than an effect that watches `open`)
  // avoids a React effect-cascade lint warning AND means a closed
  // panel never makes the network round-trip.
  const ensureToken = useCallback(async () => {
    if (token || tokenLoading) return;
    setTokenLoading(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/devpod/token", { cache: "no-store" });
      const body = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !body.token) {
        setTokenError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setToken(body.token);
    } catch (e) {
      setTokenError((e as Error).message);
    } finally {
      setTokenLoading(false);
    }
  }, [token, tokenLoading]);

  function toggleOpen() {
    setOpen((prev) => {
      const next = !prev;
      if (next) void ensureToken();
      return next;
    });
  }

  // Run tests action — calls /api/devpod/execute. We push the
  // full output into the panel below the action row; pretty-printing
  // is left to a <pre> block.
  async function runTests() {
    setExec({ pending: true, output: null, error: null });
    setShowOutput(true);
    try {
      const res = await fetch("/api/devpod/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: "",
          command: "",
          type: "run_tests",
        }),
      });
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // text/plain or non-JSON — leave it as-is.
      }
      if (!res.ok) {
        setExec({ pending: false, output: pretty, error: `HTTP ${res.status}` });
      } else {
        setExec({ pending: false, output: pretty, error: null });
      }
    } catch (e) {
      setExec({
        pending: false,
        output: null,
        error: (e as Error).message,
      });
    }
  }

  async function disconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await fetch("/api/devpod/disconnect", { method: "POST" });
      // Don't trust our optimistic update — the status poll will
      // catch up within 30s. Force one immediate refresh so the UI
      // updates instantly.
      setConn({ state: "offline" });
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Card flush>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          <DevPodGlyph />
          DevPod
        </span>
        <div className="flex items-center gap-1.5">
          <StatusPill state={conn.state} />
          {conn.state === "offline" && (
            <button
              type="button"
              onClick={toggleOpen}
              className="rounded-sm border border-border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em] text-muted transition-colors hover:border-border-strong hover:text-text"
            >
              {open ? "Hide" : "Connect"}
            </button>
          )}
        </div>
      </div>

      {conn.state === "live" && (
        <LiveBody
          data={conn.data}
          exec={exec}
          showOutput={showOutput}
          onToggleOutput={() => setShowOutput((v) => !v)}
          onRunTests={runTests}
          onDisconnect={disconnect}
          disconnecting={disconnecting}
        />
      )}

      {conn.state !== "live" && open && (
        <OfflineBody
          token={token}
          tokenLoading={tokenLoading}
          tokenError={tokenError}
        />
      )}
    </Card>
  );
}

// ---- header chrome -----------------------------------------------------

function DevPodGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 1.5l5.5 3v7L8 14.5 2.5 11.5v-7L8 1.5Z" />
      <path d="M2.7 4.6L8 7.5l5.3-2.9M8 7.5v6.8" />
    </svg>
  );
}

function StatusPill({ state }: { state: ConnectionState["state"] }) {
  const map = {
    live: {
      dot: "bg-[#4ade80]",
      cls: "border-[#4ade80]/30 bg-[#4ade80]/10 text-[#4ade80]",
      label: "Live",
    },
    loading: {
      dot: "bg-border animate-pulse",
      cls: "border-border bg-bg-elev text-muted",
      label: "Connecting",
    },
    offline: {
      dot: "bg-[#9ca3af]",
      cls: "border-border bg-bg-elev text-muted",
      label: "Offline",
    },
  } as const;
  const s = map[state];
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-mono uppercase tracking-[0.14em] " +
        s.cls
      }
    >
      <span className={"inline-block h-1.5 w-1.5 rounded-full " + s.dot} aria-hidden />
      {s.label}
    </span>
  );
}

// ---- live body ---------------------------------------------------------

function LiveBody({
  data,
  exec,
  showOutput,
  onToggleOutput,
  onRunTests,
  onDisconnect,
  disconnecting,
}: {
  data: Required<DevpodStatusResponse>;
  exec: ExecResult | null;
  showOutput: boolean;
  onToggleOutput: () => void;
  onRunTests: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
}) {
  const wsLabel = (data.workspace_id ?? "—").slice(0, 24);
  return (
    <div className="space-y-3 px-3 py-3">
      <dl className="divide-y divide-border/60 rounded-sm border border-border bg-bg/40 text-[11px]">
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
          <dt className="text-muted">Workspace</dt>
          <dd
            className="max-w-[58%] truncate font-mono text-text"
            title={data.workspace_id ?? ""}
          >
            {wsLabel}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
          <dt className="text-muted">Last ping</dt>
          <dd className="font-mono text-text">{relativeTime(data.last_ping)}</dd>
        </div>
      </dl>

      <div className="space-y-1.5">
        <div className="text-[9px] font-mono uppercase tracking-[0.16em] text-muted">
          Capabilities
        </div>
        <CapabilityBadges caps={data.capabilities} />
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={onRunTests}
          disabled={!data.capabilities.run_tests || exec?.pending}
          className="flex items-center justify-center gap-1.5 rounded-sm border border-border bg-bg px-2 py-1.5 text-[10px] font-mono uppercase tracking-[0.12em] text-text transition-colors hover:border-border-strong hover:bg-bg-elev disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M4 2.5v11l9-5.5z" />
          </svg>
          {exec?.pending ? "Running…" : "Run tests"}
        </button>
        <button
          type="button"
          onClick={onDisconnect}
          disabled={disconnecting}
          className="rounded-sm border border-[#ff5252]/40 bg-transparent px-2 py-1.5 text-[10px] font-mono uppercase tracking-[0.12em] text-[#ff5252] transition-colors hover:bg-[#ff5252]/10 disabled:opacity-40"
        >
          {disconnecting ? "…" : "Disconnect"}
        </button>
      </div>

      {(exec?.output || exec?.error) && (
        <div>
          <button
            type="button"
            onClick={onToggleOutput}
            className="mb-1 text-[10px] font-mono uppercase tracking-[0.14em] text-muted hover:text-text"
          >
            {showOutput ? "Hide output ▾" : "Show output ▸"}
          </button>
          {showOutput && (
            <div className="space-y-1.5">
              {exec?.error && (
                <div className="rounded-sm border border-[#ff5252]/40 bg-[#ff5252]/10 px-2 py-1 text-[10.5px] text-[#ff5252]">
                  {exec.error}
                </div>
              )}
              {exec?.output && (
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-bg-elev p-2 text-[10.5px] leading-relaxed">
                  {exec.output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CapabilityBadges({ caps }: { caps: DevpodCapabilities }) {
  const items: Array<[keyof DevpodCapabilities, string]> = [
    ["run_command", "command"],
    ["run_tests", "tests"],
    ["start_app", "app"],
    ["expose_port", "port"],
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(([key, label]) => {
        const on = caps[key];
        return (
          <span
            key={key}
            className={
              "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.12em] " +
              (on
                ? "border-border bg-bg-elev text-muted"
                : "border-border/40 text-muted/40")
            }
            title={on ? `${key}: available` : `${key}: unavailable`}
          >
            <span
              className={
                "inline-block h-1 w-1 rounded-full " +
                (on ? "bg-[#4ade80]" : "bg-border")
              }
              aria-hidden
            />
            {label}
          </span>
        );
      })}
    </div>
  );
}

// ---- offline / connect snippet ----------------------------------------

function OfflineBody({
  token,
  tokenLoading,
  tokenError,
}: {
  token: string | null;
  tokenLoading: boolean;
  tokenError: string | null;
}) {
  const installCmd =
    "curl -fsSL https://lyncas.vercel.app/devpod-connect.sh | bash";
  const connectCmd = token
    ? `devpod-connect --token ${token}`
    : "devpod-connect --token <fetching…>";

  return (
    <div className="space-y-3 px-3 py-3">
      <p className="text-[10.5px] leading-relaxed text-muted">
        Connect a DevPod to run tests and live previews straight from
        chat. Paste these into your DevPod terminal:
      </p>
      <div className="space-y-1.5">
        <StepLabel n={1} text="Install — run once" />
        <CopyBox text={installCmd} />
      </div>
      <div className="space-y-1.5">
        <StepLabel n={2} text="Connect — each session" />
        {tokenError ? (
          <div className="rounded-sm border border-[#ff5252]/40 bg-[#ff5252]/10 px-2 py-1 text-[10.5px] text-[#ff5252]">
            {tokenError}
          </div>
        ) : (
          <CopyBox text={connectCmd} disabled={!token || tokenLoading} />
        )}
      </div>
    </div>
  );
}

function StepLabel({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-4 w-4 items-center justify-center rounded-full border border-border bg-bg-elev text-[9px] font-mono text-muted">
        {n}
      </span>
      <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-muted">
        {text}
      </span>
    </div>
  );
}

function CopyBox({
  text,
  disabled,
}: {
  text: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }
  return (
    <div className="group flex items-stretch gap-1.5 rounded-sm border border-border bg-bg p-2 transition-colors hover:border-border-strong">
      <span className="select-none font-mono text-[10.5px] leading-relaxed text-muted/70" aria-hidden>
        $
      </span>
      <code
        className="flex-1 truncate font-mono text-[10.5px] leading-relaxed text-text"
        title={text}
      >
        {text}
      </code>
      <button
        type="button"
        onClick={copy}
        disabled={disabled}
        className="shrink-0 rounded-sm border border-border px-2 py-0.5 text-[9px] font-mono uppercase tracking-[0.14em] text-muted transition-colors hover:border-border-strong hover:text-text disabled:opacity-40"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// ---- helpers -----------------------------------------------------------

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
