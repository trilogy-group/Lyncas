"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "./ui/brand";
import { LinkButton } from "./ui/button";

// Public demo nav. Hidden on:
//   /login, /landing                — they ship their own chrome.
//   /dashboard/*, /auth/callback    — the authenticated shell renders
//                                     AuthedNav instead.
// Everything else (the legacy demo: /, /repos, /runs, /benchmark,
// /settings, /learning, /pr/[id]) keeps this nav.

const HIDDEN_PREFIXES = ["/login", "/landing", "/dashboard", "/auth/callback"];

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Overview" },
  { href: "/repos", label: "Repos" },
  { href: "/runs", label: "Runs" },
  { href: "/learning", label: "Learning" },
  { href: "/benchmark", label: "Benchmark" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname() ?? "/";
  if (HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return null;
  }

  return (
    <nav className="border-b border-border bg-bg">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <BrandMark href="/" />
          <div className="hidden md:flex items-center gap-6 text-[11px] font-mono uppercase tracking-[0.14em]">
            {LINKS.map((l) => {
              const active =
                pathname === l.href ||
                (l.href !== "/" && pathname.startsWith(l.href + "/"));
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={
                    active
                      ? "text-text underline underline-offset-[6px] decoration-text/40 hover:decoration-text"
                      : "text-muted hover:text-text transition-colors"
                  }
                >
                  {l.label}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <LinkButton href="/login" size="sm" variant="default">
            Sign in
          </LinkButton>
          <LinkButton href="/login" size="sm" variant="primary">
            Sign up
          </LinkButton>
        </div>
      </div>
    </nav>
  );
}
