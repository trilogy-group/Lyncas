import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import { createInstallationToken, getInstallation } from "@/lib/github-app";

// GET /api/github-app/status
//
// Authoritative answer to "does this user still have a working GitHub
// App installation?". Returns:
//
//   {
//     healthy: number,                    // live installations on GitHub
//     stale:   number,                    // rows we have but GitHub no
//                                         // longer recognizes (user
//                                         // uninstalled the App without
//                                         // us hearing about it)
//     accounts: { login, installation_id }[],
//     install_url: string | null,         // null when no app slug configured
//   }
//
// Why this exists: every other surface in the dashboard reads from
// Supabase's watched_repos / github_app_installations cache, which is
// not updated when the user uninstalls the App on GitHub (we don't
// subscribe to the `installation.deleted` webhook yet). The chat page
// uses this route on mount to decide whether to show a "Please install"
// modal — if every recorded installation comes back stale we know the
// cache is lying.
//
// We deliberately do NOT delete stale rows here. A reconcile sweep is
// safer to do once, server-side, with full visibility — and an
// authenticated GET route is the wrong place to mutate state.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface InstallationRow {
  installation_id: number;
  account_login: string | null;
}

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
      stale: 0,
      accounts: [],
      install_url: buildInstallUrl(),
      degraded: true,
    });
  }

  const rows = (data ?? []) as InstallationRow[];

  // Probe each installation in parallel. A 404 from
  // GET /app/installations/{id} (or any thrown error from the helper)
  // means GitHub no longer recognizes the installation — the user
  // uninstalled, was removed from the org, or the App was rotated.
  const results = await Promise.all(
    rows.map(async (row) => {
      try {
        const inst = await getInstallation(row.installation_id);
        // Also confirm we can actually mint a token. /app/installations
        // returning data without /access_tokens working has been
        // observed when the install is suspended; treat that as stale.
        await createInstallationToken(row.installation_id);
        return {
          ok: true as const,
          installation_id: row.installation_id,
          account_login: inst.account.login,
        };
      } catch {
        return { ok: false as const, installation_id: row.installation_id };
      }
    }),
  );

  const accounts = results
    .filter((r): r is { ok: true; installation_id: number; account_login: string } => r.ok)
    .map((r) => ({
      login: r.account_login,
      installation_id: r.installation_id,
    }));
  const healthy = accounts.length;
  const stale = results.length - healthy;

  return NextResponse.json({
    healthy,
    stale,
    accounts,
    install_url: buildInstallUrl(),
  });
}
