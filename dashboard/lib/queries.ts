import { createSupabaseServerClient } from "./supabase/server";
import type {
  AccuracyStats,
  AccuracyTimePoint,
  ActivityPoint,
  Action,
  AgentAlert,
  BenchmarkRun,
  BenchmarkStats,
  DashboardStats,
  HumanAction,
  HumanActionType,
  HumanActionWithReview,
  PromptTunerRun,
  RepoRule,
  RepoRulesStatus,
  GitHubAppInstallation,
  RepoStat,
  Review,
  Run,
  SeverityBucket,
  SeverityBucketLabel,
  UserProfile,
  Verdict,
  WatchedRepo,
} from "./types";

// --- Cost pricing (shared by getStats and getRepoStats) -------------------
// Per-1M-token USD rates, in sync with agent/pr_reviewer.py's
// MODEL_PRICING_USD_PER_M_TOKENS and agent/send_digest.py's copy.
// Mirroring (not importing) avoids a cross-package dep.
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
const FALLBACK_MODEL = "claude-opus-4-5";

function rowCostUSD(
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number {
  const rates =
    PRICING_USD_PER_M_TOKENS[model ?? FALLBACK_MODEL] ??
    PRICING_USD_PER_M_TOKENS[FALLBACK_MODEL];
  return (
    ((inputTokens ?? 0) * rates.input + (outputTokens ?? 0) * rates.output) /
    1_000_000
  );
}

export async function getStats(daysWindow = 30): Promise<DashboardStats> {
  const supabase = await createSupabaseServerClient();
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
      .select("severity_score, input_tokens, output_tokens, model")
      .gte("created_at", since),
  ]);

  const totalReviews = totalRes.count ?? 0;
  const totalClosed = closedRes.count ?? 0;

  type WindowRow = {
    severity_score: number;
    input_tokens: number | null;
    output_tokens: number | null;
    model: string | null;
  };
  const windowData = (windowRes.data ?? []) as WindowRow[];
  const avgSeverity = windowData.length
    ? windowData.reduce((s, r) => s + (r.severity_score ?? 0), 0) /
      windowData.length
    : 0;
  // Per-row pricing: post-Phase-3 reviews have a `model` column; older rows
  // (model=null) fall back to Opus, which matches the production model since
  // Phase 1. Same approach getRepoStats uses, so the / overview cost and the
  // /repos per-row cost sum to the same number for any given window.
  const estimatedCostUSD = windowData.reduce(
    (sum, r) => sum + rowCostUSD(r.model, r.input_tokens, r.output_tokens),
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
  const supabase = await createSupabaseServerClient();
  let query = supabase.from("reviews").select("*", { count: "exact" });

  if (opts.repo) query = query.eq("repo", opts.repo);
  if (opts.verdict) query = query.eq("verdict", opts.verdict);
  if (opts.action) query = query.eq("action", opts.action);
  if (typeof opts.minSeverity === "number")
    query = query.gte("severity_score", opts.minSeverity);
  if (typeof opts.maxSeverity === "number")
    query = query.lte("severity_score", opts.maxSeverity);

  // Default to most-recent-first because that's what reviewers naturally
  // expect on a feed page. The /pr/[id] deep link still preserves whatever
  // sort the user picked via the URL.
  const sortBy = opts.sortBy ?? "created_at";
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
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("reviews")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as unknown as Review | null;
}

export async function getRuns(limit = 50): Promise<Run[]> {
  const supabase = await createSupabaseServerClient();
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
  const supabase = await createSupabaseServerClient();
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
  const supabase = await createSupabaseServerClient();
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
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("reviews").select("repo");
  if (error) throw error;
  const seen = new Set<string>();
  for (const r of (data ?? []) as { repo: string }[]) seen.add(r.repo);
  return Array.from(seen).sort();
}

// --- Per-repo stats (Phase 4) --------------------------------------------
// Pricing constants live above getStats so both functions can share them.

export async function getRepoStats(): Promise<RepoStat[]> {
  const supabase = await createSupabaseServerClient();
  const since30d = new Date(
    Date.now() - 30 * 86_400_000,
  ).toISOString();

  // Reviews + rules are pulled in parallel — the join is local so we
  // never block on PostgREST's foreign-key resolver. The rules table
  // (Phase 9) may be empty or missing rows for some repos; both cases
  // collapse to rules_status='none' in the merge below.
  const [reviewsRes, rulesRes] = await Promise.all([
    supabase
      .from("reviews")
      .select(
        "repo, action, severity_score, input_tokens, output_tokens, model, created_at",
      ),
    supabase.from("repo_rules").select("repo, enabled"),
  ]);
  if (reviewsRes.error) throw reviewsRes.error;
  // Rules table might not exist yet on a fresh database; tolerate that
  // by treating it as "no rules" rather than crashing the /repos page.
  const rulesByRepo = new Map<string, boolean>();
  if (!rulesRes.error) {
    for (const r of (rulesRes.data ?? []) as {
      repo: string;
      enabled: boolean;
    }[]) {
      rulesByRepo.set(r.repo, r.enabled);
    }
  }

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

  for (const r of ((reviewsRes.data ?? []) as Row[])) {
    let s = byRepo.get(r.repo);
    if (!s) {
      s = {
        repo: r.repo,
        total_reviews: 0,
        total_closed: 0,
        avg_severity: 0,
        estimated_cost_usd: 0,
        last_reviewed_at: null,
        rules_status: "none",
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
      s.estimated_cost_usd += rowCostUSD(
        r.model,
        r.input_tokens,
        r.output_tokens,
      );
    }
  }

  // Repos that have a rules row but no reviews yet still belong on
  // /repos so operators can configure them ahead of the first review.
  for (const [repo, enabled] of rulesByRepo.entries()) {
    if (!byRepo.has(repo)) {
      byRepo.set(repo, {
        repo,
        total_reviews: 0,
        total_closed: 0,
        avg_severity: 0,
        estimated_cost_usd: 0,
        last_reviewed_at: null,
        rules_status: enabled ? "enabled" : "disabled",
        _sev_sum: 0,
        _sev_n: 0,
      });
    }
  }

  return Array.from(byRepo.values())
    .map((s) => {
      const ruleEnabled = rulesByRepo.get(s.repo);
      const rules_status: RepoRulesStatus =
        ruleEnabled === undefined
          ? "none"
          : ruleEnabled
            ? "enabled"
            : "disabled";
      return {
        repo: s.repo,
        total_reviews: s.total_reviews,
        total_closed: s.total_closed,
        avg_severity: s._sev_n ? s._sev_sum / s._sev_n : 0,
        estimated_cost_usd: s.estimated_cost_usd,
        last_reviewed_at: s.last_reviewed_at,
        rules_status,
      };
    })
    .sort((a, b) => b.total_reviews - a.total_reviews);
}

// --- Phase 9: per-repo rules ---------------------------------------------
// Read-side is used by the dashboard's /settings page and by /repos (folded
// into getRepoStats above). Write-side is the only place the dashboard
// mutates Supabase — see agent/migrations/009_repo_rules.sql for the
// anon-write policy rationale.

export async function getRepoRule(repo: string): Promise<RepoRule | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("repo_rules")
    .select("*")
    .eq("repo", repo)
    .maybeSingle();
  if (error) {
    // Tolerate the table being absent on a fresh database (PGRST205 /
    // 42P01). The settings page will render with empty defaults and
    // the upsert will surface a clearer error if write also fails.
    return null;
  }
  return (data ?? null) as unknown as RepoRule | null;
}

export async function upsertRepoRule(
  rule: Partial<RepoRule> & { repo: string },
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("repo_rules")
    .upsert(rule, { onConflict: "repo" });
  if (error) throw error;
}

// --- Phase 7: self-learning queries --------------------------------------
// All four read from the public anon role. RLS policies on human_actions
// and agent_alerts (see migrations 006 + 007) explicitly grant anon SELECT.

const AGREEMENT_TYPES: ReadonlySet<HumanActionType> = new Set([
  "agreement_close",
  "agreement_approve",
]);
const FAILURE_TYPES: ReadonlySet<HumanActionType> = new Set([
  "false_close",
  "missed_issue",
]);

export async function getHumanAction(
  reviewId: string,
): Promise<HumanAction | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("human_actions")
    .select("*")
    .eq("review_id", reviewId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as unknown as HumanAction | null;
}

export async function getAccuracyStats(
  daysWindow = 30,
): Promise<AccuracyStats> {
  const supabase = await createSupabaseServerClient();
  const since = new Date(
    Date.now() - daysWindow * 86_400_000,
  ).toISOString();

  const { data, error } = await supabase
    .from("human_actions")
    .select("action_type")
    .gte("observed_at", since);
  if (error) throw error;

  let agreements = 0;
  let failures = 0;
  let pending = 0;
  for (const r of (data ?? []) as { action_type: HumanActionType }[]) {
    if (AGREEMENT_TYPES.has(r.action_type)) agreements += 1;
    else if (FAILURE_TYPES.has(r.action_type)) failures += 1;
    else pending += 1;
  }
  const total_non_pending = agreements + failures;
  const accuracy_pct = total_non_pending
    ? (agreements / total_non_pending) * 100
    : 0;
  return { total_non_pending, agreements, failures, pending, accuracy_pct };
}

export async function getAccuracyOverTime(
  daysWindow = 90,
): Promise<AccuracyTimePoint[]> {
  const supabase = await createSupabaseServerClient();
  const since = new Date(
    Date.now() - daysWindow * 86_400_000,
  ).toISOString();

  // Pull every non-pending action in the window, then bucket by observed
  // day. Days with no non-pending observations are simply omitted — the
  // chart renders them as gaps rather than misleading 0% points.
  const { data, error } = await supabase
    .from("human_actions")
    .select("action_type, observed_at")
    .gte("observed_at", since)
    .neq("action_type", "pending");
  if (error) throw error;

  const byDay = new Map<string, { agree: number; total: number }>();
  for (const r of (data ?? []) as {
    action_type: HumanActionType;
    observed_at: string;
  }[]) {
    const day = r.observed_at.slice(0, 10);
    const bucket = byDay.get(day) ?? { agree: 0, total: 0 };
    bucket.total += 1;
    if (AGREEMENT_TYPES.has(r.action_type)) bucket.agree += 1;
    byDay.set(day, bucket);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { agree, total }]) => ({
      date,
      accuracy_pct: total ? (agree / total) * 100 : 0,
      total,
    }));
}

export async function getRecentMisses(
  limit = 50,
): Promise<HumanActionWithReview[]> {
  const supabase = await createSupabaseServerClient();
  // Two-step: pull misses first, then enrich with review fields. PostgREST
  // joins through RLS-enabled tables can be fiddly; explicit fetch keeps
  // the data shape obvious and the query plan trivial.
  const { data: actions, error } = await supabase
    .from("human_actions")
    .select("*")
    .in("action_type", ["false_close", "missed_issue"])
    .order("observed_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = (actions ?? []) as HumanAction[];
  if (rows.length === 0) return [];

  const reviewIds = rows.map((r) => r.review_id);
  const { data: reviewsData, error: rErr } = await supabase
    .from("reviews")
    .select("id, repo, pr_number, pr_url, pr_title")
    .in("id", reviewIds);
  if (rErr) throw rErr;

  type ReviewLite = {
    id: string;
    repo: string;
    pr_number: number;
    pr_url: string;
    pr_title: string;
  };
  const byId = new Map<string, ReviewLite>();
  for (const r of (reviewsData ?? []) as ReviewLite[]) byId.set(r.id, r);

  const out: HumanActionWithReview[] = [];
  for (const a of rows) {
    const r = byId.get(a.review_id);
    if (!r) continue; // review row went away (cascade delete); skip
    out.push({
      ...a,
      repo: r.repo,
      pr_number: r.pr_number,
      pr_url: r.pr_url,
      pr_title: r.pr_title,
    });
  }
  return out;
}

export async function getAgentAlerts(
  onlyUnresolved = true,
): Promise<AgentAlert[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("agent_alerts")
    .select("*")
    .order("raised_at", { ascending: false });
  if (onlyUnresolved) query = query.is("resolved_at", null);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as AgentAlert[];
}

// --- Phase 8: prompt-tuner runs ------------------------------------------
// Each row is a PR opened by agent/prompt_tuner.py against the agent
// repo. The script flips `status` to merged / closed when it polls
// GitHub on subsequent runs, so this filter stays accurate without the
// dashboard hitting the GitHub API.

export async function getOpenPromptTunerRuns(): Promise<PromptTunerRun[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("prompt_tuner_runs")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as PromptTunerRun[];
}

// --- Benchmark queries ----------------------------------------------------

export async function getBenchmarkRuns(): Promise<BenchmarkRun[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("benchmark_runs")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as BenchmarkRun[];
}

export async function getBenchmarkStats(): Promise<BenchmarkStats> {
  const supabase = await createSupabaseServerClient();
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

// --- v2 SaaS: user profile + watched repos --------------------------------
// All three of these read auth.uid()-scoped tables (RLS-protected by
// migration 010). They're called from /dashboard/* server components,
// never from the legacy v1 demo routes.

// Sensible defaults rendered when no profile row exists yet (rare race
// between OAuth callback insert and the first dashboard hit, or a
// Supabase outage that failed the upsert).
const DEFAULT_PROFILE: Omit<UserProfile, "id" | "created_at"> = {
  email: null,
  github_username: null,
  display_name: null,
  avatar_url: null,
  plan: "free",
  repo_limit: 2,
};

export async function getUserProfile(
  userId: string,
): Promise<UserProfile | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    // Table missing or RLS misconfigured — render with defaults rather
    // than 500. The connect-repo guard uses repo_limit, which falls
    // back to the free-plan number in DEFAULT_PROFILE.
    return null;
  }
  if (data) return data as unknown as UserProfile;
  // Phantom-row fallback: the JWT is valid but the profile upsert in
  // /auth/callback didn't land. Synthesize one in memory so the page
  // still renders.
  return {
    id: userId,
    created_at: new Date().toISOString(),
    ...DEFAULT_PROFILE,
  };
}

export async function getWatchedRepos(
  userId: string,
): Promise<WatchedRepo[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("watched_repos")
    .select(
      "id, created_at, user_id, repo, enabled, github_installation_id, token_type",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) return [];
  // Pre-011 rows have neither column; coerce them to the PAT shape so
  // downstream code can rely on the discriminator being set.
  return ((data ?? []) as unknown as Array<Partial<WatchedRepo>>).map(
    (r) => ({
      id: r.id!,
      created_at: r.created_at!,
      user_id: r.user_id!,
      repo: r.repo!,
      enabled: r.enabled ?? true,
      github_installation_id: r.github_installation_id ?? null,
      token_type: (r.token_type as WatchedRepo["token_type"]) ?? "pat",
    }),
  );
}

// --- v2 SaaS: GitHub App installations -----------------------------------
// Used by /dashboard/connect-repo (post-install reconciliation) and by
// /auth/github-app/callback (the upsert path). Service-role would also
// work here but we deliberately stay on the user's anon-keyed client so
// RLS enforces "you can only see your own installations".

export async function getGitHubAppInstallations(
  userId: string,
): Promise<GitHubAppInstallation[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("github_app_installations")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []) as unknown as GitHubAppInstallation[];
}

/**
 * Upsert one installation row, keyed on installation_id. The user_id
 * column is part of the payload (and the RLS WITH CHECK clause
 * enforces that the caller's auth.uid() matches), so an attacker
 * can't steal another user's install by guessing a numeric id.
 */
export async function upsertInstallation(
  data: Pick<
    GitHubAppInstallation,
    | "user_id"
    | "installation_id"
    | "account_login"
    | "account_type"
    | "repos_selected"
  >,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("github_app_installations")
    .upsert(data, { onConflict: "installation_id" });
  if (error) throw error;
}
