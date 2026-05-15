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

// Phase 7: accuracy-over-time chart for /learning. Same visual language as
// ActivityChart (so /learning and / overview feel like one product) but
// the y-axis is a 0–100 percent scale clamped explicitly.

export function AccuracyChart({ data }: { data: AccuracyTimePoint[] }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-3">
        Accuracy over time (last 90 days)
      </div>
      {data.length === 0 ? (
        <div className="h-[220px] flex items-center justify-center text-xs font-mono text-muted">
          no resolved observations yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart
            data={data}
            margin={{ top: 4, right: 12, left: 12, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#57534e" }}
              tickFormatter={(d: string) => d.slice(5)}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tick={{ fontSize: 11, fill: "#57534e" }}
              tickFormatter={(v: number) => `${v}%`}
              width={36}
            />
            <Tooltip
              contentStyle={{
                fontSize: 12,
                fontFamily: "monospace",
                border: "1px solid #e7e5e4",
                borderRadius: 6,
                background: "#ffffff",
              }}
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
              stroke="#16a34a"
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
