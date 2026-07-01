import { NavBar, type NavLinkSpec, type NavUser } from "./nav-bar";

// Authenticated dashboard nav — thin wrapper around <NavBar> so the
// /dashboard/* surface, the public demo surface, and the marketing
// landing are all visually consistent.
//
// Why a wrapper at all? Because /dashboard/layout.tsx already runs an
// auth round-trip + profile fetch and we want to reuse those exact
// values rather than re-querying.

interface AuthedNavProps {
  email: string | null;
  displayName: string | null;
  githubUsername: string | null;
  avatarUrl: string | null;
}

// Pared down to the surfaces a logged-in user can actually use. /runs,
// /learning, /benchmark are legacy demo pages — kept on disk but hidden
// from the nav and 404'd at the route level so a friend handed the
// deployed URL never lands on someone else's data.
const LINKS: NavLinkSpec[] = [
  { href: "/dashboard/chat", label: "Chat" },
  { href: "/dashboard/overview", label: "Overview" },
  { href: "/dashboard/repos", label: "Repos" },
  // Terminal — live interactive shell on the Lyncas house runner
  // (EC2). Lets a dashboard-only user work on a real machine without
  // connecting their own DevPod. First slice of Improvements.md item 4.
  { href: "/dashboard/terminal", label: "Terminal" },
  // Reports (migration 018) — per-PR synthesis layer on top of the
  // reviewer + sandbox signals. Placed after Repos because the
  // mental model is "drill from a repo into its PRs"; ahead of
  // Settings because it's a daily-driver surface, not a setup one.
  { href: "/dashboard/reports", label: "Reports" },
  // Docs — in-app reference for the whole product. Sits ahead of
  // Settings: it's a "when you need it" reference surface, whereas
  // Settings is a setup-once destination that belongs last.
  { href: "/dashboard/docs", label: "Docs" },
  { href: "/dashboard/settings", label: "Settings" },
];

export function AuthedNav({
  email,
  displayName,
  githubUsername,
  avatarUrl,
}: AuthedNavProps) {
  const user: NavUser = { email, displayName, githubUsername, avatarUrl };
  return <NavBar user={user} links={LINKS} />;
}
