"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "./ui/brand";
import { Button } from "./ui/button";
import { signOut } from "@/lib/supabase/client";

// Authenticated dashboard nav — rendered by /dashboard/layout.tsx.
//
// Post-login the user lands on /dashboard/chat (the v3 default), so
// chat sits first in the nav and the underlines highlight it as the
// active surface on /dashboard root.

interface AuthedNavProps {
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  repoCount: number;
  repoLimit: number;
}

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/dashboard/chat", label: "Chat" },
  { href: "/dashboard/overview", label: "Overview" },
  { href: "/dashboard/repos", label: "Repos" },
  { href: "/dashboard/settings", label: "Settings" },
  // Public-demo cross-links — same as the previous nav. These stay
  // available inside the authed shell so the demo data is one click
  // away without us cloning those pages.
  { href: "/runs", label: "Runs" },
  { href: "/learning", label: "Learning" },
  { href: "/benchmark", label: "Benchmark" },
];

export function AuthedNav({
  email,
  displayName,
  avatarUrl,
  repoCount,
  repoLimit,
}: AuthedNavProps) {
  const pathname = usePathname() ?? "";
  const display = displayName ?? email ?? "Account";

  const limitDisplay =
    repoLimit >= 9999 ? `${repoCount}` : `${repoCount}/${repoLimit}`;
  const overLimit = repoLimit < 9999 && repoCount >= repoLimit;

  return (
    <nav className="border-b border-border bg-bg">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-8">
          <BrandMark href="/dashboard/chat" />
          <div className="hidden lg:flex items-center gap-5 text-[11px] font-mono uppercase tracking-[0.14em]">
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

        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/connect-repo"
            className={
              "hidden sm:inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors " +
              (overLimit
                ? "border-[#ff9d4d]/60 text-[#ff9d4d] hover:bg-[#ff9d4d]/10"
                : "border-border text-muted hover:text-text hover:border-border-strong")
            }
            title={
              overLimit
                ? "Repo limit reached — upgrade to add more"
                : "Add another repository"
            }
          >
            {limitDisplay} repos
          </Link>
          <div className="flex items-center gap-2">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={display}
                className="h-7 w-7 rounded-full border border-border"
              />
            ) : (
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card font-mono text-xs text-muted"
                aria-hidden
              >
                {display.charAt(0).toUpperCase()}
              </div>
            )}
            <span
              className="hidden max-w-[140px] truncate text-[11px] font-mono text-muted sm:inline"
              title={display}
            >
              {display}
            </span>
            <Button
              size="sm"
              variant="default"
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </div>
        </div>
      </div>
    </nav>
  );
}
