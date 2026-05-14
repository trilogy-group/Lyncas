import Link from "next/link";
import { ActivityChart } from "@/components/activity-chart";
import { Filters } from "@/components/filters";
import { ReviewsTable } from "@/components/reviews-table";
import { SeverityChart } from "@/components/severity-chart";
import { StatCard } from "@/components/ui/stat-card";
import { formatCost, severityColors } from "@/lib/design";
import {
  getActivityByDay,
  getAvailableRepos,
  getRecentReviews,
  getSeverityDistribution,
  getStats,
} from "@/lib/queries";
import type { Action, Verdict } from "@/lib/types";

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

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const page = Math.max(1, Number(sp.page) || 1);
  const sortBy: "severity_score" | "created_at" =
    sp.sortBy === "created_at" ? "created_at" : "severity_score";
  const sortDir: "asc" | "desc" = sp.sortDir === "asc" ? "asc" : "desc";

  const verdict = VERDICTS.includes(sp.verdict as Verdict)
    ? (sp.verdict as Verdict)
    : undefined;
  const action = ACTIONS.includes(sp.action as Action)
    ? (sp.action as Action)
    : undefined;
  const minSeverity = sp.minSev
    ? clamp(Number(sp.minSev), 1, 10)
    : undefined;
  const maxSeverity = sp.maxSev
    ? clamp(Number(sp.maxSev), 1, 10)
    : undefined;

  const [stats, recent, repos, severity, activity] = await Promise.all([
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
    getSeverityDistribution(30),
    getActivityByDay(30),
  ]);

  const totalPages = Math.max(1, Math.ceil(recent.totalCount / PAGE_SIZE));

  // baseSearchParams preserves everything EXCEPT page — used for pagination
  // links and the table's sortable-header links.
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
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      <section>
        <h1 className="text-xl font-semibold mb-1">Overview</h1>
        <p className="text-sm text-muted italic font-serif">
          everything the agent has seen
        </p>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total reviews"
          value={String(stats.totalReviews)}
        />
        <StatCard
          label="Auto-closed"
          value={String(stats.totalClosed)}
          accent={
            stats.totalClosed > 0 ? severityColors.critical : undefined
          }
        />
        <StatCard
          label="Avg severity (30d)"
          value={stats.avgSeverity ? stats.avgSeverity.toFixed(1) : "—"}
          hint="out of 10"
        />
        <StatCard
          label="Est. cost (30d)"
          value={formatCost(stats.estimatedCostUSD)}
          hint="claude sonnet"
        />
      </section>

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">Recent reviews</h2>
            <p className="text-xs text-muted font-mono">
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

        <div className="flex justify-between items-center text-xs font-mono text-muted">
          <div>
            showing {firstShown}–{lastShown} of {recent.totalCount}
          </div>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={pageLink(page - 1)}
                className="px-3 py-1.5 border border-border rounded bg-card hover:bg-bg"
              >
                ← prev
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={pageLink(page + 1)}
                className="px-3 py-1.5 border border-border rounded bg-card hover:bg-bg"
              >
                next →
              </Link>
            )}
          </div>
        </div>
      </section>

      <section className="grid md:grid-cols-2 gap-4">
        <SeverityChart data={severity} />
        <ActivityChart data={activity} />
      </section>
    </main>
  );
}
