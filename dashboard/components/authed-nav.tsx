"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/lib/supabase/client";

// Authenticated dashboard nav. Used only by /dashboard/layout.tsx —
// the public-side nav (components/nav.tsx) handles the legacy demo
// routes. This component is a client component because:
//   * it reads usePathname() to highlight the active link
//   * signOut() is browser-only (clears local cookies + redirects)
//
// User identity is passed in as props rather than re-fetched here so
// the (server-rendered) layout above can do the auth round-trip once
// per request.

interface AuthedNavProps {
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  repoCount: number;
  repoLimit: number;
}

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/dashboard/overview", label: "overview" },
  { href: "/dashboard/chat", label: "chat" },
  { href: "/dashboard/repos", label: "repos" },
  // Cross-link to the public demo pages — same data, no scoping yet
  // (see /dashboard/overview header for the explanation). Keeps the
  // existing /runs, /benchmark, /learning, /settings reachable from
  // inside the authed shell without us cloning them.
  { href: "/runs", label: "runs" },
  { href: "/learning", label: "learning" },
  { href: "/benchmark", label: "benchmark" },
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

  // 9999 is the sentinel for unlimited (pro/enterprise). Render that
  // as a friendlier "—" rather than a fake "X/9999 repos" string.
  const limitDisplay =
    repoLimit >= 9999 ? `${repoCount}` : `${repoCount}/${repoLimit}`;
  const overLimit = repoLimit < 9999 && repoCount >= repoLimit;

  return (
    <nav className="border-b border-border bg-card">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-8 min-w-0">
          <Link
            href="/dashboard/overview"
            className="font-semibold text-sm tracking-tight whitespace-nowrap hover:text-accent transition-colors"
          >
            Night PR Reviewer
          </Link>
          <div className="hidden md:flex items-center gap-5 text-sm font-mono">
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
                      ? "text-text"
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
              "text-xs px-2.5 py-1 rounded-full border " +
              (overLimit
                ? "border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"
                : "border-border text-muted hover:text-text hover:bg-bg")
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
              // Plain <img> rather than next/image because the host
              // (Supabase / GitHub) is variable per-user and we don't
              // want to maintain an `images.domains` allowlist.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={display}
                className="w-7 h-7 rounded-full border border-border"
              />
            ) : (
              <div
                className="w-7 h-7 rounded-full bg-bg border border-border flex items-center justify-center text-xs font-mono text-muted"
                aria-hidden
              >
                {display.charAt(0).toUpperCase()}
              </div>
            )}
            <span
              className="text-xs text-muted hidden sm:inline max-w-[140px] truncate"
              title={display}
            >
              {display}
            </span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="text-xs text-muted hover:text-text border border-border rounded-md px-2 py-1"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
