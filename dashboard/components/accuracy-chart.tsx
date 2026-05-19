"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AccuracyTimePoint } from "@/lib/types";

// Phase 7: accuracy-over-time chart for /learning. Same visual language
// as ActivityChart so /learning and /overview feel coherent.

export function AccuracyChart({ data }: { data: AccuracyTimePoint[] }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
        Accuracy over time (last 90 days)
      </div>
      {data.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center font-mono text-xs text-muted">
          no resolved observations yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart
            data={data}
            margin={{ top: 4, right: 12, left: 12, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#8a8a8a" }}
              stroke="#1f1f1f"
              tickFormatter={(d: string) => d.slice(5)}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tick={{ fontSize: 11, fill: "#8a8a8a" }}
              stroke="#1f1f1f"
              tickFormatter={(v: number) => `${v}%`}
              width={36}
            />
            <Tooltip
              contentStyle={{
                fontSize: 12,
                fontFamily: "monospace",
                border: "1px solid #1f1f1f",
                borderRadius: 4,
                background: "#0a0a0a",
                color: "#ffffff",
              }}
              labelStyle={{ color: "#8a8a8a" }}
              formatter={(value, _name, item) => {
                const pct = typeof value === "number" ? value : Number(value);
                const total = (item?.payload as AccuracyTimePoint | undefined)
                  ?.total;
                const label =
                  total !== undefined
                    ? `${pct.toFixed(0)}% (n=${total})`
                    : `${pct.toFixed(0)}%`;
                return [label, "accuracy"];
              }}
            />
            <Line
              type="monotone"
              dataKey="accuracy_pct"
              stroke="#4ade80"
              strokeWidth={2}
              dot={{ r: 2 }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
