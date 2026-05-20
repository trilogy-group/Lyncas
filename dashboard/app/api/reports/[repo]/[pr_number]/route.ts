import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { getPrReport, getWatchedRepos } from "@/lib/queries";

// GET /api/reports/[repo]/[pr_number]
//
// Single-report endpoint backing the sandbox card's "View Report"
// button. The chat page fetches this on click and renders the
// returned `report_markdown` inside an inline modal (no full-page
// navigation).
//
// Path convention: /[repo]/[pr_number] where {repo} is URL-encoded
// "owner/name". Next.js routes don't natively support a forward
// slash inside a segment, so the chat-side caller is responsible
// for `encodeURIComponent(repo)` before fetching.
//
// Auth: dashboard JWT. Same ownership filter as /api/reports —
// we 404 (rather than 403) when the caller doesn't watch the
// targeted repo, so we don't leak whether a report exists for a
// repo they don't own.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ repo: string; pr_number: string }>;
}

export async function GET(_req: NextRequest, context: RouteContext) {
  const { repo: encodedRepo, pr_number: prNumberStr } =
    await context.params;
  const repo = decodeURIComponent(encodedRepo);
  const prNumber = Number(prNumberStr);

  if (!repo.includes("/") || !Number.isFinite(prNumber) || prNumber <= 0) {
    return NextResponse.json(
      { error: "Invalid repo or pr_number" },
      { status: 400 },
    );
  }

  const user = await getUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Membership check before the DB read so we never surface a
  // report for a repo the caller doesn't own — even if the row
  // somehow leaked into pr_reports via a service-key write to
  // an unfamiliar repo.
  const watched = await getWatchedRepos(user.id);
  if (!watched.some((w) => w.repo === repo)) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  const report = await getPrReport(repo, prNumber);
  if (!report) {
    // Distinguishable from the ownership 404 only by absence of
    // ownership check failure — but to the dashboard it doesn't
    // matter, both render "not yet generated".
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  return NextResponse.json({ report });
}
