"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";

// DeployPrCard — the launch card the chat renders when the model emits
// a DEPLOY_PR action (user asked to test/deploy/preview a PR). It picks
// the runner:
//   * house terminal (EC2) online -> "Open in Terminal": routes to
//     /dashboard/terminal?deploy=<repo>&pr=<n>, where WebTerminal runs
//     pr_deploy.sh live in the PTY and prints the Cloudflare URL.
//   * else DevPod online -> tells the user to use the Sandbox Test panel
//     (which auto-mounts for the same PR and also yields a preview URL).
//   * else -> nothing connected, with how-to-start guidance.

interface RunnerStatus {
  house: { connected: boolean; label: string | null };
  devpod: { connected: boolean };
  preferred: "house" | "devpod" | null;
}

interface Props {
  repo: string;
  prNumber: number;
}

type State =
  | { s: "loading" }
  | { s: "error"; msg: string }
  | { s: "ready"; runner: RunnerStatus };

export function DeployPrCard({ repo, prNumber }: Props) {
  const [state, setState] = useState<State>({ s: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/runner/status", { cache: "no-store" });
        if (res.status === 401) {
          if (!cancelled) setState({ s: "error", msg: "Session expired — refresh." });
          return;
        }
        const runner = (await res.json()) as RunnerStatus;
        if (!cancelled) setState({ s: "ready", runner });
      } catch (e) {
        if (!cancelled) setState({ s: "error", msg: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const shortRepo = repo.split("/")[1] ?? repo;

  return (
    <Card flush className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <RocketGlyph />
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
          Deploy PR
        </span>
        <span className="font-mono text-[11px] text-text">
          #{prNumber}
        </span>
        <span className="truncate font-mono text-[11px] text-muted/70">
          · {shortRepo}
        </span>
      </div>

      <div className="px-3 py-3">
        {state.s === "loading" && (
          <p className="font-mono text-[11px] text-muted">Checking runners…</p>
        )}

        {state.s === "error" && (
          <p className="text-[11px] text-[#ff5a5a]">{state.msg}</p>
        )}

        {state.s === "ready" && state.runner.house.connected && (
          <div className="space-y-2.5">
            <p className="text-[12px] leading-relaxed text-text-soft">
              Runs a live sandbox of PR #{prNumber} on the Lyncas terminal
              {state.runner.house.label ? (
                <span className="text-muted"> ({state.runner.house.label})</span>
              ) : null}{" "}
              and streams it in the Terminal tab. You&apos;ll get a Cloudflare
              preview URL at the end.
            </p>
            <Link
              href={`/dashboard/terminal?deploy=${encodeURIComponent(repo)}&pr=${prNumber}`}
              className="inline-flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/25"
            >
              ▶ Open in Terminal
              <span className="text-[10px] opacity-70">↗</span>
            </Link>
          </div>
        )}

        {state.s === "ready" &&
          !state.runner.house.connected &&
          state.runner.devpod.connected && (
            <div className="space-y-1.5">
              <p className="text-[12px] leading-relaxed text-text-soft">
                The EC2 terminal is offline, but your DevPod is connected —
                use the{" "}
                <span className="font-medium text-text">Sandbox Test</span>{" "}
                panel above (▶ Run sandbox test) to run PR #{prNumber} and get
                a live preview URL.
              </p>
              <p className="font-mono text-[10.5px] text-muted">
                Fallback: DevPod sandbox
              </p>
            </div>
          )}

        {state.s === "ready" &&
          !state.runner.house.connected &&
          !state.runner.devpod.connected && (
            <div className="space-y-2">
              <p className="text-[12px] leading-relaxed text-text-soft">
                No runner is connected. Start the EC2 house terminal, or
                connect a DevPod, then ask again.
              </p>
              <code className="block rounded-sm border border-border bg-bg px-2 py-1.5 font-mono text-[10.5px] text-muted">
                python3 agent/terminal_server.py --label webhook-ec2
              </code>
            </div>
          )}
      </div>
    </Card>
  );
}

function RocketGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className="text-muted" aria-hidden>
      <path d="M8 1.5c2.5 1 4 3.5 4 6.5 0 1.2-.3 2.3-.8 3.2L8 13l-3.2-1.8C4.3 10.3 4 9.2 4 8c0-3 1.5-5.5 4-6.5Z" />
      <circle cx="8" cy="6.5" r="1.2" />
      <path d="M5.5 12l-1.5 2.5M10.5 12l1.5 2.5" />
    </svg>
  );
}
