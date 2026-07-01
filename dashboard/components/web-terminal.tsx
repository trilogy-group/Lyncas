"use client";

import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";

// WebTerminal — a real interactive PTY rendered in the browser via
// xterm.js, wired to the Lyncas "house terminal" (agent/terminal_server.py
// on the EC2 box) over a Cloudflare-tunnelled WebSocket.
//
// Flow:
//   1. GET /api/terminal/info -> { ws_url (wss), token } when a runner
//      is online, else { connected: false }.
//   2. Open ws://.../?token=<jwt>. The server verifies the token, forks
//      a login shell, and streams the PTY both ways.
//
// Wire protocol (must match terminal_server.py):
//   server -> client : binary PTY output (written straight to xterm).
//   client -> server : text frames tagged by first char —
//       "0" + data  = keystrokes
//       "1" + json   = resize {cols, rows}
//
// SECURITY NOTE (testing phase): this is a shared, un-isolated shell on
// the same EC2 box as the webhook handler. Everyone who opens the tab
// lands in the same environment. Isolation is tracked separately.

type Status =
  | "loading"
  | "offline"
  | "connecting"
  | "connected"
  | "closed"
  | "error";

interface InfoOnline {
  connected: true;
  ws_url: string;
  token: string;
  label: string;
  workspace_id: string;
  expires_at: string;
}
type InfoResponse = { connected: false } | InfoOnline;

export function WebTerminal() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [label, setLabel] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Push the current terminal geometry to the server so the remote PTY
  // wraps lines correctly.
  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send("1" + JSON.stringify({ cols: term.cols, rows: term.rows }));
  }, []);

  const fitAndResize = useCallback(() => {
    try {
      fitRef.current?.fit();
    } catch {
      // fit throws if the element isn't laid out yet; ignore.
    }
    sendResize();
  }, [sendResize]);

  const connect = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;

    // Tear down any previous socket before opening a new one.
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }

    setStatus("loading");
    setMessage(null);

    let info: InfoResponse;
    try {
      const res = await fetch("/api/terminal/info", { cache: "no-store" });
      if (res.status === 401) {
        setStatus("error");
        setMessage("Your session expired. Refresh the page and sign in again.");
        return;
      }
      info = (await res.json()) as InfoResponse;
    } catch (e) {
      setStatus("error");
      setMessage((e as Error).message);
      return;
    }

    if (!info.connected) {
      setStatus("offline");
      return;
    }

    setLabel(info.label);
    setStatus("connecting");

    const ws = new WebSocket(`${info.ws_url}/?token=${encodeURIComponent(info.token)}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      term.focus();
      // Give layout a tick to settle before measuring geometry.
      requestAnimationFrame(fitAndResize);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      if (wsRef.current === ws) wsRef.current = null;
      if (ev.code === 4401) {
        setStatus("error");
        setMessage("Authentication rejected by the terminal server.");
        return;
      }
      setStatus("closed");
      term.write("\r\n\x1b[38;5;244m[connection closed]\x1b[0m\r\n");
    };

    ws.onerror = () => {
      setStatus("error");
      setMessage("WebSocket error — the runner may be offline or the tunnel down.");
    };
  }, [fitAndResize]);

  // One-time xterm bootstrap. Dynamically import so nothing touches the
  // DOM during SSR.
  useEffect(() => {
    let disposed = false;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !mountRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
        fontSize: 13,
        theme: {
          background: "#0a0a0a",
          foreground: "#e5e5e5",
          cursor: "#ff8a3d",
          selectionBackground: "#ffffff33",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(mountRef.current);

      termRef.current = term;
      fitRef.current = fit;

      term.onData((data) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send("0" + data);
      });

      // Refit + notify the PTY whenever the panel resizes.
      const ro = new ResizeObserver(() => fitAndResize());
      ro.observe(mountRef.current);
      roRef.current = ro;

      try {
        fit.fit();
      } catch {
        // ignore pre-layout fit failures
      }

      void connect();
    })();

    return () => {
      disposed = true;
      roRef.current?.disconnect();
      roRef.current = null;
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
        wsRef.current = null;
      }
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // connect / fitAndResize are stable (useCallback); run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-border bg-[#0a0a0a]">
      {/* Title bar */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-elev px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex items-center gap-1.5" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" />
          </span>
          <span className="truncate font-mono text-[11px] text-muted">
            {label ? `${label} — /bin/bash` : "house terminal"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={status} />
          <button
            type="button"
            onClick={() => void connect()}
            disabled={status === "connecting" || status === "loading"}
            className="rounded-sm border border-border bg-bg px-2 py-1 text-[10px] font-mono uppercase tracking-[0.14em] text-text transition-colors hover:border-border-strong hover:bg-bg-elev disabled:opacity-40"
          >
            {status === "connected" ? "Reconnect" : "Connect"}
          </button>
        </div>
      </div>

      {/* Terminal surface */}
      <div className="relative">
        <div ref={mountRef} className="h-[62vh] w-full p-2" />

        {(status === "offline" || status === "error" || status === "loading") && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0a]/85 px-6 text-center">
            <div className="max-w-md space-y-2">
              {status === "loading" && (
                <p className="font-mono text-xs text-muted">Connecting…</p>
              )}
              {status === "offline" && (
                <>
                  <p className="text-sm font-medium text-text">
                    No terminal runner is online
                  </p>
                  <p className="text-xs text-muted">
                    Start the house terminal on the EC2 box, then hit
                    Connect:
                  </p>
                  <code className="mt-1 block rounded-sm border border-border bg-bg px-2 py-1.5 text-left font-mono text-[10.5px] text-text-soft">
                    python3 terminal_server.py --label webhook-ec2
                  </code>
                </>
              )}
              {status === "error" && (
                <>
                  <p className="text-sm font-medium text-[#ff5a5a]">
                    Terminal error
                  </p>
                  <p className="text-xs text-muted">{message}</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { dot: string; cls: string; label: string }> = {
    connected: {
      dot: "bg-[#4ade80]",
      cls: "border-[#4ade80]/30 bg-[#4ade80]/10 text-[#4ade80]",
      label: "Live",
    },
    connecting: {
      dot: "bg-[#ffbd2e] animate-pulse",
      cls: "border-[#ffbd2e]/30 bg-[#ffbd2e]/10 text-[#ffbd2e]",
      label: "Connecting",
    },
    loading: {
      dot: "bg-border animate-pulse",
      cls: "border-border bg-bg text-muted",
      label: "Loading",
    },
    offline: {
      dot: "bg-[#9ca3af]",
      cls: "border-border bg-bg text-muted",
      label: "Offline",
    },
    closed: {
      dot: "bg-[#9ca3af]",
      cls: "border-border bg-bg text-muted",
      label: "Closed",
    },
    error: {
      dot: "bg-[#ff5a5a]",
      cls: "border-[#ff5a5a]/30 bg-[#ff5a5a]/10 text-[#ff5a5a]",
      label: "Error",
    },
  };
  const s = map[status];
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
