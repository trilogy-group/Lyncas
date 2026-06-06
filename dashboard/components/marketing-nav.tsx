import Link from "next/link";
import { BrandMark } from "./ui/brand";
import { LinkButton } from "./ui/button";

// Marketing nav — used on the public landing page and any future
// product / pricing / resources marketing pages. Wide all-caps mono
// links on the left, GitHub/X icons in the middle right, sign-up/in
// buttons on the far right. Mirrors the layout in the E2B reference.

const PRIMARY_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/landing#product", label: "Product" },
  { href: "/landing#pricing", label: "Pricing" },
  { href: "/landing#resources", label: "Resources" },
  { href: "/landing#enterprise", label: "Enterprise" },
  { href: "/landing#book-call", label: "Book a call" },
];

export function MarketingNav() {
  return (
    <header className="border-b border-border bg-bg">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <BrandMark href="/landing" />
          <nav className="hidden md:flex items-center gap-6 text-[11px] font-mono uppercase tracking-[0.14em] text-muted">
            {PRIMARY_LINKS.map((link, i) => (
              <Link
                key={link.href}
                href={link.href}
                className={
                  i === 0
                    ? "text-text underline underline-offset-[6px] decoration-text/40 hover:decoration-text"
                    : "hover:text-text transition-colors"
                }
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden lg:inline text-[11px] font-mono uppercase tracking-[0.14em] text-muted">
            Careers
          </span>
          <SocialIcons />
          <div className="hidden sm:flex items-center gap-2">
            <LinkButton href="/login" size="sm" variant="primary">
              Sign up
            </LinkButton>
            <LinkButton href="/login" size="sm" variant="default">
              Sign in
            </LinkButton>
          </div>
          <LinkButton href="/login" size="sm" variant="primary" className="sm:hidden">
            Sign in
          </LinkButton>
        </div>
      </div>
    </header>
  );
}

function SocialIcons() {
  return (
    <div className="hidden md:flex items-center gap-3 text-muted">
      <a
        href="https://github.com/trilogy-group/Lyncas"
        target="_blank"
        rel="noreferrer"
        aria-label="GitHub"
        className="hover:text-text transition-colors"
      >
        <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor">
          <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.65 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.17a11 11 0 0 1 5.78 0c2.21-1.48 3.18-1.17 3.18-1.17.62 1.59.23 2.77.11 3.06.73.8 1.18 1.82 1.18 3.07 0 4.39-2.69 5.36-5.25 5.64.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.55C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
        </svg>
      </a>
      <span aria-label="X" className="hover:text-text transition-colors cursor-default">
        <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor">
          <path d="M18.244 2H21l-6.563 7.5L22 22h-6.797l-4.717-6.36L4.8 22H2l7.069-8.08L2 2h6.96l4.28 5.79L18.244 2Zm-2.39 18.4h1.58L7.215 3.5H5.51l10.343 16.9Z" />
        </svg>
      </span>
    </div>
  );
}
