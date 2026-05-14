import { Card } from "./card";

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}

export function StatCard({ label, value, hint, accent }: StatCardProps) {
  return (
    <Card className="p-5">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted">
        {label}
      </div>
      <div
        className="mt-2 text-3xl font-mono font-semibold leading-none"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-xs font-mono text-muted">{hint}</div>
      )}
    </Card>
  );
}
