import { redirect } from "next/navigation";
import { ExternalLinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { ReportCard } from "@/components/report-card";
import { getPrReports, getWatchedRepos } from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";

// /dashboard/reports
//
// User-scoped feed of PR analysis reports. Each row is one entry in
// pr_reports (migration 018) constrained to the caller's
// watched_repos — the table itself is RLS-permissive, but we scope
// at the query layer so leftover rows from a repo the user has
// since disconnected don't surface here.
//
// Pure server component: no client state at this layer. The
// per-card expand toggle + download button live in
// components/report-card.tsx ("use client").
//
// Empty state: deliberately matches the tone of /dashboard/repos's
// empty state — informative, with a path forward ("install the
// GitHub App to enable this surface"), not just a blank "no rows".

export const dynamic = "force-dynamic";

function appInstallUrl(): string | null {
  const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  if (!slug) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}

export default async function DashboardReportsPage() {
  const user = await getUser().catch(() => null);
  if (!user) redirect("/login");

  const watched = await getWatchedRepos(user.id);
  const repoList = watched.map((w) => w.repo);
  const reports = await getPrReports(repoList);
  const installUrl = appInstallUrl();

  // Group by status counts for the eyebrow line. Useful at a glance
  // and avoids the user having to scroll to see how many requests-
  // for-change there are.
  const counts = reports.reduce(
    (acc, r) => {
      const k = r.merge_recommendation ?? "needs_review";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const subtitleParts: string[] = [];
  if (counts.merge) subtitleParts.push(`${counts.merge} merge`);
  if (counts.request_changes)
    subtitleParts.push(`${counts.request_changes} request changes`);
  if (counts.reject) subtitleParts.push(`${counts.reject} reject`);
  if (counts.needs_review)
    subtitleParts.push(`${counts.needs_review} needs review`);

  return (
    <Container className="py-10 space-y-8">
      <SectionHeading
        eyebrow="📊 PR Reports"
        title="Per-PR analysis at a glance"
        subtitle={
          reports.length === 0
            ? "Reports are generated automatically when PRs are opened on connected repositories."
            : `${reports.length} ${
                reports.length === 1 ? "report" : "reports"
              } across ${watched.length} ${
                watched.length === 1 ? "repo" : "repos"
              }${subtitleParts.length > 0 ? ` · ${subtitleParts.join(" · ")}` : ""}`
        }
      />

      {reports.length === 0 ? (
        <Card className="space-y-5 p-12 text-center" tone="elev">
          <div className="space-y-2">
            <p className="text-sm text-muted-strong">
              No reports yet. Reports are generated automatically when PRs
              are opened on connected repositories.
            </p>
            {watched.length === 0 && (
              <p className="text-xs text-muted">
                You haven&apos;t connected any repositories yet. Install
                the Lyncas GitHub App on the repo you want
                analyzed — every new PR there will produce a report here.
              </p>
            )}
          </div>
          {installUrl && watched.length === 0 && (
            <div className="flex justify-center">
              <ExternalLinkButton href={installUrl} variant="primary">
                Install Lyncas →
              </ExternalLinkButton>
            </div>
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          {reports.map((r) => (
            <ReportCard key={r.id} report={r} />
          ))}
        </div>
      )}
    </Container>
  );
}
