"use client";

import { motion } from "framer-motion";

// StatCard — single-number panel with a subtle hover lift.
//
// Typography:
//   * label: tiny all-caps mono, muted
//   * value: chunky mono (semibold for hierarchy), tabular-nums so
//     columns of numbers align cleanly
//   * hint:  one-line caption underneath
//
// The accent prop colors only the value — labels and hints stay
// neutral so the eye lands on the number first.

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
  /** Inverted card — white background, black text. Use sparingly to
   *  call out the single most important number on a page. */
  invert?: boolean;
}

const EASE = [0.16, 1, 0.3, 1] as const;

export function StatCard({ label, value, hint, accent, invert }: StatCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.45, ease: EASE }}
      className={
        "rounded-md border p-5 transition-colors " +
        (invert
          ? "bg-white text-black border-white hover:bg-white/95"
          : "bg-card text-text border-border hover:border-border-strong")
      }
    >
      <div
        className={
          "text-[10px] font-mono uppercase tracking-[0.18em] " +
          (invert ? "text-black/60" : "text-muted")
        }
      >
        {label}
      </div>
      <div
        className={
          "mt-3 text-[34px] font-mono font-semibold leading-none tabular-nums " +
          (invert ? "" : "")
        }
        style={accent && !invert ? { color: accent } : undefined}
      >
        {value}
      </div>
      {hint && (
        <div
          className={
            "mt-2 text-xs font-mono " + (invert ? "text-black/60" : "text-muted")
          }
        >
          {hint}
        </div>
      )}
    </motion.div>
  );
}
