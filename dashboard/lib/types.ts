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
