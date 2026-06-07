import { redirect } from "next/navigation";
import { ExternalLinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { GridBackdrop } from "@/components/ui/grid-backdrop";
import { SectionHeading } from "@/components/ui/section-heading";
import { ReportCard } from "@/components/report-card";
import { getPrReports, getWatchedRepos } from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";
import type { PrReport } from "@/lib/types";

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

// Recommendation buckets, in the order they should appear on the page.
// Mirrors the verdict accent set used on the report cards / design brief.
const REC_ORDER = [
  { key: "merge", label: "Merge", color: "#58e684" },
  { key: "request_changes", label: "Request changes", color: "#f6c25b" },
  { key: "reject", label: "Reject", color: "#ff5a5a" },
  { key: "needs_review", label: "Needs review", color: "#5bd3ff" },
] as const;

export default async function DashboardReportsPage() {
  const user = await getUser().catch(() => null);
  if (!user) redirect("/login");

  const watched = await getWatchedRepos(user.id);
  const repoList = watched.map((w) => w.repo);
  const reports = await getPrReports(repoList);
  const installUrl = appInstallUrl();

  // Bucket reports by merge recommendation so the page reads as
  // "decisions grouped by outcome" rather than one long undifferentiated
  // feed. Within a bucket, the query's order (newest first) is kept.
  const grouped = new Map<string, PrReport[]>();
  for (const r of reports) {
    const k = r.merge_recommendation ?? "needs_review";
    const arr = grouped.get(k) ?? [];
    arr.push(r);
    grouped.set(k, arr);
  }

  return (
    <div className="relative">
      <GridBackdrop tone="amber" />
      <Container className="relative py-10 space-y-8">
      <SectionHeading
        eyebrow="Reports"
        title="ANALYSIS REPORTS"
        subtitle={
          reports.length === 0
            ? "Reports are generated automatically when PRs are opened on connected repositories."
            : `${reports.length} ${reports.length === 1 ? "report" : "reports"
            } across ${watched.length} ${watched.length === 1 ? "repo" : "repos"
            }, grouped by merge recommendation.`
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
        <>
          {/* Summary chips — one per non-empty bucket, accent-coded. */}
          <div className="flex flex-wrap gap-2">
            {REC_ORDER.map(({ key, label, color }) => {
              const n = grouped.get(key)?.length ?? 0;
              if (n === 0) return null;
              return (
                <span
                  key={key}
                  className="inline-flex items-center gap-2 rounded-sm border px-2.5 py-1 font-mono text-[11px]"
                  style={{ borderColor: `${color}55`, background: `${color}14` }}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: color }}
                    aria-hidden
                  />
                  <span style={{ color }}>{label}</span>
                  <span className="text-muted-strong tabular-nums">{n}</span>
                </span>
              );
            })}
          </div>

          {/* Grouped sections. */}
          <div className="space-y-10">
            {REC_ORDER.map(({ key, label, color }) => {
              const bucket = grouped.get(key);
              if (!bucket || bucket.length === 0) return null;
              return (
                <section key={key} className="space-y-4">
                  <div className="flex items-center gap-3">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: color }}
                      aria-hidden
                    />
                    <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-white">
                      {label}
                    </h2>
                    <span className="font-mono text-[11px] text-muted tabular-nums">
                      {bucket.length}
                    </span>
                    <span className="h-px flex-1 bg-border" aria-hidden />
                  </div>
                  <div className="space-y-4">
                    {bucket.map((r) => (
                      <ReportCard key={r.id} report={r} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
      </Container>
    </div>
  );
}
