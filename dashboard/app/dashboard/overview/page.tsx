import Link from "next/link";
import { ActivityChart } from "@/components/activity-chart";
import { ExportReviewsButton } from "@/components/export-reviews-button";
import { Filters } from "@/components/filters";
import { MetricCard } from "@/components/metric-card";
import { ReviewsTable } from "@/components/reviews-table";
import { SeverityChart } from "@/components/severity-chart";
import { Container } from "@/components/ui/container";
import { GridBackdrop } from "@/components/ui/grid-backdrop";
import { Sparkline } from "@/components/ui/sparkline";
import { Stagger, StaggerItem } from "@/components/ui/motion";
import { TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import { formatCost, severityColor, severityColors } from "@/lib/design";
import {
  getActivityByDay,
  getAvailableRepos,
  getOverviewMetrics,
  getRecentReviews,
  getRepoStats,
  getRepoTrends,
  getSeverityDistribution,
} from "@/lib/queries";
import type { Action, Verdict } from "@/lib/types";

// /dashboard/overview — analytics surface. KPI cards with
// period-over-period deltas, an activity area chart + severity
// histogram, a per-repo table with inline trend sparklines, and the
// filterable / paginated recent-reviews feed.

export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;
const WINDOW_DAYS = 30;
const TREND_DAYS = 14;
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

function pctText(deltaPct: number | null): string | null {
  if (deltaPct === null || Math.abs(deltaPct) < 0.5) return null;
  return `${Math.abs(deltaPct).toFixed(0)}%`;
}

// Direction of a sparkline series: compare the recent half's volume to
// the earlier half. Returns the severity-ramp color so the cell reads
// green (rising) / red (falling) / muted (flat or empty).
function trendColor(counts: number[]): string {
  const total = counts.reduce((s, c) => s + c, 0);
  if (total === 0) return "#3a3a3a";
  const half = Math.floor(counts.length / 2);
  const first = counts.slice(0, half).reduce((s, c) => s + c, 0);
  const last = counts.slice(half).reduce((s, c) => s + c, 0);
  if (last > first) return severityColors.clean;
  if (last < first) return severityColors.critical;
  return "#9a9a9a";
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

  const [metrics, recent, repos, repoStats, repoTrends, severity, activity] =
    await Promise.all([
      getOverviewMetrics(WINDOW_DAYS),
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
      getRepoTrends(TREND_DAYS),
      getSeverityDistribution(WINDOW_DAYS),
      getActivityByDay(WINDOW_DAYS),
    ]);

  const trendByRepo = new Map(repoTrends.map((t) => [t.repo, t.counts]));
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

  // Windowed page numbers around the current page (max 5 shown).
  const pageWindow: number[] = [];
  {
    const span = 5;
    let start = Math.max(1, page - Math.floor(span / 2));
    const end = Math.min(totalPages, start + span - 1);
    start = Math.max(1, end - span + 1);
    for (let n = start; n <= end; n++) pageWindow.push(n);
  }

  const repoCount = repoStats.length;

  return (
    <div className="relative">
      <GridBackdrop tone="cyan" />
      <Container size="wide" className="relative space-y-8 py-10">
      {/* Header — mono eyebrow + title + meta, export action on the right. */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-strong">
            &gt; Overview
          </p>
          <h1 className="text-[30px] font-semibold leading-none tracking-[-0.02em] text-white">
            ANALYTICS
          </h1>
          <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted">
            Last {WINDOW_DAYS} days across {repoCount}{" "}
            {repoCount === 1 ? "repository" : "repositories"} · updated just now
          </p>
        </div>
        <ExportReviewsButton reviews={recent.reviews} />
      </header>

      {/* KPI row. */}
      <Stagger className="grid grid-cols-2 gap-3 lg:grid-cols-5" whenInView>
        <StaggerItem>
          <MetricCard
            label="Total reviews"
            value={metrics.reviews.value.toLocaleString()}
            glyph="comment"
            delta={metrics.reviews.delta}
            deltaText={pctText(metrics.reviews.deltaPct)}
            hint={`vs prev ${WINDOW_DAYS}d`}
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label="Auto-closed"
            value={metrics.closed.value.toLocaleString()}
            glyph="bolt"
            delta={metrics.closed.delta}
            deltaText={
              metrics.closed.delta !== 0
                ? String(Math.abs(metrics.closed.delta))
                : null
            }
            hint="3 gates passed"
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label={`Avg severity ${WINDOW_DAYS}d`}
            value={metrics.avgSeverity.value ? metrics.avgSeverity.value.toFixed(1) : "—"}
            glyph="alert"
            accent={
              metrics.avgSeverity.value
                ? severityColor(metrics.avgSeverity.value)
                : undefined
            }
            delta={metrics.avgSeverity.delta}
            deltaText={
              Math.abs(metrics.avgSeverity.delta) >= 0.05
                ? Math.abs(metrics.avgSeverity.delta).toFixed(1)
                : null
            }
            lowerIsBetter
            hint="lower is better"
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label={`Est. cost ${WINDOW_DAYS}d`}
            value={formatCost(metrics.cost.value)}
            glyph="dollar"
            delta={metrics.cost.delta}
            deltaText={pctText(metrics.cost.deltaPct)}
            hint="usage-based"
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label={`Agent accuracy ${WINDOW_DAYS}d`}
            value={
              metrics.accuracy.total > 0
                ? `${metrics.accuracy.value.toFixed(0)}%`
                : "—"
            }
            glyph="gauge"
            accent={
              metrics.accuracy.total > 0 && metrics.accuracy.value < 95
                ? severityColors.serious
                : undefined
            }
            delta={metrics.accuracy.total > 0 ? metrics.accuracy.delta : null}
            deltaText={
              metrics.accuracy.total > 0 && Math.abs(metrics.accuracy.delta) >= 0.5
                ? `${Math.abs(metrics.accuracy.delta).toFixed(0)}%`
                : null
            }
            hint={
              metrics.accuracy.total > 0
                ? `${metrics.accuracy.agreements} / ${metrics.accuracy.total} kept`
                : "no settled obs yet"
            }
          />
        </StaggerItem>
      </Stagger>

      {/* Charts. */}
      <section className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ActivityChart data={activity} days={WINDOW_DAYS} />
        </div>
        <div className="lg:col-span-2">
          <SeverityChart data={severity} />
        </div>
      </section>

      {/* By repository. */}
      {repoStats.length > 0 && (
        <section className="overflow-hidden rounded-md border border-border bg-card">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted-strong">
              <span className="text-muted/60" aria-hidden>
                ≡×
              </span>
              By repository
            </span>
            <Link
              href="/dashboard/repos"
              className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted transition-colors hover:text-white"
            >
              {WINDOW_DAYS}d →
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHeader>
                <tr>
                  <Th>Repository</Th>
                  <Th className="text-right">Reviews</Th>
                  <Th className="text-right">Auto-closed</Th>
                  <Th className="text-right">Avg severity</Th>
                  <Th className="text-right">Trend</Th>
                </tr>
              </TableHeader>
              <TableBody>
                {repoStats.map((r) => {
                  const counts = trendByRepo.get(r.repo) ?? [];
                  return (
                    <tr
                      key={r.repo}
                      className="transition-colors hover:bg-bg-elev"
                    >
                      <Td className="font-mono text-xs">
                        <Link
                          href={`/dashboard/overview?repo=${encodeURIComponent(r.repo)}`}
                          className="text-text underline-offset-4 hover:underline"
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
                      <Td className="text-right">
                        <span className="inline-flex items-center justify-end gap-1.5 font-mono text-xs tabular-nums">
                          {r.avg_severity ? (
                            <>
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{
                                  backgroundColor: severityColor(r.avg_severity),
                                }}
                                aria-hidden
                              />
                              <span style={{ color: severityColor(r.avg_severity) }}>
                                {r.avg_severity.toFixed(1)}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </span>
                      </Td>
                      <Td className="text-right">
                        <div className="flex justify-end">
                          <Sparkline data={counts} color={trendColor(counts)} />
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </TableBody>
            </table>
          </div>
        </section>
      )}

      {/* Recent reviews. */}
      <section className="overflow-hidden rounded-md border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <span className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted-strong">
            <span className="text-muted/60" aria-hidden>
              ≡×
            </span>
            Recent reviews
          </span>
          <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted">
            {recent.totalCount} results
          </span>
        </div>

        <div className="border-b border-border px-4 py-3">
          <Filters repos={repos} />
        </div>

        <ReviewsTable
          reviews={recent.reviews}
          currentSort={sortBy}
          currentDir={sortDir}
          baseSearchParams={baseSP}
          flush
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-[11px] font-mono uppercase tracking-[0.14em] text-muted">
          <div>
            {firstShown}–{lastShown} of {recent.totalCount}
          </div>
          <div className="flex items-center gap-1">
            {page > 1 ? (
              <Link
                href={pageLink(page - 1)}
                aria-label="Previous page"
                className="flex h-7 w-7 items-center justify-center rounded-sm border border-border text-muted transition-colors hover:border-border-strong hover:text-white"
              >
                ‹
              </Link>
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-border/50 text-muted/30">
                ‹
              </span>
            )}
            {pageWindow.map((n) => (
              <Link
                key={n}
                href={pageLink(n)}
                aria-current={n === page ? "page" : undefined}
                className={
                  "flex h-7 min-w-7 items-center justify-center rounded-sm border px-2 tabular-nums transition-colors " +
                  (n === page
                    ? "border-[#ffa760] text-[#ffa760]"
                    : "border-border text-muted hover:border-border-strong hover:text-white")
                }
              >
                {n}
              </Link>
            ))}
            {page < totalPages ? (
              <Link
                href={pageLink(page + 1)}
                aria-label="Next page"
                className="flex h-7 w-7 items-center justify-center rounded-sm border border-border text-muted transition-colors hover:border-border-strong hover:text-white"
              >
                ›
              </Link>
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-border/50 text-muted/30">
                ›
              </span>
            )}
          </div>
        </div>
      </section>
      </Container>
    </div>
  );
}
