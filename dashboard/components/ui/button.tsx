import Link from "next/link";
import { clsx } from "clsx";

// E2B-style buttons.
//
//   primary  — white fill, black text (the inverted scheme from the
//              brief). Used for the single most important action per
//              screen.
//   default  — transparent fill, white border + text. Hover lifts to
//              full-white. Used for secondary CTAs and inline actions.
//   ghost    — no border, just text. Used in nav and footer links.
//   danger   — kept very rare; subdued red-tinted variant of `default`.
//   subtle   — bg-elev panel, white text. Used inside dense rows where
//              `default` would look noisy.
//
// Sizes mirror the E2B reference: a chunky `md` for hero / pricing
// CTAs and `sm` for tightly packed UI rows.

type Variant = "primary" | "default" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-white text-black border border-white shadow-[0_0_0_0_rgba(255,255,255,0)] hover:shadow-[0_0_24px_-8px_rgba(255,255,255,0.6)] hover:-translate-y-[1px] active:translate-y-0",
  default:
    "bg-transparent text-white border border-white/30 hover:border-white hover:bg-white/[0.06]",
  ghost:
    "bg-transparent text-white/70 border border-transparent hover:text-white hover:bg-white/[0.04]",
  danger:
    "bg-transparent text-[#ff5a5a] border border-[#ff5a5a]/40 hover:bg-[#ff5a5a]/10",
  subtle:
    "bg-bg-elev text-white border border-border hover:border-border-strong hover:bg-bg-elev-2",
};

const SIZES: Record<Size, string> = {
  sm: "h-8  px-3  text-xs",
  md: "h-10 px-5  text-sm",
  lg: "h-12 px-7  text-sm",
};

const BASE =
  "inline-flex items-center justify-center gap-2 font-mono uppercase tracking-[0.08em] font-medium select-none transition-all duration-200 ease-out disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black";

interface CommonProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: React.ReactNode;
}

type ButtonProps = CommonProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

export function Button({
  variant = "default",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {children}
    </button>
  );
}

type LinkButtonProps = CommonProps &
  Omit<React.ComponentProps<typeof Link>, "className" | "children">;

export function LinkButton({
  variant = "default",
  size = "md",
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link
      className={clsx(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {children}
    </Link>
  );
}

type ExternalButtonProps = CommonProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children">;

export function ExternalLinkButton({
  variant = "default",
  size = "md",
  className,
  children,
  ...rest
}: ExternalButtonProps) {
  return (
    <a
      className={clsx(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {children}
    </a>
  );
}
