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
import type { ActivityPoint } from "@/lib/types";

export function ActivityChart({ data }: { data: ActivityPoint[] }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
        Reviews per day (last 30 days)
      </div>
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
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "#8a8a8a" }}
            stroke="#1f1f1f"
            width={28}
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
          />
          <Line
            type="monotone"
            dataKey="count"
            stroke="#ffffff"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
