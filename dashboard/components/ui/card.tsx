import { clsx } from "clsx";

// Card — dark-mode panel. Hairline borders, square-ish corners. Two
// new affordances since the v3 redesign:
//   - `tone="white"` flips to a white card with black content for
//     occasional emphasis (e.g. "what's new" callout)
//   - `lift` adds the CSS hover lift (no framer-motion dep for static
//     server components)

interface CardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Subtle border lighten on hover (legacy). */
  hover?: boolean;
  /** Drop the default padding — sometimes the consumer paints its own. */
  flush?: boolean;
  /** CSS-only translateY lift on hover. */
  lift?: boolean;
  /** Color tone. */
  tone?: "default" | "white" | "elev";
}

export function Card({
  children,
  className,
  style,
  hover = false,
  flush = false,
  lift = false,
  tone = "default",
}: CardProps) {
  const toneCls =
    tone === "white"
      ? "bg-white text-black border-white"
      : tone === "elev"
        ? "bg-bg-elev text-text border-border"
        : "bg-card text-text border-border";
  return (
    <div
      className={clsx(
        "border",
        toneCls,
        !flush && "rounded-md",
        hover && "transition-colors hover:border-border-strong",
        lift && "lift",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}
