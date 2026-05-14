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

const COLORS: Record<string, string> = {
  "1-3": "#16a34a",
  "4-6": "#ca8a04",
  "7-8": "#ea580c",
  "9-10": "#dc2626",
};

export function SeverityChart({ data }: { data: SeverityBucket[] }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-3">
        Severity distribution (last 30 days)
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 12, left: 12, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
          <XAxis
            type="number"
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "#57534e" }}
          />
          <YAxis
            type="category"
            dataKey="bucket"
            tick={{ fontSize: 12, fontFamily: "monospace", fill: "#1c1917" }}
            width={56}
          />
          <Tooltip
            cursor={{ fill: "#fafaf9" }}
            contentStyle={{
              fontSize: 12,
              fontFamily: "monospace",
              border: "1px solid #e7e5e4",
              borderRadius: 6,
              background: "#ffffff",
            }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]}>
            {data.map((d) => (
              <Cell key={d.bucket} fill={COLORS[d.bucket]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
