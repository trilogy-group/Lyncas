import Link from "next/link";
import { clsx } from "clsx";

// BrandMark — small starburst-style glyph + wordmark used in the nav
// and footer. Pure inline SVG, no asset file, no extra HTTP hop.

interface BrandMarkProps {
  href?: string;
  /** Render the wordmark next to the glyph. */
  withName?: boolean;
  className?: string;
}

export function BrandMark({
  href = "/",
  withName = true,
  className,
}: BrandMarkProps) {
  const content = (
    <span className={clsx("inline-flex items-center gap-2.5", className)}>
      <BrandGlyph />
      {withName && (
        <span className="font-mono text-sm font-semibold tracking-[0.04em]">
          NIGHT/PR
        </span>
      )}
    </span>
  );
  if (!href) return content;
  return (
    <Link
      href={href}
      className="inline-flex items-center text-text hover:opacity-80 transition-opacity"
    >
      {content}
    </Link>
  );
}

function BrandGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      aria-hidden
      className="text-text"
    >
      {/* 8-point starburst — silhouette echoing the E2B reference. Drawn
          so it scales crisply at 16/20/24px. */}
      <g
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={0.5}
        strokeLinejoin="round"
      >
        <polygon points="12,1 13.3,9 12,12 10.7,9" />
        <polygon points="12,23 13.3,15 12,12 10.7,15" />
        <polygon points="1,12 9,10.7 12,12 9,13.3" />
        <polygon points="23,12 15,10.7 12,12 15,13.3" />
        <polygon points="4.2,4.2 10,9.2 12,12 9.2,10" />
        <polygon points="19.8,19.8 14,14.8 12,12 14.8,14" />
        <polygon points="4.2,19.8 9.2,14 12,12 10,14.8" />
        <polygon points="19.8,4.2 14.8,9.2 12,12 14,10" />
      </g>
    </svg>
  );
}
