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
  { href: "/dashboard/settings", label: "Settings" },
];

export function AuthedNav({ email, displayName, avatarUrl }: AuthedNavProps) {
  const user: NavUser = { email, displayName, avatarUrl };
  return <NavBar user={user} links={LINKS} />;
}
