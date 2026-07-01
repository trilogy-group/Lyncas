// Types match the SQL schema in agent/migrations/001_initial_schema.sql.
// Keep these in sync if the schema ever changes.

export type Verdict = "approve" | "request_changes" | "comment";
export type Confidence = "high" | "medium" | "low";
export type Action = "commented" | "closed";
export type BugSeverity = "high" | "medium" | "low";

// The agent's JSON schema (see agent/review_graph.py) emits a richer
// `severity` set than just high/medium/low — "critical" shows up on
// reviewer + critic node output before being normalised. Accepting it
// here means we can render legacy rows without dropping them, and the
// SEVERITY_COLOR_MAP in pr-detail.tsx maps "critical" onto "high".
export type BugSeverityRaw = BugSeverity | "critical";

export interface Bug {
  severity: BugSeverityRaw;
  file: string;
  issue: string;
  // The agent always writes these for new rows (see prompt template) but
  // older rows from before 005_langgraph_outputs may have them missing —
  // hence optional. The dashboard surfaces them when present.
  line_hint?: string | null;
  impact?: string | null;
  suggestion?: string | null;
  reference?: string | null;
}

// `concerns` is declared as a string[] in the SQL schema but the agent
// JSON schema (review_graph.py) emits structured concern objects with
// the same field set as bugs. So old rows are plain strings, new rows
// are objects. The renderer accepts both. Same defensive widening for
// `questions` / `praise` since the prompt is free to upgrade them later
// without a migration.
export type Concern =
  | string
  | {
      file?: string;
      line_hint?: string | null;
      severity?: BugSeverityRaw;
      issue?: string;
      impact?: string | null;
      suggestion?: string | null;
      reference?: string | null;
    };

export interface RunError {
  repo?: string;
  pr?: string;
  error: string;
}

export interface Review {
  id: string;
  created_at: string;
  repo: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  pr_author: string | null;
  verdict: Verdict;
  confidence: Confidence;
  severity_score: number;
  summary: string;
  bug_count: number;
  bugs: Bug[] | null;
  concerns: Concern[] | null;
  questions: Concern[] | null;
  praise: Concern[] | null;
  action: Action;
  gate_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  digested_at: string | null;
  truncated: boolean;
}

export interface Run {
  id: string;
  started_at: string;
  finished_at: string | null;
  repos_scanned: string[] | null;
  reviews_created: number;
  skipped: number;
  errors: RunError[] | null;
  trigger_source: string | null;
}

export interface Digest {
  id: string;
  sent_at: string;
  review_ids: string[];
  review_count: number;
  closed_count: number;
  subject: string;
  trigger_source: string | null;
}

export interface DashboardStats {
  totalReviews: number;
  totalClosed: number;
  avgSeverity: number;
  estimatedCostUSD: number;
}

export type SeverityBucketLabel = "1-3" | "4-6" | "7-8" | "9-10";

export interface SeverityBucket {
  bucket: SeverityBucketLabel;
  count: number;
}

export interface ActivityPoint {
  date: string;
  count: number;
}

// --- Overview analytics: windowed metrics with period-over-period deltas -
// Backs the /dashboard/overview KPI cards. Each metric carries its current
// 30d value, the prior 30d value, and a pre-computed delta so the cards can
// render an up/down trend pill without re-deriving it in the view.

export interface MetricDelta {
  value: number;
  prev: number;
  // Percent change vs the previous window. null when prev is 0 (can't
  // divide) — the card renders "new" / no pill in that case.
  deltaPct: number | null;
  // Absolute change vs the previous window (value - prev).
  delta: number;
}

export interface OverviewMetrics {
  reviews: MetricDelta;
  closed: MetricDelta;
  avgSeverity: MetricDelta;
  cost: MetricDelta;
  // Accuracy carries the raw numerator/denominator for the "kept / total"
  // sub-label; total is the count of settled (non-pending) observations.
  accuracy: MetricDelta & { total: number; agreements: number };
}

// Per-repo daily review counts over a short window, used to draw the
// inline sparkline in the overview "By repo" table. `counts` is oldest
// → newest and always has `window` entries (zero-filled).
export interface RepoTrend {
  repo: string;
  counts: number[];
}

// Per-repo aggregate, shown on /repos and on the "By repo" overview section.
// `total_reviews`, `total_closed`, `avg_severity`, and `last_reviewed_at` are
// all-time. `estimated_cost_usd` is windowed to the last 30 days — Phase 4 of
// IMPROVEMENTS_v2.md explicitly labels it "(30d)".
//
// `rules_status` is derived from the repo_rules row (Phase 9): "none" when
// no row exists, "enabled" / "disabled" otherwise. Used by /repos to render
// the dashboard status dot without a second round-trip.
export type RepoRulesStatus = "none" | "enabled" | "disabled";

export interface RepoStat {
  repo: string;
  total_reviews: number;
  total_closed: number;
  avg_severity: number;
  estimated_cost_usd: number;
  last_reviewed_at: string | null;
  rules_status: RepoRulesStatus;
}

// --- v2 SaaS: auth profile + per-user watched repos ----------------------
// Matches agent/migrations/010_saas_auth.sql. Read by /dashboard/* pages
// only — the legacy /repos, /runs etc. demo routes never touch these.

export type UserPlan = "free" | "pro" | "enterprise";

export interface UserProfile {
  id: string;
  created_at: string;
  email: string | null;
  github_username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  plan: UserPlan;
  repo_limit: number;
}

// How a watched_repos row authenticates against GitHub. Migration 011
// adds the github_app variant alongside the original PAT path. The
// agent picks the credential by reading this column.
export type WatchedRepoTokenType = "pat" | "github_app";

export interface WatchedRepo {
  id: string;
  created_at: string;
  user_id: string;
  repo: string;
  // github_token is intentionally omitted from the type — the dashboard
  // never reads it back to the browser. Server-side code that needs it
  // queries Supabase directly with an explicit select('github_token').
  enabled: boolean;
  // Non-null only when token_type='github_app'. References
  // github_app_installations.installation_id (the GitHub-issued id,
  // not our internal uuid).
  github_installation_id: number | null;
  token_type: WatchedRepoTokenType;
}

// Mirrors agent/migrations/011_github_app.sql. One row per GitHub App
// install per user; many watched_repos rows can share an installation.
export type GitHubAccountType = "User" | "Organization";

export interface GitHubAppInstallation {
  id: string;
  created_at: string;
  user_id: string;
  // GitHub's numeric id, not our uuid. Used as a foreign key from
  // watched_repos.github_installation_id and as the path param when
  // minting installation access tokens.
  installation_id: number;
  account_login: string;
  account_type: GitHubAccountType;
  repos_selected: string[];
  suspended_at: string | null;
}

// --- Phase 9: per-repo rules ---------------------------------------------
// Matches agent/migrations/009_repo_rules.sql. Written by the dashboard's
// /repos/<owner>/<name>/settings page (anon write — see migration header),
// read by agent/pr_reviewer.py.get_repo_rules() before each review.
//
// Most fields are nullable / default-empty so a fresh row inserted with
// only `{ repo }` set still validates. The agent treats an absent row and
// a row with every field at its default as equivalent.
export interface RepoRule {
  id: string;
  created_at: string;
  updated_at: string;
  repo: string;
  enabled: boolean;
  auto_close_all: boolean;
  watch_paths: string[];
  skip_paths: string[];
  custom_instructions: string | null;
  rules_file_content: string | null;
  auto_close_severity_threshold: number | null;
  // Populated by the agent (upsert_repo_directory_tree). Displayed
  // read-only in the dashboard.
  repo_directory_tree: string | null;
  // --- Sandbox preview gate (migration 021, Phase 1) ---------------------
  // Optional because rows created before migration 021 won't have them;
  // the sandbox runners and settings UI fall back to the documented
  // defaults (block=true, require=false).
  //
  // When true, a failing authored test suite withholds the DevPod live
  // preview (Cloudflare URL). Default true.
  sandbox_block_on_test_failure?: boolean;
  // When true, the absence of any tests also withholds the preview
  // (strict repos). Default false.
  sandbox_require_tests_for_preview?: boolean;
  // --- Sandbox security gate (migration 022, Phase 3) --------------------
  // When true (default), a newly-added secret detected in the PR diff
  // withholds the live preview and marks the run as security_failed. The
  // other Phase 3 checks (lint / type-check / audit / SAST) stay advisory.
  sandbox_block_on_secrets?: boolean;
}

// --- Repo research cache (migration 013) ---------------------------------
// Backs the chat page's right-sidebar "Research" panel. One row per repo,
// articles is a JSON array. The fingerprint_hash discriminator is what
// drives the "is this cache stale?" check — when repo_fingerprints
// changes for this repo, the dashboard asks Claude for a fresh list.

export interface RepoResearchArticle {
  // Display title. Truncate at render-time, store full text.
  title: string;
  // Real URL — we prompt Claude not to invent, but we still validate
  // shape (URL parsable) before rendering as a link.
  url: string;
  // Short source name shown as a badge ("MDN", "dev.to", "GitHub").
  // Not a domain — Claude picks something readable.
  source: string;
  // One-line "why this matters" hook.
  description: string;
}

export interface RepoResearch {
  id: string;
  repo: string;
  // Plain-English "what this application is" blurb shown above the
  // suggested-research list. May be absent on rows generated before
  // migration 020.
  summary?: string | null;
  articles: RepoResearchArticle[];
  fingerprint_hash: string | null;
  updated_at: string;
}

// --- Phase 7: self-learning ----------------------------------------------
// Match agent/migrations/006_human_actions.sql + 007_agent_alerts.sql. The
// five-bucket action_type enum is the agent's ground-truth signal: every
// settled review eventually lands on one of the four terminal buckets, and
// the dashboard's accuracy stat is `agreements / non-pending`.

export type HumanActionType =
  | "agreement_close"
  | "false_close"
  | "agreement_approve"
  | "missed_issue"
  | "pending";

export interface HumanAction {
  id: string;
  review_id: string;
  observed_at: string;
  action_type: HumanActionType;
  pr_state: string;
  reopened: boolean;
  merged: boolean;
  reverted: boolean;
  poll_count: number;
  notes: string | null;
}

// Joined shape used by /learning's recent-misses table. The review fields
// give the table enough to link to the PR detail page without a second
// round-trip.
export interface HumanActionWithReview extends HumanAction {
  repo: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
}

export interface AccuracyStats {
  // All non-pending observations in the window. Used as the denominator
  // for the headline accuracy percentage.
  total_non_pending: number;
  agreements: number; // agreement_close + agreement_approve
  failures: number; // false_close + missed_issue
  pending: number;
  accuracy_pct: number; // 0..100, 0 when total_non_pending == 0
}

export interface AccuracyTimePoint {
  date: string; // YYYY-MM-DD
  accuracy_pct: number; // 0..100, daily share of agreements among non-pending
  total: number; // non-pending observations on that day (for tooltip context)
}

export interface AgentAlert {
  id: string;
  raised_at: string;
  alert_type: string;
  metric_value: number;
  threshold: number;
  resolved_at: string | null;
}

// --- Phase 8: prompt-tuner runs ------------------------------------------
// Match agent/migrations/008_prompt_tuner_runs.sql. One row per PR the
// prompt-tuner script (agent/prompt_tuner.py) opens against the agent
// repo. The /learning page renders rows with status='open' as "pending
// prompt improvements"; the script flips status to merged/closed once a
// human disposes of the PR.

export type PromptTunerStatus = "open" | "merged" | "closed" | "unknown";

// Denormalized failure-case shape persisted on the row. Mirrors the
// dict the prompt-tuner script bundles per case (minus the heavy `diff`
// field, which it strips before insert).
export interface PromptTunerFailureCase {
  human_action_id?: string;
  review_id: string;
  repo: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  action_type: HumanActionType;
  observed_at: string;
  agent_action?: string | null;
  agent_verdict?: string | null;
  agent_confidence?: string | null;
  agent_severity?: number | null;
  agent_summary?: string | null;
  agent_bugs?: unknown[] | null;
  human_notes?: string | null;
}

export interface PromptTunerRun {
  id: string;
  created_at: string;
  pr_url: string;
  pr_number: number;
  pr_title: string;
  branch_name: string;
  base_branch: string;
  agent_repo: string;
  failure_case_count: number;
  failure_cases: PromptTunerFailureCase[];
  proposed_diff: string;
  rationale: string | null;
  accuracy_before_pct: number | null;
  accuracy_after_pct_est: number | null;
  status: PromptTunerStatus;
  status_observed_at: string;
}

// --- Benchmark types ------------------------------------------------------
// Match agent/migrations/002_benchmark_runs.sql. Most "opus_*" fields are
// nullable because benchmark.py only fills them on a successful Opus call.

export interface BenchmarkRun {
  id: string;
  created_at: string;
  review_id: string;
  pr_url: string;
  pr_title: string;
  sonnet_verdict: Verdict;
  sonnet_confidence: Confidence;
  sonnet_severity: number;
  sonnet_bugs: Bug[] | null;
  sonnet_summary: string | null;
  sonnet_input_tokens: number | null;
  sonnet_output_tokens: number | null;
  opus_verdict: Verdict | null;
  opus_confidence: Confidence | null;
  opus_severity: number | null;
  opus_bugs: Bug[] | null;
  opus_summary: string | null;
  opus_input_tokens: number | null;
  opus_output_tokens: number | null;
  verdict_agreement: boolean | null;
  severity_delta: number | null;
  bug_overlap_count: number | null;
  bugs_only_in_sonnet: number | null;
  bugs_only_in_opus: number | null;
  sonnet_cost_micros: number | null;
  opus_cost_micros: number | null;
}

export interface BenchmarkStats {
  sample_size: number;
  agreement_pct: number; // 0..100, share of rows where verdicts matched
  mean_sev_delta: number; // mean of |sonnet_sev - opus_sev|
  mean_bug_overlap_pct: number; // 0..100, average per-row bug overlap
  cost_ratio: number; // sum(opus_cost) / sum(sonnet_cost), 0 if no Sonnet cost
}

// --- Migration 014: DevPod MCP connect layer -----------------------------
// Mirrors agent/migrations/014_devpod_sessions.sql. One row per running
// DevPod CLI agent; the dashboard chat sidebar polls /api/devpod/status
// against this table to render live/offline state.

export type DevpodSessionStatus = "active" | "inactive";

export interface DevpodCapabilities {
  run_command: boolean;
  run_tests: boolean;
  start_app: boolean;
  expose_port: boolean;
}

export interface DevpodSession {
  id: string;
  user_id: string | null;
  github_username: string;
  // The HTTPS Cloudflare tunnel URL the user's mcp_server.py is
  // reachable at. We do NOT expose this to anonymous status callers —
  // /api/devpod/status omits it for unauthenticated requests in case
  // we ever need to lock it back down. (Currently it does serve it
  // for the chat sidebar polling case; see route.ts for the rule.)
  tunnel_url: string;
  workspace_id: string | null;
  status: DevpodSessionStatus;
  connected_at: string;
  last_ping: string;
  expires_at: string;
  openclaw_session_id: string | null;
  capabilities: DevpodCapabilities;
}

export type DevpodExecutionType =
  | "run_command"
  | "run_tests"
  | "start_app"
  | "expose_port";

export interface DevpodExecution {
  id: string;
  session_id: string;
  command: string;
  type: DevpodExecutionType;
  output: string | null;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

// Shape returned by GET /api/devpod/status. `connected: false` is
// always returned on miss; fields below it are only populated on hit.
export interface DevpodStatusResponse {
  connected: boolean;
  tunnel_url?: string;
  workspace_id?: string | null;
  last_ping?: string;
  capabilities?: DevpodCapabilities;
  expires_at?: string;
}

// --- Migration 015: PR sandbox results -----------------------------------
// One row per (repo, pr_number) — the test outcome of the most recent
// sandbox run. Written by either agent/devpod_tester.py (webhook-driven)
// or /api/devpod/run-pr-tests (chat-button-driven), upsert-keyed on
// (repo, pr_number) so the latest run wins.

// DB-persisted overall — bounded by the CHECK constraint on
// pr_sandbox_results.overall (migration 015). Rich live verdicts
// emitted by /api/devpod/run-pr-tests are mapped down to this set
// via verdictToDbOverall() before the row is upserted.
export type SandboxOverall = "pass" | "fail" | "no_tests" | "error";

// Live verdict used in SSE events, the in-card final result, and
// the GitHub PR comment posted by agent/devpod_tester.py. Richer
// than the persisted column because we want the UI to distinguish
// "build failed" from "tests failed" from "preview unavailable",
// even though the DB collapses those down to {fail, pass, error}.
export type SandboxVerdict =
  | "pass"
  | "pass_no_preview"
  | "tests_failed"
  | "build_failed"
  // Phase 3: a blocking security check failed (a newly-added secret in
  // the diff). Distinct from tests/build so the UI + PR comment can say
  // "secret detected" rather than a generic failure. Maps to db "fail".
  | "security_failed"
  | "no_tests"
  | "error";

export function verdictToDbOverall(v: SandboxVerdict): SandboxOverall {
  switch (v) {
    case "pass":
    case "pass_no_preview":
      return "pass";
    case "tests_failed":
    case "build_failed":
    case "security_failed":
      return "fail";
    case "no_tests":
      return "no_tests";
    case "error":
    default:
      return "error";
  }
}

// --- Phase 3: quality checks (lint / type-check / security / coverage) ----
// Persisted in pr_sandbox_results.checks (migration 022) and streamed on
// the SSE `complete` event. Every check is best-effort: "skip" means the
// tool wasn't available or the check didn't apply to the detected stack,
// NOT that it failed. Only the secret scan is blocking; the rest are
// advisory and never withhold the preview on their own.
export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  status: CheckStatus;
  tool: string;
  summary: string;
}

export interface SecretScanResult {
  status: CheckStatus;
  tool: string;
  count: number;
  findings: string[];
}

// Phase 4: Claude-generated unit tests. Advisory by default and EC2-only
// (the DevPod has no Anthropic key, the Vercel route no budget) — so the
// chat path reports status "skip" / "runs on EC2". `bug_candidate` is true
// when a generated test FAILED, which is the high-signal seed for the
// auto-fix builder (a generated test that reproduces a real bug).
// Phase 4b: result of the auto-fix builder when a generated test
// reproduces a likely bug. EC2-only; "opened" means a fix PR was created
// against the contributor's branch.
export interface AutoFixResult {
  status: "opened" | "skip" | "error";
  summary: string;
  pr_url?: string;
  pr_number?: number;
  confidence?: string;
  emailed?: boolean;
}

export interface GeneratedTestsResult {
  status: CheckStatus;
  framework: string;
  written: number;
  passed: number;
  failed: number;
  summary: string;
  bug_candidate?: boolean;
  autofix?: AutoFixResult;
}

export interface SandboxChecks {
  diff?: { changed_files: number; base: string | null };
  lint?: CheckResult;
  typecheck?: CheckResult;
  security?: {
    secrets?: SecretScanResult;
    audit?: CheckResult;
    sast?: CheckResult;
  };
  coverage?: { status: "ok" | "skip"; pct: number | null; tool: string };
  generated?: GeneratedTestsResult;
}

export interface SandboxResult {
  id: string;
  repo: string;
  pr_number: number;
  user_id: string | null;
  session_id: string | null;
  tests_passed: number;
  tests_failed: number;
  test_output: string | null;
  app_url: string | null;
  app_started: boolean;
  clone_success: boolean;
  install_success: boolean;
  overall: SandboxOverall | null;
  created_at: string;
  duration_ms: number | null;
  // --- Phase 3 (migration 022) ------------------------------------------
  // Structured quality-check results + the explicit gate decision. All
  // optional: rows written before migration 022 won't have them.
  checks?: SandboxChecks | null;
  gate_passed?: boolean | null;
  gate_reason?: string | null;
}

// SSE event shape emitted by /api/devpod/run-pr-tests. Each step
// emits at least a "running" event before the corresponding "done"
// event so the UI can flip a per-step spinner on / off.
//
// Step ordering: clone → install → tests → build → app → complete.
// The "build" step was added so the dashboard can distinguish a
// PR whose tests pass but whose `npm run build` fails (very common
// failure mode on Next.js PRs touching TS / config / generated
// types). The "expose" event was folded into "app": expose_port
// runs as the tail of the app step and the resulting URL is
// surfaced in app's "done" event.
// Phase 3 inserts lint / typecheck / security between install and tests.
// The chat card streams each as its own row; "security" aggregates the
// secret scan + dependency audit + SAST into one step.
export type SandboxStep =
  | "clone"
  | "install"
  | "lint"
  | "typecheck"
  | "security"
  | "tests"
  | "build"
  | "app"
  | "complete";

// --- Migration 018: PR analysis reports ----------------------------------
// Synthesis layer on top of `reviews` + `pr_sandbox_results`. One row per
// (repo, pr_number). Produced by agent/report_generator.py ~45s after a
// webhook fires, persisted via SUPABASE_SERVICE_KEY (CLAUDE.md rule 5),
// read by the dashboard's /dashboard/reports page and the chat sandbox
// card's "View Report" button.
//
// Field shapes intentionally mirror the SQL column names rather than
// adopting camelCase — matches the pattern set by `Review` / `Run` /
// `SandboxResult`, so client code can pass rows straight from PostgREST
// to the renderer without a remap.

export type ReportVisionAlignment =
  | "aligned"
  | "neutral"
  | "misaligned"
  | "unknown";

export type ReportMergeRecommendation =
  | "merge"
  | "request_changes"
  | "reject"
  | "needs_review";

export type ReportMergeConfidence = "high" | "medium" | "low";

export interface PrReport {
  id: string;
  repo: string;
  pr_number: number;
  pr_title: string | null;
  pr_author: string | null;
  user_id: string | null;
  created_at: string;

  // Synthesis fields produced by Claude.
  what_it_adds: string | null;
  use_case: string | null;
  vision_alignment: ReportVisionAlignment | null;
  vision_reasoning: string | null;

  // Denormalized from `reviews`. review_bugs is the same `Bug[]`
  // shape the reviewer emits — we keep it weakly typed here because
  // the generator stores whatever was in `reviews.bugs` verbatim
  // (which may include legacy/unknown fields).
  review_verdict: string | null;
  review_severity: number | null;
  review_bugs: Bug[] | null;
  review_summary: string | null;

  // Denormalized from `pr_sandbox_results`. sandbox_overall mirrors
  // the SandboxOverall enum but is intentionally typed as string |
  // null here because the generator may store 'not_run' when no
  // sandbox row materialized — a value the migration-015 CHECK
  // forbids on pr_sandbox_results but tolerates on pr_reports.
  sandbox_overall: string | null;
  sandbox_tests_passed: number | null;
  sandbox_tests_failed: number | null;
  sandbox_build_success: boolean | null;
  sandbox_app_url: string | null;

  merge_recommendation: ReportMergeRecommendation | null;
  merge_confidence: ReportMergeConfidence | null;
  merge_reasoning: string | null;

  report_markdown: string | null;
}

export interface SandboxProgressEvent {
  step: SandboxStep;
  status: "running" | "done" | "error";
  // Filled in on the matching "done" event for the relevant step.
  success?: boolean;
  passed?: number;
  failed?: number;
  url?: string | null;
  // The complete event carries the rich verdict; intermediate
  // events do not.
  overall?: SandboxVerdict;
  duration_ms?: number;
  error?: string;
  // build-step "done" carries `success` for green/red and a short
  // stderr-style excerpt that the card renders in a collapsible
  // <pre>.
  build_output?: string;
  // --- Sandbox preview gate (Phase 1) -----------------------------------
  // Carried on the terminal `complete` event. When gate_passed is false
  // the sandbox intentionally withheld the live preview (e.g. tests
  // failed); gate_reason is a short human-readable explanation. Absent
  // on per-step events.
  gate_passed?: boolean;
  gate_reason?: string;
  // --- Phase 3 quality checks -------------------------------------------
  // Per-step events (lint / typecheck / security) carry a short `detail`
  // string for the inline summary. The terminal `complete` event carries
  // the full structured `checks` blob the card renders + persists.
  detail?: string;
  checks?: SandboxChecks;
}
