import { clsx } from "clsx";

// Table primitives for the dark theme. Hairline borders, no rounded
// corners on the table itself (matches the E2B square-edge aesthetic),
// monospace lower-case column headers, alternating row hover.

export function Table({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="overflow-x-auto border border-border bg-card rounded-md">
      <table className={clsx("w-full text-sm", className)}>{children}</table>
    </div>
  );
}

export function TableHeader({ children }: { children: React.ReactNode }) {
  return (
    <thead className="bg-bg-elev border-b border-border">{children}</thead>
  );
}

export function TableBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-border">{children}</tbody>;
}

export function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={clsx(
        "px-3 py-2.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td
      className={clsx(
        "px-3 py-2.5 align-middle",
        className,
      )}
      style={style}
    >
      {children}
    </td>
  );
}
