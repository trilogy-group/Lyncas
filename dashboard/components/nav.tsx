"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Hide the v1 demo navigation on:
//   - /login / /landing — those have their own header chrome.
//   - /dashboard/*       — the authenticated route group renders its
//                          own AuthedNav with user info + sign-out.
// Everything else (the demo routes /, /repos, /runs, /benchmark,
// /settings, /learning, /pr/[id]) keeps the original Nav unchanged so
// the existing main-branch demo behavior stays intact on this branch.
const HIDDEN_PREFIXES = ["/login", "/landing", "/dashboard", "/auth/callback"];

export function Nav() {
  const pathname = usePathname() ?? "/";
  if (HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return null;
  }

  return (
    <nav className="border-b border-border bg-card">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link
          href="/"
          className="font-semibold text-sm tracking-tight hover:text-accent transition-colors"
        >
          Night PR Reviewer
        </Link>
        <div className="flex items-center gap-6 text-sm font-mono">
          <Link
            href="/"
            className="text-muted hover:text-text transition-colors"
          >
            overview
          </Link>
          <Link
            href="/repos"
            className="text-muted hover:text-text transition-colors"
          >
            repos
          </Link>
          <Link
            href="/runs"
            className="text-muted hover:text-text transition-colors"
          >
            runs
          </Link>
          <Link
            href="/learning"
            className="text-muted hover:text-text transition-colors"
          >
            learning
          </Link>
          <Link
            href="/benchmark"
            className="text-muted hover:text-text transition-colors"
          >
            benchmark
          </Link>
          <Link
            href="/settings"
            className="text-muted hover:text-text transition-colors"
          >
            settings
          </Link>
        </div>
      </div>
    </nav>
  );
}
