import { clsx } from "clsx";

// Badge — small severity / verdict / status pill. On the black theme
// we render solid badges with a slight black overlay on the supplied
// color (so the color reads as the *fill* rather than a saturated
// block) and outline badges as a colored border with the color inset
// as the text. The default `solid` keeps high-contrast readability.

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
      style = { background: color, color: "#000" };
    } else if (variant === "outline") {
      style = { color, borderColor: color };
    } else {
      // subtle: tinted bg, full-strength text.
      style = {
        color,
        background: `${color}1A`, // 10% alpha hex
        borderColor: `${color}55`,
      };
    }
  }
  return (
    <span
      className={clsx(
        "inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-semibold font-mono leading-none whitespace-nowrap uppercase tracking-[0.04em]",
        (variant === "outline" || variant === "subtle") && "border bg-transparent",
        className,
      )}
      style={style}
    >
      {children}
    </span>
  );
}
