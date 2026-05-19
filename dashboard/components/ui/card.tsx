import { clsx } from "clsx";

// Card — dark-mode panel. The E2B reference uses square corners with
// just a 1px hairline, so we keep the border-radius minimal (rounded
// only inside content panes). `hover` enables a subtle hover lift used
// on the landing / pricing grid where each card is clickable.

interface CardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Slight white-on-hover border treatment. Off by default. */
  hover?: boolean;
  /** Drop the default padding — sometimes the consumer paints its own. */
  flush?: boolean;
}

export function Card({
  children,
  className,
  style,
  hover = false,
  flush = false,
}: CardProps) {
  return (
    <div
      className={clsx(
        "bg-card border border-border",
        !flush && "rounded-md",
        hover && "transition-colors hover:border-border-strong",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}
