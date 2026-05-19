import { clsx } from "clsx";

// TerminalWindow — visual chrome that mimics the E2B "≡×  SANDBOX  ≡"
// terminal panels. The header label is the screenshot's all-caps title,
// the body is whatever the consumer renders. Used decoratively on the
// landing page; can also wrap a code block or a small data viz.

interface TerminalWindowProps {
  title: string;
  /** Right-aligned hint inside the header. Usually a status. */
  hint?: string;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

export function TerminalWindow({
  title,
  hint,
  className,
  bodyClassName,
  children,
}: TerminalWindowProps) {
  return (
    <div
      className={clsx(
        "border border-border bg-card text-text",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-text/80">
            <span aria-hidden>≡</span>
            <span aria-hidden>×</span>
          </span>
          <span className="text-text">{title}</span>
        </div>
        {hint && <span className="truncate">{hint}</span>}
      </header>
      <div className={clsx("p-4", bodyClassName)}>{children}</div>
    </div>
  );
}
