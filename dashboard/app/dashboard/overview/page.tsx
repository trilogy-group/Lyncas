import Link from "next/link";
import { ActivityChart } from "@/components/activity-chart";
import { Filters } from "@/components/filters";
import { ReviewsTable } from "@/components/reviews-table";
import { SeverityChart } from "@/components/severity-chart";
import { Container } from "@/components/ui/container";
import { Stagger, StaggerItem } from "@/components/ui/motion";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import { formatCost, severityColor, severityColors } from "@/lib/design";
import {
  getAccuracyStats,
  getActivityByDay,
  getAvailableRepos,
  getRecentReviews,
  getRepoStats,
  getSeverityDistribution,
  getStats,
} from "@/lib/queries";
import type { Action, Verdict } from "@/lib/types";

// /dashboard/overview — the authenticated user's "everything the agent
// has seen" surface. Black/E2B v3 aesthetic, with one inverted stat
// card (Total reviews) to break up the row visually.

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const VERDICTS: readonly Verdict[] = ["approve", "request_changes", "comment"];
const ACTIONS: readonly Action[] = ["commented", "closed"];

interface SearchParams {
  page?: string;
  repo?: string;
  verdict?: string;
  action?: string;
  minSev?: string;
  maxSev?: string;
  sortBy?: string;
  sortDir?: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export default async function DashboardOverviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const page = Math.max(1, Number(sp.page) || 1);
  const sortBy: "severity_score" | "created_at" =
    sp.sortBy === "severity_score" ? "severity_score" : "created_at";
  const sortDir: "asc" | "desc" = sp.sortDir === "asc" ? "asc" : "desc";

  const verdict = VERDICTS.includes(sp.verdict as Verdict)
    ? (sp.verdict as Verdict)
    : undefined;
  const action = ACTIONS.includes(sp.action as Action)
    ? (sp.action as Action)
    : undefined;
  const minSeverity = sp.minSev ? clamp(Number(sp.minSev), 1, 10) : undefined;
  const maxSeverity = sp.maxSev ? clamp(Number(sp.maxSev), 1, 10) : undefined;

  const [stats, recent, repos, repoStats, severity, activity, accuracy] =
    await Promise.all([
      getStats(30),
      getRecentReviews({
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        repo: sp.repo || undefined,
        verdict,
        action,
        minSeverity,
        maxSeverity,
        sortBy,
        sortDir,
      }),
      getAvailableRepos(),
      getRepoStats(),
      getSeverityDistribution(30),
      getActivityByDay(30),
      getAccuracyStats(30),
    ]);

  const totalPages = Math.max(1, Math.ceil(recent.totalCount / PAGE_SIZE));

  const baseSP = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v && k !== "page") baseSP.set(k, String(v));
  }
  const pageLink = (n: number) => {
    const next = new URLSearchParams(baseSP);
    next.set("page", String(n));
    return `?${next.toString()}`;
  };

  const firstShown =
    recent.reviews.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = (page - 1) * PAGE_SIZE + recent.reviews.length;

  return (
    <Container className="py-10 space-y-12">
      <SectionHeading
        eyebrow="Overview"
        title="Everything the agent has seen"
        subtitle="Live feed across every connected repository."
      />

      {/* KPI row — one inverted card to break up the rhythm. */}
      <Stagger className="grid grid-cols-2 gap-3 lg:grid-cols-5" whenInView>
        <StaggerItem>
          <StatCard label="Total reviews" value={String(stats.totalReviews)} invert />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Auto-closed"
            value={String(stats.totalClosed)}
            accent={stats.totalClosed > 0 ? severityColors.critical : undefined}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Avg severity (30d)"
            value={stats.avgSeverity ? stats.avgSeverity.toFixed(1) : "—"}
            hint="out of 10"
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Est. cost (30d)"
            value={formatCost(stats.estimatedCostUSD)}
            hint="claude opus-4-5"
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Agent accuracy (30d)"
            value={
              accuracy.total_non_pending > 0
                ? `${accuracy.accuracy_pct.toFixed(0)}%`
                : "—"
            }
            hint={
              accuracy.total_non_pending > 0
                ? `${accuracy.agreements} / ${accuracy.total_non_pending}`
                : "no settled obs yet"
            }
            accent={
              accuracy.total_non_pending > 0 && accuracy.accuracy_pct < 95
                ? severityColors.serious
                : undefined
            }
          />
        </StaggerItem>
      </Stagger>

      {repoStats.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-white">By repo</h2>
              <p className="text-[11px] text-muted font-mono uppercase tracking-[0.14em]">
                {repoStats.length}
                {repoStats.length === 1 ? " repo" : " repos"} watched
              </p>
            </div>
            <Link
              href="/dashboard/repos"
              className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted hover:text-white transition-colors"
            >
              full breakdown →
            </Link>
          </div>
          <Table>
            <TableHeader>
              <tr>
                <Th>Repo</Th>
                <Th className="text-right">Reviews</Th>
                <Th className="text-right">Closed</Th>
                <Th className="text-right">Avg severity</Th>
              </tr>
            </TableHeader>
            <TableBody>
              {repoStats.map((r) => (
                <tr key={r.repo} className="hover:bg-bg-elev transition-colors">
                  <Td className="font-mono text-xs">
                    <Link
                      href={`/dashboard/overview?repo=${encodeURIComponent(r.repo)}`}
                      className="text-white hover:underline underline-offset-4"
                    >
                      {r.repo}
                    </Link>
                  </Td>
                  <Td className="text-right font-mono text-xs tabular-nums">
                    {r.total_reviews}
                  </Td>
                  <Td
                    className="text-right font-mono text-xs tabular-nums"
                    style={
                      r.total_closed > 0
                        ? { color: severityColors.critical }
                        : undefined
                    }
                  >
                    {r.total_closed}
                  </Td>
                  <Td
                    className="text-right font-mono text-xs tabular-nums"
                    style={
                      r.avg_severity
                        ? { color: severityColor(r.avg_severity) }
                        : undefined
                    }
                  >
                    {r.avg_severity ? r.avg_severity.toFixed(1) : "—"}
                  </Td>
                </tr>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Recent reviews</h2>
            <p className="text-[11px] text-muted font-mono uppercase tracking-[0.14em]">
              {recent.totalCount} total · page {page} of {totalPages}
            </p>
          </div>
          <Filters repos={repos} />
        </div>

        <ReviewsTable
          reviews={recent.reviews}
          currentSort={sortBy}
          currentDir={sortDir}
          baseSearchParams={baseSP}
        />

        <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-[0.14em] text-muted">
          <div>
            showing {firstShown}–{lastShown} of {recent.totalCount}
          </div>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={pageLink(page - 1)}
                className="rounded-sm border border-border px-3 py-1.5 hover:border-border-strong hover:text-white transition-colors"
              >
                ← prev
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={pageLink(page + 1)}
                className="rounded-sm border border-border px-3 py-1.5 hover:border-border-strong hover:text-white transition-colors"
              >
                next →
              </Link>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <SeverityChart data={severity} />
        <ActivityChart data={activity} />
      </section>
    </Container>
  );
}
