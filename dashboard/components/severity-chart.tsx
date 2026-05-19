"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SeverityBucket } from "@/lib/types";

// Severity histogram — re-themed for the dark v3 dashboard. Recharts
// has no built-in dark mode so colors are spelled out inline; they
// match the tokens in lib/design.ts.

const COLORS: Record<string, string> = {
  "1-3": "#4ade80",
  "4-6": "#f5c63a",
  "7-8": "#ff9d4d",
  "9-10": "#ff5252",
};

export function SeverityChart({ data }: { data: SeverityBucket[] }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
        Severity distribution (last 30 days)
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 12, left: 12, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" />
          <XAxis
            type="number"
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "#8a8a8a" }}
            stroke="#1f1f1f"
          />
          <YAxis
            type="category"
            dataKey="bucket"
            tick={{ fontSize: 12, fontFamily: "monospace", fill: "#ffffff" }}
            stroke="#1f1f1f"
            width={56}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            contentStyle={{
              fontSize: 12,
              fontFamily: "monospace",
              border: "1px solid #1f1f1f",
              borderRadius: 4,
              background: "#0a0a0a",
              color: "#ffffff",
            }}
            labelStyle={{ color: "#8a8a8a" }}
          />
          <Bar dataKey="count" radius={[0, 2, 2, 0]}>
            {data.map((d) => (
              <Cell key={d.bucket} fill={COLORS[d.bucket]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
