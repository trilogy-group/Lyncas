"use client";

import { motion } from "framer-motion";
import { severityColors } from "@/lib/design";

// MetricCard — KPI tile for the /dashboard/overview analytics row.
//
// Extends the plain StatCard idea with the two things the analytics
// mockup needs: a top-right monogram glyph and a period-over-period
// delta pill (▲12% / ▼0.4). Kept separate from ui/StatCard so the
// simpler tile stays simple for the pages that only need a number.
//
// The delta pill is colored by *goodness*, not raw direction: for most
// metrics "up" is good (green), but for severity "down" is good. The
// `lowerIsBetter` flag flips that mapping. A null/zero delta renders no
// pill at all (e.g. brand-new metric with no prior window).

const EASE = [0.16, 1, 0.3, 1] as const;

export type GlyphName =
  | "comment"
  | "bolt"
  | "alert"
  | "dollar"
  | "gauge";

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  /** Pre-formatted delta text, e.g. "12%" or "0.4". */
  deltaText?: string | null;
  /** Raw signed delta — drives the arrow direction + good/bad color. */
  delta?: number | null;
  /** Flip the color mapping so a downward delta reads as good. */
  lowerIsBetter?: boolean;
  glyph?: GlyphName;
  /** Color the value (used when a metric crosses a threshold). */
  accent?: string;
}

export function MetricCard({
  label,
  value,
  hint,
  deltaText,
  delta,
  lowerIsBetter = false,
  glyph,
  accent,
}: MetricCardProps) {
  const hasDelta =
    deltaText != null && typeof delta === "number" && delta !== 0;
  const up = (delta ?? 0) > 0;
  const good = lowerIsBetter ? !up : up;
  const deltaColor = good ? severityColors.clean : severityColors.critical;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.45, ease: EASE }}
      className="group relative overflow-hidden rounded-md border border-border bg-card p-4 transition-colors hover:border-border-strong"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          {label}
        </span>
        {glyph && (
          <span className="text-muted/50 transition-colors group-hover:text-muted">
            <Glyph name={glyph} />
          </span>
        )}
      </div>

      <div className="mt-3 flex items-end gap-2">
        <span
          className="font-mono text-[30px] font-semibold leading-none tabular-nums"
          style={accent ? { color: accent } : undefined}
        >
          {value}
        </span>
        {hasDelta && (
          <span
            className="mb-0.5 inline-flex items-center gap-0.5 font-mono text-[11px] tabular-nums"
            style={{ color: deltaColor }}
          >
            <span aria-hidden>{up ? "▲" : "▼"}</span>
            {deltaText}
          </span>
        )}
      </div>

      {hint && (
        <div className="mt-2 text-[10px] font-mono uppercase tracking-[0.14em] text-muted">
          {hint}
        </div>
      )}
    </motion.div>
  );
}

function Glyph({ name }: { name: GlyphName }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "comment":
      return (
        <svg {...common}>
          <path d="M2.5 3.5h11v7h-6l-3 2.5V10.5h-2z" />
        </svg>
      );
    case "bolt":
      return (
        <svg {...common}>
          <path d="M8.5 1.5L3 9h4l-.5 5.5L13 7H9z" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common}>
          <path d="M8 1.8L14.5 13.5h-13z" />
          <path d="M8 6.2v3.4M8 11.6v.1" />
        </svg>
      );
    case "dollar":
      return (
        <svg {...common}>
          <path d="M8 1.5v13M10.8 4.2c-.7-.8-1.8-1.1-2.8-1.1-1.7 0-3 .9-3 2.4 0 3.4 6 1.7 6 5.1 0 1.6-1.4 2.5-3.2 2.5-1.2 0-2.4-.4-3.1-1.3" />
        </svg>
      );
    case "gauge":
      return (
        <svg {...common}>
          <path d="M2 11a6 6 0 1 1 12 0" />
          <path d="M8 11l3-3.5" />
        </svg>
      );
  }
}
