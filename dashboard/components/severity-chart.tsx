"use client";

import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
} from "recharts";
import { ChartPanel } from "@/components/ui/chart-panel";
import type { SeverityBucket } from "@/lib/types";

// Severity histogram — vertical bars with the count labelled above each
// column and a two-token x-axis label ("1-3 LOW"). Colors track the
// severity ramp from lib/design.ts.

const META: Record<
  string,
  { color: string; tier: string }
> = {
  "1-3": { color: "#58e684", tier: "low" },
  "4-6": { color: "#f6cf45", tier: "med" },
  "7-8": { color: "#ffa760", tier: "high" },
  "9-10": { color: "#ff5a5a", tier: "crit" },
};

export function SeverityChart({ data }: { data: SeverityBucket[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const chartData = data.map((d) => ({
    ...d,
    label: `${d.bucket} ${META[d.bucket]?.tier ?? ""}`.trim(),
  }));

  return (
    <ChartPanel title="Severity distribution" hint="all reviews">
      {total === 0 ? (
        <div className="flex h-[240px] items-center justify-center font-mono text-xs text-muted">
          no reviews yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart
            data={chartData}
            margin={{ top: 22, right: 8, left: 8, bottom: 0 }}
            barCategoryGap="22%"
          >
            <XAxis
              dataKey="label"
              tick={{
                fontSize: 9,
                fill: "#9a9a9a",
                fontFamily: "monospace",
                letterSpacing: 0.5,
              }}
              stroke="#232323"
              tickLine={false}
              axisLine={{ stroke: "#232323" }}
              tickFormatter={(v: string) => v.toUpperCase()}
            />
            <Bar dataKey="count" radius={[2, 2, 0, 0]} maxBarSize={88}>
              <LabelList
                dataKey="count"
                position="top"
                style={{
                  fill: "#ffffff",
                  fontSize: 12,
                  fontFamily: "monospace",
                }}
              />
              {chartData.map((d) => (
                <Cell key={d.bucket} fill={META[d.bucket]?.color ?? "#9a9a9a"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartPanel>
  );
}
