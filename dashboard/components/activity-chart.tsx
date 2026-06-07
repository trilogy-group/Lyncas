"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartPanel } from "@/components/ui/chart-panel";
import type { ActivityPoint } from "@/lib/types";

// Reviews-per-day area chart. Amber fill (severity-serious token) keeps
// the only chromatic accent inside the app's semantic set while giving
// the activity surface the warm glow from the analytics mockup.

const ACCENT = "#ffa760";

export function ActivityChart({
  data,
  days = 30,
}: {
  data: ActivityPoint[];
  days?: number;
}) {
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <ChartPanel title="Activity" hint={`reviews / day · ${days}d`}>
      {total === 0 ? (
        <EmptyChart label="no reviews in this window" />
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart
            data={data}
            margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="2 4"
              stroke="#232323"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#9a9a9a", fontFamily: "monospace" }}
              stroke="#232323"
              tickLine={false}
              minTickGap={28}
              tickFormatter={(d: string) => d.slice(5).replace("-", "/")}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 10, fill: "#9a9a9a", fontFamily: "monospace" }}
              stroke="#232323"
              tickLine={false}
              axisLine={false}
              width={28}
            />
            <Tooltip
              cursor={{ stroke: "#3a3a3a", strokeDasharray: "3 3" }}
              contentStyle={{
                fontSize: 12,
                fontFamily: "monospace",
                border: "1px solid #232323",
                borderRadius: 4,
                background: "#0a0a0a",
                color: "#ffffff",
                padding: "4px 8px",
              }}
              labelStyle={{ color: "#9a9a9a" }}
              labelFormatter={(d) => String(d).slice(5).replace("-", "/")}
              formatter={(value) => [String(value), "reviews"]}
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke={ACCENT}
              strokeWidth={2}
              fill="url(#activityFill)"
              dot={false}
              activeDot={{ r: 3, fill: ACCENT, stroke: "#0a0a0a", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ChartPanel>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center font-mono text-xs text-muted">
      {label}
    </div>
  );
}
