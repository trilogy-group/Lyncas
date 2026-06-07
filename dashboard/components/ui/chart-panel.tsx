// ChartPanel — the landing page's "terminal window" motif, reused as the
// frame for every chart on the analytics page. A thin header row carries
// a left label (with the signature ≡× monogram) and an optional
// right-aligned status hint; the body holds the chart.

interface ChartPanelProps {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}

export function ChartPanel({
  title,
  hint,
  children,
  className,
}: ChartPanelProps) {
  return (
    <div
      className={
        "flex flex-col rounded-md border border-border bg-card " +
        (className ?? "")
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted-strong">
          <span className="text-muted/60" aria-hidden>
            ≡×
          </span>
          {title}
        </span>
        {hint && (
          <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted">
            {hint}
          </span>
        )}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
