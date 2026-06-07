import { redirect } from "next/navigation";
import { AuthedNav } from "@/components/authed-nav";
import { getUserProfile } from "@/lib/queries";
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
//   3. user_profiles is fetched once here for the nav avatar / display
//      name. The repo-count pill that used to live here was removed
//      along with the free-plan limit UI — pages further down can
//      re-query what they need.

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

  // Profile is the only nav input now. A null profile (race between
  // OAuth callback insert and the first dashboard hit) just falls
  // back to email / "Account".
  const profile = await getUserProfile(user.id);

  return (
    <>
      <AuthedNav
        email={profile?.email ?? user.email ?? null}
        displayName={
          profile?.display_name ?? profile?.github_username ?? null
        }
        githubUsername={profile?.github_username ?? null}
        avatarUrl={profile?.avatar_url ?? null}
      />
      {children}
    </>
  );
}
