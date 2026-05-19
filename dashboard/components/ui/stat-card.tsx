import { Card } from "./card";

// StatCard — single-number panel. The label sits up top in muted
// mono-uppercase; the value is a chunky mono number. Accent overrides
// the value color when the number itself signals a state (red total
// closed, green clean severity, etc).

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}

export function StatCard({ label, value, hint, accent }: StatCardProps) {
  return (
    <Card className="p-5" hover>
      <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted">
        {label}
      </div>
      <div
        className="mt-2 text-3xl font-mono font-semibold leading-none tabular-nums"
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
