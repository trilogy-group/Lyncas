import { clsx } from "clsx";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Card({ children, className, style }: CardProps) {
  return (
    <div
      className={clsx("bg-card border border-border rounded-lg", className)}
      style={style}
    >
      {children}
    </div>
  );
}
