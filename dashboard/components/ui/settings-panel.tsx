"use client";

import { clsx } from "clsx";

// Settings primitives — the panel / row / toggle / pill vocabulary used
// across /dashboard/settings. Visual language matches the rest of the
// dashboard (hairline borders, bg-elev header bars, mono uppercase
// labels). Nothing here introduces new colors beyond the green
// (#58e684) and orange (#ff8a3d) accents already used elsewhere.

export function SettingsPanel({
  title,
  meta,
  children,
}: {
  title: string;
  /** Right-aligned status label in the header bar (e.g. "CONNECTED"). */
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-center justify-between gap-4 border-b border-border bg-bg-elev px-5 py-3">
        <div className="flex items-center gap-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-white">
          <span aria-hidden className="text-muted">
            ☰ ✕
          </span>
          {title}
        </div>
        {meta ? (
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
            {meta}
          </div>
        ) : null}
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

// A labelled control row: title + helper text on the left, control on
// the right. Rows stack with a hairline divider between them via the
// `divide-y` on the parent list.
export function SettingsRow({
  title,
  description,
  control,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-6 py-4",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-semibold text-white">{title}</div>
        {description ? (
          <p className="text-xs text-muted leading-relaxed">{description}</p>
        ) : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  );
}

// Thin wrapper that gives a list of SettingsRows the hairline dividers.
export function SettingsRows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

// Pill badge — green by default (status: good), used for VERIFIED /
// ONLINE. `dot` prepends a filled status dot.
export function SettingsPill({
  children,
  tone = "good",
  dot = false,
}: {
  children: React.ReactNode;
  tone?: "good" | "muted";
  dot?: boolean;
}) {
  const color = tone === "good" ? "#58e684" : "#9a9a9a";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em]"
      style={{ color, borderColor: `${color}55` }}
    >
      {dot ? (
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: color }}
        />
      ) : null}
      {children}
    </span>
  );
}

// Toggle switch. On = orange fill (the dashboard accent), off = muted
// track. Controlled via `checked` / `onChange`.
export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible label, since the visual label lives in the row title. */
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
        disabled && "cursor-not-allowed opacity-50",
      )}
      style={{ backgroundColor: checked ? "#ff8a3d" : "#3a3a3a" }}
    >
      <span
        className={clsx(
          "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200",
          checked ? "translate-x-[22px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}
