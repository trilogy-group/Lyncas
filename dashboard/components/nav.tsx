import { headers } from "next/headers";
import { NavBar, type NavLinkSpec, type NavUser } from "./nav-bar";
import { getUser } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/queries";

// Server-side Nav mount. Reads the current pathname from the proxy
// header set by middleware (so this stays a server component and we
// can fetch the user once per request without hydration mismatches)
// and the Supabase user so the bar reflects logged-in / logged-out
// chrome consistently across every non-dashboard page.
//
// Hidden routes — these ship their own chrome:
//   /landing                       — marketing nav
//   /login, /auth/callback         — auth-only screens
//   /dashboard/*                   — AuthedNav from dashboard/layout
//
// Everything else (the v1 demo: /, /repos, /settings, /pr/[id])
// renders this bar. /runs, /learning, /benchmark are 404'd at the
// route level so they never reach the nav anyway.

const HIDDEN_PREFIXES = [
  "/login",
  "/landing",
  "/dashboard",
  "/auth/callback",
  "/auth/github-app",
];

// /runs, /learning, /benchmark are intentionally absent on both axes.
// They still exist on disk but their pages 404 so logged-out tire
// kickers and logged-in users alike see nothing — that data was global
// (no per-user filter) and shouldn't leak across accounts.
//
// /repos in the logged-out list points to a page that now auth-gates
// itself; clicking through bounces to /login with the right `next`.
const LOGGED_IN_LINKS: NavLinkSpec[] = [
  { href: "/dashboard/chat", label: "Chat" },
  { href: "/dashboard/overview", label: "Overview" },
  { href: "/dashboard/repos", label: "Repos" },
  { href: "/dashboard/settings", label: "Settings" },
];

const LOGGED_OUT_LINKS: NavLinkSpec[] = [
  { href: "/", label: "Overview" },
  { href: "/repos", label: "Repos" },
];

async function readPathname(): Promise<string> {
  // next-url header is set by Next.js on every request and reads as
  // the path the user actually requested (rewrites included). Falls
  // back to "/" if missing so we never crash on the edge of a config
  // change.
  const h = await headers();
  const url = h.get("x-pathname") ?? h.get("next-url") ?? "/";
  // next-url sometimes carries query/hash — strip them.
  try {
    return new URL(url, "http://localhost").pathname || "/";
  } catch {
    return "/";
  }
}

export async function Nav() {
  const pathname = await readPathname();
  if (
    HIDDEN_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "/"),
    )
  ) {
    return null;
  }

  const user = await getUser().catch(() => null);
  let navUser: NavUser | null = null;
  if (user) {
    const profile = await getUserProfile(user.id).catch(() => null);
    navUser = {
      email: profile?.email ?? user.email ?? null,
      displayName: profile?.display_name ?? profile?.github_username ?? null,
      githubUsername: profile?.github_username ?? null,
      avatarUrl: profile?.avatar_url ?? null,
    };
  }

  return (
    <NavBar
      user={navUser}
      links={navUser ? LOGGED_IN_LINKS : LOGGED_OUT_LINKS}
    />
  );
}
