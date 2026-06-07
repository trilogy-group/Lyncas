// Sparkline — a tiny, axis-less line+fill chart for dense table cells.
//
// Pure inline SVG (no recharts): these render dozens at a time in the
// overview "By repo" table and recharts' ResponsiveContainer is too
// heavy for a 96×28 cell. The color is derived from the trend by the
// caller (green up / red down) so the cell reads at a glance.

interface SparklineProps {
  data: number[];
  color: string;
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({
  data,
  color,
  width = 96,
  height = 28,
  className,
}: SparklineProps) {
  if (data.length === 0) {
    return <svg width={width} height={height} className={className} aria-hidden />;
  }

  const pad = 2;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const stepX = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0;

  const points = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = height - pad - ((v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area =
    `${line} L${points[points.length - 1][0].toFixed(1)},${height - pad} ` +
    `L${points[0][0].toFixed(1)},${height - pad} Z`;
  const gid = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
