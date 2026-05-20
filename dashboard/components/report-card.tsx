"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { downloadReportDocx } from "@/lib/docx-report";
import { renderMarkdown } from "@/lib/markdown";
import type { PrReport } from "@/lib/types";

// ReportCard
//
// One row on /dashboard/reports. Renders the synthesis summary by
// default; expanding the card swaps in the full markdown body
// (rendered via lib/markdown.tsx). The download button is a plain
// anchor with a data: URI — no fetch round-trip, no server-side
// file generation, no temporary blob URL to clean up.
//
// Why a client component when most of the dashboard is server-
// rendered: the expand toggle needs local state. We keep the
// component as small as possible so its hydration cost stays
// negligible — the heavy data shaping happens server-side in
// /dashboard/reports/page.tsx; we just receive a finished PrReport
// and toggle visibility.

const REC_COLORS: Record<string, string> = {
  merge: "#58e684", // green
  request_changes: "#f6c25b", // amber
  reject: "#ff5a5a", // red
  needs_review: "#5bd3ff", // blue
  // Fallback for any legacy value the type permits but the spec doesn't
  // enumerate (e.g. an old row written before migration 018's CHECK was
  // tightened).
};

const ALIGN_COLORS: Record<string, string> = {
  aligned: "#58e684",
  neutral: "#9aa4b2",
  misaligned: "#ff5a5a",
  unknown: "#5bd3ff",
};

function truncate(text: string | null | undefined, n: number): string {
  if (!text) return "";
  if (text.length <= n) return text;
  return text.slice(0, n - 1).trimEnd() + "…";
}

interface ReportCardProps {
  report: PrReport;
}

export function ReportCard({ report }: ReportCardProps) {
  const [expanded, setExpanded] = useState(false);
  // Generating the .docx is asynchronous (Packer.toBlob is a
  // microtask chain through JSZip). The button disables itself
  // while building so we don't fire two parallel generations
  // from a double-click — Word would happily save both files,
  // but it wastes CPU on the user's machine.
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloadError(null);
    setDownloading(true);
    try {
      await downloadReportDocx(report);
    } catch (e) {
      setDownloadError(
        (e as Error).message ||
          "Could not generate .docx — see browser console for details.",
      );
    } finally {
      setDownloading(false);
    }
  };

  const rec = report.merge_recommendation ?? "needs_review";
  const recColor = REC_COLORS[rec] ?? "#9aa4b2";
  const align = report.vision_alignment ?? "unknown";
  const alignColor = ALIGN_COLORS[align] ?? "#9aa4b2";

  const created = new Date(report.created_at);
  // Locale-friendly: en-GB gives a stable day-first order without
  // depending on the visitor's locale. Time is in UTC because the
  // row's `created_at` is too.
  const createdLabel = created.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

  const hasMarkdown = !!report.report_markdown && report.report_markdown.trim().length > 0;
  const prHref = `https://github.com/${report.repo}/pull/${report.pr_number}`;
  const testsLabel =
    `${report.sandbox_tests_passed ?? 0} passed` +
    ((report.sandbox_tests_failed ?? 0) > 0
      ? `, ${report.sandbox_tests_failed} failed`
      : "");
  const buildLabel =
    report.sandbox_build_success === true
      ? "Build OK"
      : report.sandbox_build_success === false
        ? "Build failed"
        : "Build not run";
  const sandboxLabel =
    report.sandbox_overall && report.sandbox_overall !== "not_run"
      ? report.sandbox_overall
      : "no sandbox";

  return (
    <Card className="space-y-3 p-5" tone="default">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
            <span>{report.repo}</span>
            <span>·</span>
            <span>{createdLabel} UTC</span>
          </div>
          <div className="mt-1 truncate text-base font-semibold text-white">
            <a
              href={prHref}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              title="Open PR on GitHub"
            >
              {report.pr_title || `PR #${report.pr_number}`}
            </a>{" "}
            <span className="text-muted">#{report.pr_number}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge color={recColor} variant="solid">
            {rec.replace(/_/g, " ")}
          </Badge>
          {report.merge_confidence && (
            <Badge color={recColor} variant="outline">
              {report.merge_confidence} conf
            </Badge>
          )}
          <Badge color={alignColor} variant="subtle">
            vision: {align}
          </Badge>
        </div>
      </div>

      {report.what_it_adds && (
        <p className="text-sm leading-relaxed text-muted-strong">
          {truncate(report.what_it_adds, 220)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono uppercase tracking-[0.12em] text-muted">
        <span>tests: {testsLabel}</span>
        <span>·</span>
        <span>{buildLabel}</span>
        <span>·</span>
        <span>sandbox: {sandboxLabel}</span>
        {report.review_severity != null && (
          <>
            <span>·</span>
            <span>review severity: {report.review_severity}/10</span>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {report.sandbox_app_url && (
          <a
            href={report.sandbox_app_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/20"
          >
            🔗 Live Preview
            <span className="text-[10px] opacity-70">↗</span>
          </a>
        )}
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={downloading}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-white transition hover:border-border-strong disabled:cursor-wait disabled:opacity-60"
        >
          {downloading ? "📄 Building .docx…" : "📥 Download .docx"}
        </button>
        {hasMarkdown && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-strong transition hover:border-border-strong hover:text-white"
          >
            {expanded ? "Hide full report" : "View full report"}
            <span className="text-[10px] opacity-70">
              {expanded ? "▲" : "▼"}
            </span>
          </button>
        )}
      </div>

      {downloadError && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
          {downloadError}
        </div>
      )}

      {expanded && hasMarkdown && (
        <div className="rounded-md border border-border bg-bg-elev/60 p-4">
          {renderMarkdown(report.report_markdown)}
        </div>
      )}
    </Card>
  );
}
