// Local TypeScript shapes for the webhook review path.
// These intentionally mirror the JSON schema produced by Claude under
// agent/prompt.md so the format helpers can be shared cleanly.

export type Severity = "critical" | "high" | "medium" | "low";
export type Verdict = "approve" | "request_changes" | "comment";
export type Confidence = "high" | "medium" | "low";

export interface BugLike {
  file?: string | null;
  line_hint?: string | number | null;
  severity?: Severity | string | null;
  issue?: string | null;
  impact?: string | null;
  suggestion?: string | null;
  reference?: string | null;
}

export interface ClaudeReview {
  summary: string;
  bugs: BugLike[];
  concerns: BugLike[];
  questions: string[];
  praise: string[];
  verdict: Verdict | string;
  confidence: Confidence | string;
  severity_score: number;
}

// Mirrors the contract documented on get_or_refresh_fingerprint in
// agent/pr_reviewer.py — the webhook reuses the same vocabulary so the
// dashboard's "By repo" badge logic keeps working.
export type FingerprintStatus = "cached" | "fresh" | "unavailable";

export interface FingerprintResult {
  fingerprint: string | null;
  status: FingerprintStatus;
}

export interface ReviewUsage {
  input_tokens: number;
  output_tokens: number;
}
