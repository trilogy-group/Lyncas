"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "./ui/brand";
import { LinkButton } from "./ui/button";
import { signOut } from "@/lib/supabase/client";

// NavBar — single top bar used on every non-landing page.
//
// Auth-aware: the server-side wrapper (<NavMount>) decides whether
// `user` is non-null and passes that in. The same component renders
// both logged-in (a profile badge that opens a dropdown — account /
// settings / docs / sign out) and logged-out (sign in / sign up)
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
  githubUsername: string | null;
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
                    prefetch
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
                    prefetch
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
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside-click and on Escape.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handle = user.githubUsername ? `@${user.githubUsername}` : user.email;

  return (
    <div ref={ref} className="relative">
      {/* Profile badge — the trigger. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2.5 rounded-md border border-border bg-bg-elev px-2 py-1.5 transition-colors hover:border-border-strong"
      >
        <Avatar user={user} display={display} />
        <span className="hidden text-left sm:block">
          <span className="block max-w-[140px] truncate text-[13px] font-medium leading-tight text-white">
            {display}
          </span>
          {handle && (
            <span className="block max-w-[140px] truncate font-mono text-[11px] leading-tight text-muted">
              {handle}
            </span>
          )}
        </span>
        <svg
          viewBox="0 0 24 24"
          width={16}
          height={16}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className={
            "text-muted transition-transform " + (open ? "rotate-180" : "")
          }
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Dropdown menu. */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            role="menu"
            className="absolute right-0 top-[calc(100%+8px)] w-64 overflow-hidden rounded-md border border-border bg-card shadow-[0_16px_48px_-12px_rgba(0,0,0,0.8)]"
          >
            {/* Identity header */}
            <div className="border-b border-border px-4 py-3.5">
              <div className="truncate text-sm font-semibold text-white">
                {display}
              </div>
              {user.email && (
                <div className="truncate font-mono text-xs text-muted">
                  {user.email}
                </div>
              )}
            </div>

            {/* Navigation items */}
            <div className="py-1.5">
              <MenuLink
                href="/dashboard/settings"
                onSelect={() => setOpen(false)}
                icon={
                  <>
                    <circle cx="12" cy="8" r="3.2" />
                    <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
                  </>
                }
              >
                Account
              </MenuLink>
              <MenuLink
                href="/dashboard/settings"
                onSelect={() => setOpen(false)}
                icon={
                  <>
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
                  </>
                }
              >
                Settings
              </MenuLink>
              <MenuLink
                href="/dashboard/docs"
                onSelect={() => setOpen(false)}
                icon={
                  <>
                    <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
                    <path d="M5 17h13" />
                  </>
                }
              >
                Documentation
              </MenuLink>
            </div>

            {/* Sign out */}
            <div className="border-t border-border py-1.5">
              <button
                type="button"
                role="menuitem"
                disabled={signingOut}
                onClick={async () => {
                  setSigningOut(true);
                  await signOut();
                  setOpen(false);
                  router.refresh();
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-[#ff5a5a] transition-colors hover:bg-[#ff5a5a]/10 disabled:opacity-50"
              >
                <svg
                  viewBox="0 0 24 24"
                  width={18}
                  height={18}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M14 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
                  <path d="M10 12h11M18 9l3 3-3 3" />
                </svg>
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Avatar({ user, display }: { user: NavUser; display: string }) {
  if (user.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.avatarUrl}
        alt={display}
        className="h-8 w-8 rounded-md border border-border object-cover"
      />
    );
  }
  return (
    <div
      className="flex h-8 w-8 items-center justify-center rounded-md bg-[#ff8a3d] font-mono text-sm font-semibold text-black"
      aria-hidden
    >
      {initials(display)}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function MenuLink({
  href,
  icon,
  children,
  onSelect,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <Link
      href={href}
      prefetch
      role="menuitem"
      onClick={onSelect}
      className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-soft transition-colors hover:bg-bg-elev hover:text-white"
    >
      <svg
        viewBox="0 0 24 24"
        width={18}
        height={18}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted"
        aria-hidden
      >
        {icon}
      </svg>
      {children}
    </Link>
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
