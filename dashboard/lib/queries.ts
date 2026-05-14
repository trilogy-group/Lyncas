import { createSupabaseServerClient } from "./supabase/server";
import type {
  ActivityPoint,
  Action,
  DashboardStats,
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
