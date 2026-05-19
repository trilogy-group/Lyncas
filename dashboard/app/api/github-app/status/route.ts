import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import { reconcileUserInstallations } from "@/lib/github-app-reconcile";

// GET /api/github-app/status
//
// Authoritative answer to "does this user still have a working GitHub
// App installation?". Returns:
//
//   {
//     healthy: number,                    // live installations on GitHub
//     stale:   number,                    // rows we removed in this call
//                                         // (zero on the steady state)
//     accounts: { login, installation_id }[],
//     install_url: string | null,         // null when no app slug configured
//   }
//
// Side effect: this endpoint RECONCILES on every call. We don't have
// the `installation.deleted` webhook subscribed yet, so the next-best
// thing is "re-derive truth from GitHub whenever the user looks at
// the chat page". The reconcile helper:
//   * probes every installation row for this user,
//   * deletes the ones GitHub no longer recognizes,
//   * removes watched_repos rows whose installation is dead OR whose
//     repo isn't in the live install's current selection, and
//   * upserts whatever GitHub does report so newly-selected repos
//     show up immediately.
//
// Why on the read endpoint and not a separate POST: every other
// surface is read-only-from-the-client. Putting reconciliation here
// means the user never has to "remember to clean up" — opening chat
// is enough.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildInstallUrl(): string | null {
  const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  if (!slug) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}

export async function GET() {
  const user = await getUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Reconcile first — afterwards `github_app_installations` only
  // contains live rows, so the lookup below is straightforward.
  const summary = await reconcileUserInstallations(user.id).catch(
    (e): null => {
      console.error("[github-app/status] reconcile failed:", e);
      return null;
    },
  );

  // Re-read the (now-clean) install rows to surface account logins to
  // the UI. We don't trust the reconcile summary alone here because it
  // doesn't carry account_login — that's a separate select.
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("github_app_installations")
    .select("installation_id, account_login")
    .eq("user_id", user.id);

  if (error) {
    // Table missing or RLS misconfigured — fail OPEN (treat as "no
    // install" so the UI prompts to install) rather than 500.
    return NextResponse.json({
      healthy: 0,
      stale: summary?.stale_installation_ids.length ?? 0,
      accounts: [],
      install_url: buildInstallUrl(),
      degraded: true,
    });
  }

  const accounts = (data ?? []).map((r) => ({
    login: (r as { account_login: string | null }).account_login ?? "?",
    installation_id: (r as { installation_id: number }).installation_id,
  }));

  return NextResponse.json({
    healthy: accounts.length,
    stale: summary?.stale_installation_ids.length ?? 0,
    removed_repos: summary?.removed_repos ?? [],
    accounts,
    install_url: buildInstallUrl(),
  });
}
