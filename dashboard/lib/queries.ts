import { createSupabaseServerClient } from "./supabase/server";
import type {
  ActivityPoint,
  Action,
  BenchmarkRun,
  BenchmarkStats,
  DashboardStats,
  RepoStat,
  Review,
  Run,
  SeverityBucket,
  SeverityBucketLabel,
  Verdict,
} from "./types";

export async function getStats(daysWindow = 30): Promise<DashboardStats> {
  const supabase = createSupabaseServerClient();
  const since = new Date(
    Date.now() - daysWindow * 86_400_000,
  ).toISOString();

  const [totalRes, closedRes, windowRes] = await Promise.all([
    supabase.from("reviews").select("id", { count: "exact", head: true }),
    supabase
      .from("reviews")
      .select("id", { count: "exact", head: true })
      .eq("action", "closed"),
    supabase
      .from("reviews")
      .select("severity_score, input_tokens, output_tokens")
      .gte("created_at", since),
  ]);

  const totalReviews = totalRes.count ?? 0;
  const totalClosed = closedRes.count ?? 0;

  type WindowRow = {
    severity_score: number;
    input_tokens: number | null;
    output_tokens: number | null;
  };
  const windowData = (windowRes.data ?? []) as WindowRow[];
  const avgSeverity = windowData.length
    ? windowData.reduce((s, r) => s + (r.severity_score ?? 0), 0) /
      windowData.length
    : 0;
  const estimatedCostUSD = windowData.reduce(
    (sum, r) =>
      sum +
      ((r.input_tokens ?? 0) * 3 + (r.output_tokens ?? 0) * 15) / 1_000_000,
    0,
  );

  return { totalReviews, totalClosed, avgSeverity, estimatedCostUSD };
}

export interface RecentReviewsOptions {
  limit: number;
  offset: number;
  repo?: string;
  verdict?: Verdict;
  action?: Action;
  minSeverity?: number;
  maxSeverity?: number;
  sortBy?: "severity_score" | "created_at";
  sortDir?: "asc" | "desc";
}

export async function getRecentReviews(
  opts: RecentReviewsOptions,
): Promise<{ reviews: Review[]; totalCount: number }> {
  const supabase = createSupabaseServerClient();
  let query = supabase.from("reviews").select("*", { count: "exact" });

  if (opts.repo) query = query.eq("repo", opts.repo);
  if (opts.verdict) query = query.eq("verdict", opts.verdict);
  if (opts.action) query = query.eq("action", opts.action);
  if (typeof opts.minSeverity === "number")
    query = query.gte("severity_score", opts.minSeverity);
  if (typeof opts.maxSeverity === "number")
    query = query.lte("severity_score", opts.maxSeverity);

  const sortBy = opts.sortBy ?? "severity_score";
  const sortDir = opts.sortDir ?? "desc";
  query = query.order(sortBy, { ascending: sortDir === "asc" });
  if (sortBy !== "created_at") {
    // tie-break by recency so identical severities sort deterministically
    query = query.order("created_at", { ascending: false });
  }

  query = query.range(opts.offset, opts.offset + opts.limit - 1);

  const { data, count, error } = await query;
  if (error) throw error;
  return {
    reviews: (data ?? []) as unknown as Review[],
    totalCount: count ?? 0,
  };
}

export async function getReviewById(id: string): Promise<Review | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("reviews")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as unknown as Review | null;
}

export async function getRuns(limit = 50): Promise<Run[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as Run[];
}

export async function getSeverityDistribution(
  daysWindow = 30,
): Promise<SeverityBucket[]> {
  const supabase = createSupabaseServerClient();
  const since = new Date(
    Date.now() - daysWindow * 86_400_000,
  ).toISOString();
  const { data, error } = await supabase
    .from("reviews")
    .select("severity_score")
    .gte("created_at", since);
  if (error) throw error;

  const buckets: Record<SeverityBucketLabel, number> = {
    "1-3": 0,
    "4-6": 0,
    "7-8": 0,
    "9-10": 0,
  };
  for (const r of (data ?? []) as { severity_score: number }[]) {
    const s = r.severity_score;
    if (s >= 9) buckets["9-10"]++;
    else if (s >= 7) buckets["7-8"]++;
    else if (s >= 4) buckets["4-6"]++;
    else buckets["1-3"]++;
  }
  return (["1-3", "4-6", "7-8", "9-10"] as const).map((bucket) => ({
    bucket,
    count: buckets[bucket],
  }));
}

export async function getActivityByDay(
  daysWindow = 30,
): Promise<ActivityPoint[]> {
  const supabase = createSupabaseServerClient();
  const since = new Date(
    Date.now() - daysWindow * 86_400_000,
  ).toISOString();
  const { data, error } = await supabase
    .from("reviews")
    .select("created_at")
    .gte("created_at", since);
  if (error) throw error;

  // Pre-seed every day in the window so the line chart has no gaps.
  const byDay = new Map<string, number>();
  for (let i = daysWindow - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const r of (data ?? []) as { created_at: string }[]) {
    const day = r.created_at.slice(0, 10);
    if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return Array.from(byDay.entries()).map(([date, count]) => ({ date, count }));
}

export async function getAvailableRepos(): Promise<string[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.from("reviews").select("repo");
  if (error) throw error;
  const seen = new Set<string>();
  for (const r of (data ?? []) as { repo: string }[]) seen.add(r.repo);
  return Array.from(seen).sort();
}

// --- Per-repo stats (Phase 4) --------------------------------------------
// Per-1M-token USD rates. Kept in sync with agent/pr_reviewer.py's
// MODEL_PRICING_USD_PER_M_TOKENS and agent/send_digest.py's copy of the
// same table. Mirroring (not importing) avoids a cross-package dependency.
const PRICING_USD_PER_M_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
};
// Reviews predating Phase 3's `model` column have model=null. Phase 1 made
// Opus the production model, so falling back to Opus matches reality for
// the rows we'd realistically see in production.
const REPO_STATS_FALLBACK_MODEL = "claude-opus-4-5";

export async function getRepoStats(): Promise<RepoStat[]> {
  const supabase = createSupabaseServerClient();
  const since30d = new Date(
    Date.now() - 30 * 86_400_000,
  ).toISOString();

  const { data, error } = await supabase
    .from("reviews")
    .select(
      "repo, action, severity_score, input_tokens, output_tokens, model, created_at",
    );
  if (error) throw error;

  type Row = {
    repo: string;
    action: string | null;
    severity_score: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    model: string | null;
    created_at: string;
  };

  type Accum = RepoStat & { _sev_sum: number; _sev_n: number };
  const byRepo = new Map<string, Accum>();

  for (const r of ((data ?? []) as Row[])) {
    let s = byRepo.get(r.repo);
    if (!s) {
      s = {
        repo: r.repo,
        total_reviews: 0,
        total_closed: 0,
        avg_severity: 0,
        estimated_cost_usd: 0,
        last_reviewed_at: null,
        _sev_sum: 0,
        _sev_n: 0,
      };
      byRepo.set(r.repo, s);
    }
    s.total_reviews += 1;
    if (r.action === "closed") s.total_closed += 1;
    if (typeof r.severity_score === "number") {
      s._sev_sum += r.severity_score;
      s._sev_n += 1;
    }
    if (!s.last_reviewed_at || r.created_at > s.last_reviewed_at) {
      s.last_reviewed_at = r.created_at;
    }
    if (r.created_at >= since30d) {
      const rates =
        PRICING_USD_PER_M_TOKENS[r.model ?? REPO_STATS_FALLBACK_MODEL] ??
        PRICING_USD_PER_M_TOKENS[REPO_STATS_FALLBACK_MODEL];
      s.estimated_cost_usd +=
        ((r.input_tokens ?? 0) * rates.input +
          (r.output_tokens ?? 0) * rates.output) /
        1_000_000;
    }
  }

  return Array.from(byRepo.values())
    .map((s) => ({
      repo: s.repo,
      total_reviews: s.total_reviews,
      total_closed: s.total_closed,
      avg_severity: s._sev_n ? s._sev_sum / s._sev_n : 0,
      estimated_cost_usd: s.estimated_cost_usd,
      last_reviewed_at: s.last_reviewed_at,
    }))
    .sort((a, b) => b.total_reviews - a.total_reviews);
}

// --- Benchmark queries ----------------------------------------------------

export async function getBenchmarkRuns(): Promise<BenchmarkRun[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("benchmark_runs")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as BenchmarkRun[];
}

export async function getBenchmarkStats(): Promise<BenchmarkStats> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("benchmark_runs")
    .select(
      "verdict_agreement, severity_delta, bug_overlap_count, bugs_only_in_sonnet, bugs_only_in_opus, sonnet_cost_micros, opus_cost_micros",
    );
  if (error) throw error;

  type Row = {
    verdict_agreement: boolean | null;
    severity_delta: number | null;
    bug_overlap_count: number | null;
    bugs_only_in_sonnet: number | null;
    bugs_only_in_opus: number | null;
    sonnet_cost_micros: number | null;
    opus_cost_micros: number | null;
  };
  // Only count benchmarks that completed the Opus side — verdict_agreement
  // being non-null is the signal that the comparison was actually computed.
  const rows = ((data ?? []) as Row[]).filter(
    (r) => r.verdict_agreement !== null,
  );
  const sample_size = rows.length;

  if (sample_size === 0) {
    return {
      sample_size: 0,
      agreement_pct: 0,
      mean_sev_delta: 0,
      mean_bug_overlap_pct: 0,
      cost_ratio: 0,
    };
  }

  const agreed = rows.filter((r) => r.verdict_agreement === true).length;
  const agreement_pct = (agreed / sample_size) * 100;

  const mean_sev_delta =
    rows.reduce((s, r) => s + (r.severity_delta ?? 0), 0) / sample_size;

  // Per-row bug overlap %, then averaged. Rows where both models reported
  // zero bugs count as 100% (vacuous agreement on "no bugs found").
  const overlapPcts = rows.map((r) => {
    const ov = r.bug_overlap_count ?? 0;
    const total = ov + (r.bugs_only_in_sonnet ?? 0) + (r.bugs_only_in_opus ?? 0);
    return total === 0 ? 100 : (ov / total) * 100;
  });
  const mean_bug_overlap_pct =
    overlapPcts.reduce((s, p) => s + p, 0) / sample_size;

  const sumSonnet = rows.reduce(
    (s, r) => s + (r.sonnet_cost_micros ?? 0),
    0,
  );
  const sumOpus = rows.reduce((s, r) => s + (r.opus_cost_micros ?? 0), 0);
  const cost_ratio = sumSonnet > 0 ? sumOpus / sumSonnet : 0;

  return {
    sample_size,
    agreement_pct,
    mean_sev_delta,
    mean_bug_overlap_pct,
    cost_ratio,
  };
}
