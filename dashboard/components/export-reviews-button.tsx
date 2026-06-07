"use client";

import { useCallback } from "react";
import type { Review } from "@/lib/types";

// ExportReviewsButton — client-side CSV export of the currently-loaded
// reviews page. Deliberately exports exactly what's on screen (the
// filtered/paged slice) rather than re-querying, so the download always
// matches what the user is looking at.

const COLUMNS: Array<[keyof Review, string]> = [
  ["repo", "repo"],
  ["pr_number", "pr_number"],
  ["pr_title", "pr_title"],
  ["verdict", "verdict"],
  ["confidence", "confidence"],
  ["severity_score", "severity"],
  ["action", "action"],
  ["created_at", "created_at"],
];

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ExportReviewsButton({ reviews }: { reviews: Review[] }) {
  const onClick = useCallback(() => {
    const header = COLUMNS.map(([, h]) => h).join(",");
    const rows = reviews.map((r) =>
      COLUMNS.map(([k]) => csvCell(r[k])).join(","),
    );
    const blob = new Blob([[header, ...rows].join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lyncas-reviews-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [reviews]);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={reviews.length === 0}
      className="inline-flex items-center gap-2 rounded-sm border border-border bg-bg px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.16em] text-text transition-colors hover:border-border-strong hover:bg-bg-elev disabled:cursor-not-allowed disabled:opacity-40"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M8 1.5v8.5M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11" />
      </svg>
      Export
    </button>
  );
}
