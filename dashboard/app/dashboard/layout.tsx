import { redirect } from "next/navigation";
import { AuthedNav } from "@/components/authed-nav";
import { getUserProfile, getWatchedRepos } from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";

// /dashboard layout — the authentication boundary. Every page nested
// under /dashboard goes through here first.
//
// Auth model:
//   1. middleware.ts has already redirected unauthenticated requests
//      to /login. This server-side getUser() is the second line of
//      defense for the (rare) case where middleware was bypassed.
//   2. getUser() verifies the JWT against Supabase Auth (round-trip),
//      so we're trusting the identity, not a cookie blob.
//   3. The user_profiles + watched_repos rows are fetched once here
//      and passed into the AuthedNav as props. Pages further down can
//      re-query whatever they need; this layout's job is just the
//      chrome.

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getUser().catch(() => null);
  if (!user) {
    redirect("/login");
  }

  // Parallel-fetch profile and repos; both are user-scoped reads and
  // independent. If either fails we render with sensible defaults
  // rather than 500'ing the whole shell.
  const [profile, watched] = await Promise.all([
    getUserProfile(user.id),
    getWatchedRepos(user.id),
  ]);

  return (
    <>
      <AuthedNav
        email={profile?.email ?? user.email ?? null}
        displayName={
          profile?.display_name ?? profile?.github_username ?? null
        }
        avatarUrl={profile?.avatar_url ?? null}
        repoCount={watched.length}
        repoLimit={profile?.repo_limit ?? 2}
      />
      {children}
    </>
  );
}
