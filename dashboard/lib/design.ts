import type { Verdict } from "./types";

// Visual tokens used by React components in the dashboard. The agent's
// send_digest.py keeps its own light-mode palette (digests render in
// email clients we don't control), so this file deliberately diverges:
// the dashboard is dark-mode E2B-style, the digest stays light-mode.
//
// Keep these in sync with globals.css `@theme inline` if you add new
// colors — Tailwind only reads classes there, but inline `style={…}`
// references in components read from this file.

export const palette = {
  bg: "#000000",
  card: "#0a0a0a",
  border: "#1f1f1f",
  text: "#ffffff",
  muted: "#8a8a8a",
  accent: "#ffffff",
} as const;

export const severityColors = {
  critical: "#ff5252", // 9-10
  serious: "#ff9d4d",  // 7-8
  moderate: "#f5c63a", // 4-6
  clean: "#4ade80",    // 1-3
} as const;

export const verdictColors = {
  approve: "#4ade80",
  request_changes: "#ff5252",
  comment: "#60a5fa",
} as const;

export function severityColor(score: number | null | undefined): string {
  if (typeof score !== "number") return palette.muted;
  if (score >= 9) return severityColors.critical;
  if (score >= 7) return severityColors.serious;
  if (score >= 4) return severityColors.moderate;
  return severityColors.clean;
}

export function severityBucket(score: number): "1-3" | "4-6" | "7-8" | "9-10" {
  if (score >= 9) return "9-10";
  if (score >= 7) return "7-8";
  if (score >= 4) return "4-6";
  return "1-3";
}

export interface VerdictMeta {
  color: string;
  label: string;
}

export function verdictBadge(verdict: Verdict | string): VerdictMeta {
  switch (verdict) {
    case "approve":
      return { color: verdictColors.approve, label: "✓ approve" };
    case "request_changes":
      return { color: verdictColors.request_changes, label: "✕ request changes" };
    case "comment":
      return { color: verdictColors.comment, label: "💬 comment" };
    default:
      return { color: palette.muted, label: String(verdict) };
  }
}

// Sonnet pricing: $3 / 1M input tokens, $15 / 1M output tokens.
export function tokenCostUSD(
  input: number | null | undefined,
  output: number | null | undefined,
): number {
  const i = input ?? 0;
  const o = output ?? 0;
  return (i * 3 + o * 15) / 1_000_000;
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

export function formatRelativeTime(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  return `${Math.floor(diffMo / 12)}y ago`;
}

export function formatDuration(
  startISO: string,
  endISO: string | null,
): string {
  if (!endISO) return "running…";
  const startMs = new Date(startISO).getTime();
  const endMs = new Date(endISO).getTime();
  const sec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}m ${s}s`;
}
