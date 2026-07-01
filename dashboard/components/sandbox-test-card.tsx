"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { downloadReportDocx } from "@/lib/docx-report";
import { renderMarkdown } from "@/lib/markdown";
import type {
  DevpodStatusResponse,
  PrReport,
  SandboxChecks,
  SandboxProgressEvent,
  SandboxStep,
  SandboxVerdict,
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
//
// New in v2 (build + multi-stack support):
//   * "Build" is its own step row (between Tests and App) — a passing
//     test suite with a broken `npm run build` still blocks merge,
//     so we make it visible as a first-class signal.
//   * The live-preview URL is a prominent button (not buried in a
//     paragraph of muted text) when the app booted with a reachable
//     port. Mirrors the GitHub PR comment's "🔗 Open Live Preview".
//   * The build output collapses into a <details>/<pre> block when
//     the build failed, so the user can see the webpack/tsc stderr
//     without leaving the chat.
//   * The overall verdict gets a color-coded pill instead of a bare
//     emoji: green for `pass*`, yellow for `no_tests`, red for the
//     two failure verdicts, grey for `error`.

const STEPS: ReadonlyArray<{
  step: Exclude<SandboxStep, "complete">;
  label: string;
}> = [
  { step: "clone", label: "Clone PR branch" },
  { step: "install", label: "Install dependencies" },
  { step: "lint", label: "Lint" },
  { step: "typecheck", label: "Type-check" },
  { step: "security", label: "Security (secrets · audit)" },
  { step: "tests", label: "Run tests" },
  { step: "build", label: "Build" },
  { step: "app", label: "Start app & open preview" },
];

interface FinalResult {
  // The rich verdict from the SSE complete event. Persisted DB
  // overall is a strict subset of this; we don't try to recover
  // pass_no_preview / tests_failed / build_failed from the DB on
  // page reload because the upsert mapped them down already.
  verdict: SandboxVerdict | null;
  passed: number;
  failed: number;
  url: string | null;
  duration_ms: number | null;
  cloneSuccess: boolean | null;
  installSuccess: boolean | null;
  testsSuccess: boolean | null;
  buildAttempted: boolean;
  buildSuccess: boolean | null;
  buildOutput: string | null;
  appStarted: boolean | null;
  // Phase 1 preview gate. gatePassed === false means the live preview
  // was intentionally withheld (e.g. tests failed); gateReason explains.
  gatePassed: boolean | null;
  gateReason: string | null;
  // Phase 3 structured quality checks, populated on the complete event.
  checks: SandboxChecks | null;
  error: string | null;
}

const INITIAL_FINAL: FinalResult = {
  verdict: null,
  passed: 0,
  failed: 0,
  url: null,
  duration_ms: null,
  cloneSuccess: null,
  installSuccess: null,
  testsSuccess: null,
  buildAttempted: false,
  buildSuccess: null,
  buildOutput: null,
  appStarted: null,
  gatePassed: null,
  gateReason: null,
  checks: null,
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

// Verdict → visual mapping for the final results pill.
// Color buckets:
//   green  — pass, pass_no_preview (build + tests both green)
//   yellow — no_tests (build OK; tests absent)
//   red    — build_failed, tests_failed
//   grey   — error (clone / install bombed; the run never reached
//                   a meaningful PR-relevant signal)
function verdictStyle(v: SandboxVerdict | null): {
  pillClass: string;
  icon: string;
  label: string;
} {
  switch (v) {
    case "pass":
      return {
        pillClass:
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
        icon: "✅",
        label: "Pass — preview live",
      };
    case "pass_no_preview":
      return {
        pillClass:
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
        icon: "✅",
        label: "Pass — preview unavailable",
      };
    case "no_tests":
      return {
        pillClass: "border-amber-500/40 bg-amber-500/10 text-amber-200",
        icon: "🟡",
        label: "Build OK — no tests found",
      };
    case "tests_failed":
      return {
        pillClass: "border-rose-500/40 bg-rose-500/10 text-rose-200",
        icon: "❌",
        label: "Tests failed",
      };
    case "build_failed":
      return {
        pillClass: "border-rose-500/40 bg-rose-500/10 text-rose-200",
        icon: "❌",
        label: "Build failed",
      };
    case "security_failed":
      return {
        pillClass: "border-rose-500/40 bg-rose-500/10 text-rose-200",
        icon: "🔑",
        label: "Secret detected in diff",
      };
    case "error":
    default:
      return {
        pillClass: "border-border bg-muted/20 text-muted",
        icon: "⚠️",
        label: "Sandbox error",
      };
  }
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
      lint: "pending",
      typecheck: "pending",
      security: "pending",
      tests: "pending",
      build: "pending",
      app: "pending",
      complete: "pending",
    }),
  );
  const [final, setFinal] = useState<FinalResult>(INITIAL_FINAL);
  const [dismissed, setDismissed] = useState(false);
  const [buildExpanded, setBuildExpanded] = useState(false);

  // Report modal state (migration 018). Lazy-loaded on first
  // click so we don't hit /api/reports until the user actually
  // asks for it — the report row may not even exist yet (the
  // generator runs ~45s after the sandbox, plus a Claude call).
  const [reportOpen, setReportOpen] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [report, setReport] = useState<PrReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  // Per-report download state. Independent from the modal-open /
  // load states because building the .docx (Packer.toBlob ->
  // JSZip chain) is meaningfully async and we want the button to
  // signal "working…" without freezing the rest of the modal.
  const [reportDownloading, setReportDownloading] = useState(false);
  const [reportDownloadError, setReportDownloadError] = useState<string | null>(
    null,
  );

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

  const resetSteps = useCallback(
    (): Record<SandboxStep, StepStatus> => ({
      clone: "pending",
      install: "pending",
      lint: "pending",
      typecheck: "pending",
      security: "pending",
      tests: "pending",
      build: "pending",
      app: "pending",
      complete: "pending",
    }),
    [],
  );

  // Reset state when the chat moves to a different PR.
  const lastKeyRef = useRef("");
  useEffect(() => {
    const k = `${repo}#${prNumber}`;
    if (lastKeyRef.current && lastKeyRef.current !== k) {
      setRunning(false);
      setStepStates(resetSteps());
      setFinal(INITIAL_FINAL);
      setDismissed(false);
      setBuildExpanded(false);
      // Drop any cached report from the previous PR — its content
      // is meaningless for the new PR even if both are in the
      // same repo.
      setReportOpen(false);
      setReport(null);
      setReportError(null);
      setReportLoading(false);
      setReportDownloading(false);
      setReportDownloadError(null);
    }
    lastKeyRef.current = k;
  }, [repo, prNumber, resetSteps]);

  // Lazy-load the report on demand. Encodes the repo path because
  // Next.js route segments can't contain a literal slash, so the
  // /api/reports/[repo]/[pr_number] route expects an encoded
  // "owner%2Fname".
  const openReport = useCallback(async () => {
    setReportOpen(true);
    if (report || reportLoading) return;
    setReportLoading(true);
    setReportError(null);
    try {
      const r = await fetch(
        `/api/reports/${encodeURIComponent(repo)}/${prNumber}`,
        { cache: "no-store" },
      );
      if (r.status === 404) {
        setReportError(
          "Report not generated yet. Reports are produced ~45 seconds after a PR webhook fires; check back in a moment.",
        );
        return;
      }
      if (!r.ok) {
        setReportError(`Could not load report (HTTP ${r.status}).`);
        return;
      }
      const data = (await r.json()) as { report?: PrReport };
      if (!data.report) {
        setReportError("Report response was empty.");
        return;
      }
      setReport(data.report);
    } catch (e) {
      setReportError((e as Error).message);
    } finally {
      setReportLoading(false);
    }
  }, [repo, prNumber, report, reportLoading]);

  // Esc closes the modal. We attach the listener only while the
  // modal is open so we don't compete with the chat input's
  // keyboard handling.
  useEffect(() => {
    if (!reportOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setReportOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reportOpen]);

  // Build + download the .docx. Defensive about double-clicks
  // and surfaces any generation error inline in the modal —
  // throwing here would silently swallow into the click handler.
  const handleDocxDownload = useCallback(async () => {
    if (!report || reportDownloading) return;
    setReportDownloadError(null);
    setReportDownloading(true);
    try {
      await downloadReportDocx(report);
    } catch (e) {
      setReportDownloadError(
        (e as Error).message ||
          "Could not generate .docx — see browser console for details.",
      );
    } finally {
      setReportDownloading(false);
    }
  }, [report, reportDownloading]);

  const start = useCallback(async () => {
    setRunning(true);
    setDismissed(false);
    setFinal(INITIAL_FINAL);
    setBuildExpanded(false);
    setStepStates(resetSteps());

    let res: Response;
    try {
      res = await fetch("/api/devpod/run-pr-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, pr_number: prNumber }),
      });
    } catch (e) {
      setFinal((f) => ({
        ...f,
        error: (e as Error).message,
        verdict: "error",
      }));
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
      setFinal((f) => ({ ...f, error: msg, verdict: "error" }));
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
              verdict: evt.overall ?? prev.verdict ?? "error",
              url: evt.url ?? prev.url,
              duration_ms: evt.duration_ms ?? prev.duration_ms,
              gatePassed: evt.gate_passed ?? prev.gatePassed,
              gateReason: evt.gate_reason ?? prev.gateReason,
              checks: evt.checks ?? prev.checks,
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
              installSuccess:
                evt.step === "install" ? !!evt.success : prev.installSuccess,
              testsSuccess:
                evt.step === "tests" ? !!evt.success : prev.testsSuccess,
              buildAttempted:
                evt.step === "build"
                  ? prev.buildAttempted || !!evt.success || evt.success === false
                  : prev.buildAttempted,
              buildSuccess:
                evt.step === "build" ? !!evt.success : prev.buildSuccess,
              buildOutput:
                evt.step === "build"
                  ? evt.build_output ?? prev.buildOutput
                  : prev.buildOutput,
              appStarted:
                evt.step === "app" ? !!evt.success : prev.appStarted,
            }));
          } else if (evt.status === "error") {
            setStepStates((s) => ({ ...s, [evt.step]: "error" }));
            setFinal((prev) => ({
              ...prev,
              error: evt.error ?? prev.error,
              cloneSuccess:
                evt.step === "clone" ? false : prev.cloneSuccess,
              installSuccess:
                evt.step === "install" ? false : prev.installSuccess,
              testsSuccess:
                evt.step === "tests" ? false : prev.testsSuccess,
              buildAttempted:
                evt.step === "build" ? true : prev.buildAttempted,
              buildSuccess:
                evt.step === "build" ? false : prev.buildSuccess,
              buildOutput:
                evt.step === "build"
                  ? evt.build_output ?? prev.buildOutput
                  : prev.buildOutput,
              appStarted:
                evt.step === "app" ? false : prev.appStarted,
            }));
          }
        }
      }
    } catch (e) {
      setFinal((f) => ({
        ...f,
        error: (e as Error).message,
        verdict: f.verdict ?? "error",
      }));
    } finally {
      setRunning(false);
    }
  }, [repo, prNumber, resetSteps]);

  if (!live || dismissed) return null;

  const showResults =
    !running &&
    (final.verdict || final.error || final.passed || final.failed);

  const vstyle = verdictStyle(final.verdict);

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
            Clones, installs, tests, builds, and (if green) starts a live
            preview in your DevPod.
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
        <div className="mt-3 space-y-2 text-xs">
          {final.error && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-rose-200">
              {final.error}
            </div>
          )}

          {/* Color-coded overall verdict pill */}
          <div
            className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 ${vstyle.pillClass}`}
          >
            <span>{vstyle.icon}</span>
            <span className="font-medium">{vstyle.label}</span>
            {final.duration_ms != null && (
              <span className="text-[10px] opacity-70">
                · {(final.duration_ms / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {/* Per-step summary rows */}
          <div className="space-y-1 pt-1 text-foreground">
            <SummaryRow
              ok={final.cloneSuccess}
              label="Clone"
            />
            <SummaryRow
              ok={final.installSuccess}
              label="Install"
            />
            <SummaryRow
              ok={final.testsSuccess}
              label={`Tests — ${final.passed} passed${
                final.failed > 0 ? `, ${final.failed} failed` : ""
              }`}
            />
            <SummaryRow
              ok={final.buildAttempted ? final.buildSuccess : null}
              label={
                final.buildAttempted
                  ? final.buildSuccess
                    ? "Build"
                    : "Build — failed"
                  : "Build — skipped"
              }
            />
            <SummaryRow
              ok={final.appStarted}
              label={
                final.appStarted
                  ? final.url
                    ? "App — running with preview"
                    : "App — started, preview unavailable"
                  : final.gatePassed === false
                    ? "App — preview withheld"
                    : "App — not started"
              }
            />
          </div>

          {final.checks && <ChecksSummary checks={final.checks} />}

          {/* Preview withheld by the gate (Phase 1). Shown when the
              sandbox deliberately skipped the live preview because the
              PR didn't pass its checks. */}
          {final.gatePassed === false && !final.url && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-amber-100">
              <span className="font-medium">🔒 Preview withheld</span>
              {final.gateReason ? ` — ${final.gateReason}.` : "."}{" "}
              <span className="opacity-80">
                Fix the issue and re-run to get a live preview.
              </span>
            </div>
          )}

          {/* Prominent live-preview button */}
          {final.url && (
            <a
              href={final.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/25"
            >
              🔗 Open Live Preview
              <span className="text-[10px] opacity-70">↗</span>
            </a>
          )}

          {/* Collapsible build output — render when there's any
              build output to show. Auto-expanded on build_failed
              so the user doesn't have to click to see the stderr
              that already broke their PR. */}
          {final.buildAttempted && final.buildOutput && (
            <div className="rounded-md border border-border bg-background/40">
              <button
                onClick={() => setBuildExpanded((v) => !v)}
                className="flex w-full items-center justify-between px-2 py-1.5 text-[11px] uppercase tracking-wider text-muted transition hover:text-foreground"
              >
                <span>
                  Build output {final.buildSuccess === false && "(failed)"}
                </span>
                <span>
                  {buildExpanded || final.buildSuccess === false ? "▾" : "▸"}
                </span>
              </button>
              {(buildExpanded || final.buildSuccess === false) && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-b-md bg-background/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground/90">
                  {final.buildOutput}
                </pre>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={() => void start()}
              className="inline-flex rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted transition hover:text-foreground"
            >
              Run again
            </button>
            <button
              onClick={() => void openReport()}
              className="inline-flex rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted transition hover:text-foreground"
            >
              📊 View Report
            </button>
          </div>
        </div>
      )}

      {/* Report modal — overlays the chat while open. We use a
          plain fixed-position div instead of a portal: the chat
          page's layout doesn't have a scoped stacking context,
          so a top-level fixed wrapper renders correctly above
          everything else. */}
      {reportOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setReportOpen(false)}
        >
          <div
            className="my-8 w-full max-w-3xl rounded-xl border border-border bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="text-sm font-semibold text-foreground">
                📊 PR Report — {repo} #{prNumber}
              </div>
              <button
                onClick={() => setReportOpen(false)}
                aria-label="Close report"
                className="rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted transition hover:text-foreground"
              >
                Close (Esc)
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
              {reportLoading && (
                <div className="text-sm text-muted">Loading report…</div>
              )}
              {reportError && !reportLoading && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  {reportError}
                </div>
              )}
              {report && !reportLoading && !reportError && (
                <div className="space-y-3">
                  {/* Quick metadata strip — recommendation +
                      preview link if any. Kept compact so the
                      markdown body below it stays the focus. */}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-strong">
                    {report.merge_recommendation && (
                      <span className="rounded-sm border border-border px-2 py-0.5 font-mono uppercase tracking-[0.12em]">
                        {report.merge_recommendation.replace(/_/g, " ")}
                      </span>
                    )}
                    {report.merge_confidence && (
                      <span className="font-mono uppercase tracking-[0.12em] text-muted">
                        {report.merge_confidence} confidence
                      </span>
                    )}
                    {report.sandbox_app_url && (
                      <a
                        href={report.sandbox_app_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-500/20"
                      >
                        🔗 Live Preview ↗
                      </a>
                    )}
                  </div>
                  {report.report_markdown ? (
                    renderMarkdown(report.report_markdown)
                  ) : (
                    <div className="text-sm text-muted">
                      Report has no markdown body.
                    </div>
                  )}
                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleDocxDownload()}
                        disabled={reportDownloading}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-border-strong disabled:cursor-wait disabled:opacity-60"
                      >
                        {reportDownloading
                          ? "📄 Building .docx…"
                          : "📥 Download .docx"}
                      </button>
                      <a
                        href="/dashboard/reports"
                        className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground"
                      >
                        Open Reports dashboard →
                      </a>
                    </div>
                    {reportDownloadError && (
                      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
                        {reportDownloadError}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function SummaryRow({
  ok,
  label,
}: {
  ok: boolean | null;
  label: string;
}) {
  const icon = ok === true ? "✅" : ok === false ? "❌" : "⏭";
  return (
    <div className="flex items-center gap-2">
      <span className="w-4 text-center">{icon}</span>
      <span>{label}</span>
    </div>
  );
}

// --- Phase 3: quality-checks breakdown -----------------------------------
// Renders the lint / type-check / audit / SAST / secrets / coverage results
// the SSE complete event carried. Advisory checks (everything but secrets)
// show ⚠️ on failure; the blocking secret scan shows ❌. "skip" is neutral.
function CheckRow({
  label,
  status,
  detail,
  blocking = false,
}: {
  label: string;
  status: "pass" | "fail" | "skip" | "ok";
  detail?: string;
  blocking?: boolean;
}) {
  const icon =
    status === "pass" || status === "ok"
      ? "✅"
      : status === "skip"
        ? "⏭"
        : blocking
          ? "❌"
          : "⚠️";
  return (
    <div className="flex items-center gap-2">
      <span className="w-4 text-center">{icon}</span>
      <span className="text-muted">{label}</span>
      {detail && <span className="text-foreground/70">— {detail}</span>}
    </div>
  );
}

function ChecksSummary({ checks }: { checks: SandboxChecks }) {
  const sec = checks.security ?? {};
  const secrets = sec.secrets;
  const cov = checks.coverage;
  const rows: ReactNode[] = [];

  if (checks.lint)
    rows.push(
      <CheckRow
        key="lint"
        label={`Lint (${checks.lint.tool})`}
        status={checks.lint.status}
        detail={checks.lint.status === "fail" ? checks.lint.summary : undefined}
      />,
    );
  if (checks.typecheck)
    rows.push(
      <CheckRow
        key="typecheck"
        label={`Type-check (${checks.typecheck.tool})`}
        status={checks.typecheck.status}
        detail={
          checks.typecheck.status === "fail"
            ? checks.typecheck.summary
            : undefined
        }
      />,
    );
  if (sec.audit)
    rows.push(
      <CheckRow
        key="audit"
        label={`Dependency audit (${sec.audit.tool})`}
        status={sec.audit.status}
      />,
    );
  if (sec.sast)
    rows.push(
      <CheckRow
        key="sast"
        label="SAST (semgrep)"
        status={sec.sast.status}
        detail={sec.sast.status === "skip" ? sec.sast.summary : undefined}
      />,
    );
  if (secrets)
    rows.push(
      <CheckRow
        key="secrets"
        label="Secret scan"
        status={secrets.status}
        blocking
        detail={
          secrets.status === "fail"
            ? `${secrets.count} in diff`
            : secrets.status === "pass"
              ? "none in diff"
              : undefined
        }
      />,
    );
  if (cov?.status === "ok" && cov.pct != null)
    rows.push(
      <CheckRow key="cov" label="Coverage" status="ok" detail={`${cov.pct}%`} />,
    );

  const gen = checks.generated;
  if (gen && (gen.status !== "skip" || gen.written > 0)) {
    const fw = gen.framework && gen.framework !== "n/a" ? ` (${gen.framework})` : "";
    rows.push(
      <CheckRow
        key="generated"
        label={`Generated tests${fw}`}
        status={gen.status}
        detail={
          gen.status === "pass"
            ? `${gen.passed} passed · advisory`
            : `${gen.summary} · advisory`
        }
      />,
    );
    if (gen.autofix?.status === "opened") {
      rows.push(
        <CheckRow
          key="autofix"
          label="↳ Auto-fix PR"
          status="ok"
          detail={
            gen.autofix.pr_number
              ? `#${gen.autofix.pr_number} opened (${gen.autofix.confidence ?? ""})`
              : "opened"
          }
        />,
      );
    }
  }

  if (!rows.length) return null;

  return (
    <div className="space-y-1 rounded-md border border-border bg-background/30 px-2.5 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
        Quality checks
        {checks.diff && ` · ${checks.diff.changed_files} files changed`}
      </div>
      <div className="space-y-1 pt-0.5">{rows}</div>
      {secrets?.findings && secrets.findings.length > 0 && (
        <div className="mt-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-rose-200">
          <div className="font-medium">🔑 Potential secrets:</div>
          <ul className="mt-0.5 list-inside list-disc">
            {secrets.findings.slice(0, 6).map((f) => (
              <li key={f} className="font-mono text-[10px]">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
