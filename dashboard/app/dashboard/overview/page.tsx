import Link from "next/link";
import { ActivityChart } from "@/components/activity-chart";
import { Filters } from "@/components/filters";
import { ReviewsTable } from "@/components/reviews-table";
import { SeverityChart } from "@/components/severity-chart";
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

// /dashboard/overview — the authenticated user's home. Same shape as
// the v1 root overview (which has moved to a /landing-redirect now
// that the root is session-aware), but rendered behind the auth gate.
//
// User scoping: this v2 launch deliberately shows shared demo data
// (rows with user_id IS NULL or matching the user). The reviews +
// runs tables don't enforce per-user RLS yet — that's a v3 cutover
// once the agent's writes start setting user_id. See migration
// 010_saas_auth.sql header for the cutover plan. For now every
// authenticated user sees the same global feed, which is the right
// thing for the launch demo.

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
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      <section>
        <h1 className="text-xl font-semibold mb-1">Overview</h1>
        <p className="text-sm text-muted italic font-serif">
          everything the agent has seen
        </p>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Total reviews" value={String(stats.totalReviews)} />
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
          hint="claude opus-4-5"
        />
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
      </section>

      {repoStats.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">By repo</h2>
            <p className="text-xs text-muted font-mono">
              {repoStats.length}
              {repoStats.length === 1 ? " repo" : " repos"} watched ·{" "}
              <Link
                href="/dashboard/repos"
                className="underline hover:text-text"
              >
                full breakdown →
              </Link>
            </p>
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
                <tr key={r.repo}>
                  <Td className="font-mono text-xs">
                    <Link
                      href={`/dashboard/overview?repo=${encodeURIComponent(r.repo)}`}
                      className="text-accent hover:underline"
                    >
                      {r.repo}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs text-right">
                    {r.total_reviews}
                  </Td>
                  <Td
                    className="font-mono text-xs text-right"
                    style={
                      r.total_closed > 0
                        ? { color: severityColors.critical }
                        : undefined
                    }
                  >
                    {r.total_closed}
                  </Td>
                  <Td
                    className="font-mono text-xs text-right"
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

      {/* Floating chat launcher. Anchored to the viewport (fixed),
          right-aligned, above the bottom edge. Pure CSS — no JS needed
          because the destination is server-rendered. */}
      <Link
        href="/dashboard/chat"
        aria-label="Open repository chat"
        title="Ask the agent about your repos"
        className="fixed bottom-6 right-6 z-30 flex items-center gap-2 px-4 py-3 rounded-full shadow-lg text-sm font-medium text-white hover:opacity-90 transition"
        style={{ backgroundColor: "#4338ca" }}
      >
        <ChatBubbleIcon />
        <span className="hidden sm:inline">Ask the agent</span>
      </Link>
    </main>
  );
}

function ChatBubbleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
