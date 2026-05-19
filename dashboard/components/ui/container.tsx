import { clsx } from "clsx";

// Page container — single source of truth for max-width + horizontal
// padding. Every page wraps its top-level <main> content in this so
// the gutters line up across the dashboard, landing, and marketing
// pages.

interface ContainerProps {
  size?: "narrow" | "default" | "wide";
  className?: string;
  children: React.ReactNode;
}

const SIZES = {
  narrow: "max-w-3xl",
  default: "max-w-6xl",
  wide: "max-w-7xl",
} as const;

export function Container({
  size = "default",
  className,
  children,
}: ContainerProps) {
  return (
    <div className={clsx("mx-auto w-full px-4 sm:px-6", SIZES[size], className)}>
      {children}
    </div>
  );
}
