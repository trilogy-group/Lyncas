import { clsx } from "clsx";

interface BadgeProps {
  children: React.ReactNode;
  color?: string;
  variant?: "solid" | "outline";
  className?: string;
}

export function Badge({
  children,
  color,
  variant = "solid",
  className,
}: BadgeProps) {
  const style =
    variant === "solid"
      ? { background: color, color: "#fff" }
      : { color, borderColor: color };
  return (
    <span
      className={clsx(
        "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold font-mono leading-none whitespace-nowrap",
        variant === "outline" && "border bg-card",
        className,
      )}
      style={style}
    >
      {children}
    </span>
  );
}
