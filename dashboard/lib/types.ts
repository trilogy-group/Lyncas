// Types match the SQL schema in agent/migrations/001_initial_schema.sql.
// Keep these in sync if the schema ever changes.

export type Verdict = "approve" | "request_changes" | "comment";
export type Confidence = "high" | "medium" | "low";
export type Action = "commented" | "closed";
export type BugSeverity = "high" | "medium" | "low";

export interface Bug {
  severity: BugSeverity;
  file: string;
  issue: string;
  suggestion?: string;
}

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
  concerns: string[] | null;
  questions: string[] | null;
  praise: string[] | null;
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
