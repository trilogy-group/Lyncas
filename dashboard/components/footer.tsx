import Link from "next/link";
import { BrandMark } from "./ui/brand";

// Marketing footer. The dashboard interior pages don't render this —
// it sits below the landing / login / pricing surfaces.

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

interface FooterColumn {
  heading: string;
  links: FooterLink[];
}

const COLUMNS: FooterColumn[] = [
  {
    heading: "Product",
    links: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Pricing", href: "/landing#pricing" },
      { label: "Live demo", href: "/" },
      { label: "Book a call", href: "/landing#book-call" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Documentation", href: "/landing#docs" },
      { label: "Changelog", href: "/landing#changelog" },
      {
        label: "GitHub",
        href: "https://github.com/HarshBti1805/night-pr-reviewer",
        external: true,
      },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "Careers", href: "/landing#careers" },
      { label: "Privacy", href: "/landing#privacy" },
      { label: "Terms", href: "/landing#terms" },
      {
        label: "GitHub",
        href: "https://github.com/HarshBti1805/night-pr-reviewer",
        external: true,
      },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-bg">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-12">
        <div className="grid gap-10 md:grid-cols-4">
          <div className="space-y-4">
            <BrandMark href="/landing" />
            <p className="text-xs leading-relaxed text-muted max-w-[220px]">
              Autonomous code review for your repositories. Powered by Claude
              Opus.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted mb-3">
                {col.heading}
              </div>
              <ul className="space-y-2 text-sm">
                {col.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-text/80 hover:text-text transition-colors"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-text/80 hover:text-text transition-colors"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-[11px] font-mono uppercase tracking-[0.14em] text-muted">
          <span>© Lyncas · Built on Claude Opus</span>
          <span>v3 · feat/saas-multi-tenant</span>
        </div>
      </div>
    </footer>
  );
}
