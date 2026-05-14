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
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-3">
        Reviews per day (last 30 days)
      </div>
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
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "#57534e" }}
            width={28}
          />
          <Tooltip
            contentStyle={{
              fontSize: 12,
              fontFamily: "monospace",
              border: "1px solid #e7e5e4",
              borderRadius: 6,
              background: "#ffffff",
            }}
          />
          <Line
            type="monotone"
            dataKey="count"
            stroke="#4338ca"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
