"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useState } from "react";
import { BrandMark } from "./ui/brand";
import { Button, LinkButton } from "./ui/button";
import { signOut } from "@/lib/supabase/client";

// NavBar — single top bar used on every non-landing page.
//
// Auth-aware: the server-side wrapper (<NavMount>) decides whether
// `user` is non-null and passes that in. The same component renders
// both logged-in (avatar + sign out) and logged-out (sign in / sign up)
// chrome so the layout shift between states is zero and so we never
// show stale CTAs.
//
// Layout: brand on the left, link row in the middle (visible from md+
// so Chat doesn't disappear on tablets/laptops), CTA cluster on the
// right. On <md the link row collapses behind a hamburger menu — but
// the brand + CTA stay so the bar reads the same height everywhere.

export interface NavUser {
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface NavLinkSpec {
  href: string;
  label: string;
}

interface NavBarProps {
  user: NavUser | null;
  links: NavLinkSpec[];
}

export function NavBar({ user, links }: NavBarProps) {
  const pathname = usePathname() ?? "/";
  const [menuOpen, setMenuOpen] = useState(false);
  const display = user?.displayName ?? user?.email ?? "Account";

  return (
    <motion.nav
      initial={{ y: -8, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/65"
    >
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        {/* Left: brand + link row */}
        <div className="flex min-w-0 items-center gap-8">
          <BrandMark href={user ? "/dashboard/chat" : "/"} />
          <ul className="hidden md:flex items-center gap-5 text-[11px] font-mono uppercase tracking-[0.14em]">
            {links.map((l) => {
              const active =
                pathname === l.href ||
                (l.href !== "/" && pathname.startsWith(l.href + "/"));
              return (
                <li key={l.href} className="relative">
                  <Link
                    href={l.href}
                    className={
                      active
                        ? "text-white"
                        : "text-muted hover:text-white transition-colors"
                    }
                  >
                    {l.label}
                  </Link>
                  {active && (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute -bottom-[18px] left-0 right-0 h-[2px] bg-white"
                      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Right: auth cluster */}
        <div className="flex items-center gap-2">
          {user ? (
            <AuthedCluster user={user} display={display} />
          ) : (
            <SignedOutCluster />
          )}

          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            className="ml-1 md:hidden inline-flex h-8 w-8 items-center justify-center rounded-sm border border-border text-muted hover:border-border-strong hover:text-white"
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2}>
              {menuOpen ? (
                <path d="M5 5l14 14M5 19L19 5" />
              ) : (
                <>
                  <line x1="4" y1="7"  x2="20" y2="7" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="17" x2="20" y2="17" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {menuOpen && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="md:hidden border-t border-border bg-bg"
        >
          <ul className="mx-auto max-w-7xl px-4 py-3 space-y-1 text-[12px] font-mono uppercase tracking-[0.12em]">
            {links.map((l) => {
              const active =
                pathname === l.href ||
                (l.href !== "/" && pathname.startsWith(l.href + "/"));
              return (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    onClick={() => setMenuOpen(false)}
                    className={
                      "block rounded-sm border px-3 py-2 " +
                      (active
                        ? "border-border-strong bg-bg-elev text-white"
                        : "border-transparent text-muted hover:text-white hover:bg-bg-elev")
                    }
                  >
                    {l.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </motion.div>
      )}
    </motion.nav>
  );
}

function AuthedCluster({ user, display }: { user: NavUser; display: string }) {
  const router = useRouter();
  return (
    <>
      <Link
        href="/dashboard/chat"
        className="hidden sm:inline-flex h-8 items-center rounded-sm border border-border bg-bg-elev px-2.5 text-[10px] font-mono uppercase tracking-[0.14em] text-muted hover:text-white hover:border-border-strong transition-colors"
        title="Open chat"
      >
        Open chat →
      </Link>
      <div className="flex items-center gap-2 pl-1">
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.avatarUrl}
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
          className="hidden max-w-[140px] truncate text-[11px] font-mono text-muted lg:inline"
          title={display}
        >
          {display}
        </span>
        <Button
          size="sm"
          variant="default"
          onClick={async () => {
            await signOut();
            router.refresh();
          }}
        >
          Sign out
        </Button>
      </div>
    </>
  );
}

function SignedOutCluster() {
  return (
    <>
      <LinkButton href="/login" size="sm" variant="default">
        Sign in
      </LinkButton>
      <LinkButton href="/login" size="sm" variant="primary">
        Sign up
      </LinkButton>
    </>
  );
}
