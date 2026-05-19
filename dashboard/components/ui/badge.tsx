import { clsx } from "clsx";

// Badge — small severity / verdict / status pill.
//
//   solid   — color fill, black text. Highest contrast, use for the
//             one most important badge per row.
//   outline — color border + color text, transparent fill.
//   subtle  — color text on a tinted (~12%) fill. Reads as a "chip"
//             rather than a "stamp" — used on dense rows.
//
// All variants share the same uppercase-mono typography so badges
// read as a single design language regardless of color.

interface BadgeProps {
  children: React.ReactNode;
  color?: string;
  variant?: "solid" | "outline" | "subtle";
  className?: string;
}

export function Badge({
  children,
  color,
  variant = "solid",
  className,
}: BadgeProps) {
  let style: React.CSSProperties | undefined;
  if (color) {
    if (variant === "solid") {
      style = { background: color, color: "#000", borderColor: color };
    } else if (variant === "outline") {
      style = { color, borderColor: color };
    } else {
      style = {
        color,
        background: `${color}1F`, // ~12% alpha hex
        borderColor: `${color}55`,
      };
    }
  }
  return (
    <span
      className={clsx(
        "inline-flex items-center px-1.5 py-0.5 rounded-sm border text-[10.5px] font-semibold font-mono leading-none whitespace-nowrap uppercase tracking-[0.05em]",
        variant === "solid" ? "border-transparent" : "",
        className,
      )}
      style={style}
    >
      {children}
    </span>
  );
}
