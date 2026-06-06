import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { getPrReports, getWatchedRepos } from "@/lib/queries";

// GET /api/reports
//
// Returns the PR analysis reports (migration 018 / pr_reports) for
// repositories the caller has connected via the GitHub App. The
// page surface (/dashboard/reports) renders these directly via
// server-component data fetching; this route exists for the chat
// sandbox card's "View Report" button, which loads the report list
// on demand from the client.
//
// Auth: standard Supabase JWT (dashboard session). DevPod-token
// auth is intentionally NOT supported here — the `lyncas` CLI doesn't
// need a reports endpoint (it asks Claude directly via /api/chat),
// and supporting both auth modes here would require widening the
// principal type that getWatchedRepos accepts. We keep this route
// JWT-only for now.
//
// Ownership scope: pr_reports has a permissive RLS policy (see
// migration 018 header), so the database itself returns rows for
// ANY repo. The actual ownership filter lives here: we look up
// the caller's watched_repos and pass that list as the IN clause
// to getPrReports. If a row in pr_reports references a repo the
// caller doesn't own, it's dropped before serialization.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const user = await getUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const watched = await getWatchedRepos(user.id);
  const repoList = watched.map((r) => r.repo);
  // Fast path: a user with no connected repos can't have any reports
  // either, and skipping the IN-clause round-trip avoids a 400 from
  // PostgREST on an empty list.
  if (repoList.length === 0) {
    return NextResponse.json({ reports: [] });
  }

  const reports = await getPrReports(repoList);
  return NextResponse.json({ reports });
}
