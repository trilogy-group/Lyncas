"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type {
  DevpodStatusResponse,
  SandboxOverall,
  SandboxProgressEvent,
  SandboxStep,
} from "@/lib/types";

// SandboxTestCard
//
// Renders the "🧪 Run sandbox test on PR #N" button + the per-step
// progress card while the test is running + the final results card.
//
// Behavior:
//   * Self-checks DevPod liveness via /api/devpod/status. If the
//     user's session is offline / expired, renders nothing — the
//     chat page doesn't have to gate.
//   * On click: POSTs to /api/devpod/run-pr-tests, opens an SSE
//     stream, walks the per-step events as they arrive.
//   * On the terminal "complete" event, swaps the spinner for the
//     final results card. The user can dismiss the card or re-run.
//   * If the chat page navigates to a different PR / repo, the card
//     resets — we don't carry state across PRs.

const STEPS: ReadonlyArray<{
  step: Exclude<SandboxStep, "complete">;
  label: string;
}> = [
  { step: "clone", label: "Clone PR branch" },
  { step: "install", label: "Install dependencies" },
  { step: "tests", label: "Run tests" },
  { step: "app", label: "Start app" },
  { step: "expose", label: "Expose preview URL" },
];

interface FinalResult {
  overall: SandboxOverall | null;
  passed: number;
  failed: number;
  url: string | null;
  duration_ms: number | null;
  cloneSuccess: boolean | null;
  appStarted: boolean | null;
  error: string | null;
}

const INITIAL_FINAL: FinalResult = {
  overall: null,
  passed: 0,
  failed: 0,
  url: null,
  duration_ms: null,
  cloneSuccess: null,
  appStarted: null,
  error: null,
};

type StepStatus = "pending" | "running" | "done" | "error" | "skipped";

function StepDot({ status }: { status: StepStatus }) {
  const colors: Record<StepStatus, string> = {
    pending: "bg-border",
    running: "bg-amber-400",
    done: "bg-emerald-500",
    error: "bg-rose-500",
    skipped: "bg-muted/40",
  };
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${colors[status]} ${status === "running" ? "animate-pulse" : ""}`}
    />
  );
}

interface SandboxTestCardProps {
  repo: string;
  prNumber: number;
}

export function SandboxTestCard({ repo, prNumber }: SandboxTestCardProps) {
  const [live, setLive] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [stepStates, setStepStates] = useState<Record<SandboxStep, StepStatus>>(
    () => ({
      clone: "pending",
      install: "pending",
      tests: "pending",
      app: "pending",
      expose: "pending",
      complete: "pending",
    }),
  );
  const [final, setFinal] = useState<FinalResult>(INITIAL_FINAL);
  const [dismissed, setDismissed] = useState(false);

  // One-shot liveness probe. The DevPod sidebar polls every 30s, so
  // we don't need to repeat that work here — a single check on
  // mount + a re-check whenever (repo, prNumber) changes is enough.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/devpod/status", { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setLive(false);
          return;
        }
        const j = (await res.json()) as DevpodStatusResponse;
        if (!cancelled) setLive(!!j.connected);
      } catch {
        if (!cancelled) setLive(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, prNumber]);

  // Reset state when the chat moves to a different PR.
  const lastKeyRef = useRef("");
  useEffect(() => {
    const k = `${repo}#${prNumber}`;
    if (lastKeyRef.current && lastKeyRef.current !== k) {
      setRunning(false);
      setStepStates({
        clone: "pending",
        install: "pending",
        tests: "pending",
        app: "pending",
        expose: "pending",
        complete: "pending",
      });
      setFinal(INITIAL_FINAL);
      setDismissed(false);
    }
    lastKeyRef.current = k;
  }, [repo, prNumber]);

  const start = useCallback(async () => {
    setRunning(true);
    setDismissed(false);
    setFinal(INITIAL_FINAL);
    setStepStates({
      clone: "pending",
      install: "pending",
      tests: "pending",
      app: "pending",
      expose: "pending",
      complete: "pending",
    });

    let res: Response;
    try {
      res = await fetch("/api/devpod/run-pr-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, pr_number: prNumber }),
      });
    } catch (e) {
      setFinal((f) => ({ ...f, error: (e as Error).message, overall: "error" }));
      setRunning(false);
      return;
    }
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        // non-json
      }
      setFinal((f) => ({ ...f, error: msg, overall: "error" }));
      setRunning(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const payload = dataLine.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;
          let evt: SandboxProgressEvent;
          try {
            evt = JSON.parse(payload) as SandboxProgressEvent;
          } catch {
            continue;
          }
          if (evt.step === "complete") {
            setFinal((prev) => ({
              ...prev,
              overall: evt.overall ?? "error",
              url: evt.url ?? prev.url,
              duration_ms: evt.duration_ms ?? prev.duration_ms,
              error: evt.error ?? prev.error,
            }));
            // Mark any still-pending steps as skipped so the UI
            // doesn't leave them spinning.
            setStepStates((s) => {
              const next: typeof s = { ...s };
              for (const k of Object.keys(next) as SandboxStep[]) {
                if (next[k] === "pending") next[k] = "skipped";
                if (next[k] === "running") next[k] = "skipped";
              }
              return next;
            });
            continue;
          }
          if (evt.status === "running") {
            setStepStates((s) => ({ ...s, [evt.step]: "running" }));
          } else if (evt.status === "done") {
            setStepStates((s) => ({ ...s, [evt.step]: "done" }));
            setFinal((prev) => ({
              ...prev,
              passed: evt.passed ?? prev.passed,
              failed: evt.failed ?? prev.failed,
              url: evt.url ?? prev.url,
              cloneSuccess:
                evt.step === "clone" ? !!evt.success : prev.cloneSuccess,
              appStarted: evt.step === "app" ? !!evt.success : prev.appStarted,
            }));
          } else if (evt.status === "error") {
            setStepStates((s) => ({ ...s, [evt.step]: "error" }));
            setFinal((prev) => ({
              ...prev,
              error: evt.error ?? prev.error,
            }));
          }
        }
      }
    } catch (e) {
      setFinal((f) => ({
        ...f,
        error: (e as Error).message,
        overall: f.overall ?? "error",
      }));
    } finally {
      setRunning(false);
    }
  }, [repo, prNumber]);

  if (!live || dismissed) return null;

  const showResults =
    !running && (final.overall || final.error || final.passed || final.failed);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border bg-surface/60 p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
            DevPod sandbox
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            Run tests on PR #{prNumber}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            Clones, installs, tests, and (if green) starts a live preview in
            your DevPod.
          </div>
        </div>
        {!running && !showResults && (
          <button
            onClick={() => void start()}
            className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
          >
            🧪 Run sandbox test
          </button>
        )}
        {(running || showResults) && (
          <button
            onClick={() => setDismissed(true)}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted transition hover:text-foreground"
          >
            Dismiss
          </button>
        )}
      </div>

      {running && (
        <div className="mt-3 space-y-1.5">
          {STEPS.map(({ step, label }) => (
            <div key={step} className="flex items-center gap-2 text-xs">
              <StepDot status={stepStates[step]} />
              <span
                className={
                  stepStates[step] === "running"
                    ? "text-foreground"
                    : "text-muted"
                }
              >
                {label}
                {stepStates[step] === "running" && " — running…"}
                {stepStates[step] === "done" && " — done"}
                {stepStates[step] === "error" && " — failed"}
                {stepStates[step] === "skipped" && " — skipped"}
              </span>
            </div>
          ))}
        </div>
      )}

      {showResults && (
        <div className="mt-3 space-y-1.5 text-xs">
          {final.error && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-rose-200">
              {final.error}
            </div>
          )}
          <div className="flex items-center gap-2 text-foreground">
            {final.overall === "pass" && <span>✅</span>}
            {final.overall === "fail" && <span>❌</span>}
            {final.overall === "no_tests" && <span>🟡</span>}
            {final.overall === "error" && <span>⚠️</span>}
            <span>
              Tests: {final.passed} passed
              {final.failed > 0 ? `, ${final.failed} failed` : ""}
            </span>
          </div>
          {final.url && (
            <div className="text-foreground">
              🔗 Live preview:{" "}
              <a
                href={final.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted"
              >
                {final.url}
              </a>
            </div>
          )}
          <div className="text-muted">
            📊 Overall:{" "}
            {final.overall === "pass"
              ? "Pass"
              : final.overall === "fail"
                ? "Fail"
                : final.overall === "no_tests"
                  ? "No tests"
                  : "Error"}
            {final.duration_ms != null && (
              <span className="ml-1 text-muted">
                · {(final.duration_ms / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <button
            onClick={() => void start()}
            className="mt-2 inline-flex rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted transition hover:text-foreground"
          >
            Run again
          </button>
        </div>
      )}
    </motion.div>
  );
}
