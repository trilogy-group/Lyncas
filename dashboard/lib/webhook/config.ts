// Configuration mirrored from agent/pr_reviewer.py.
// Phase 5 ports the review logic to a Vercel Function so PRs get reviewed
// within seconds of being opened instead of within the next 10-min cron tick.
//
// If you change a constant here, change it in agent/pr_reviewer.py too.

export const MODEL = "claude-opus-4-5";

export const MAX_DIFF_CHARS = 60_000;
export const MAX_TOKENS = 4096;

export const REVIEW_MARKER = "<!-- night-pr-reviewer:v1 -->";
export const CLOSE_MARKER = "<!-- night-pr-reviewer:closed:v1 -->";

// Auto-close behaviour mirrors agent/pr_reviewer.py:
//  • disabled by default, opt in with ALLOW_AUTO_CLOSE=true on the function
//  • all three gates must be true to close.
export const AUTO_CLOSE_MIN_SEVERITY = 9;
export const AUTO_CLOSE_REQUIRED_VERDICT = "request_changes";
export const AUTO_CLOSE_REQUIRED_CONFIDENCE = "high";

// Fingerprint cache TTL — refresh if older than this or if the HEAD SHA moved.
export const FINGERPRINT_TTL_DAYS = 7;
export const FINGERPRINT_README_MAX_CHARS = 3000;
export const FINGERPRINT_DEP_FILE_MAX_CHARS = 4000;
export const FINGERPRINT_DIR_DEPTH = 2;
export const FINGERPRINT_DIR_MAX_ENTRIES = 200;
export const FINGERPRINT_MAX_OUTPUT_TOKENS = 1200;

export const FINGERPRINT_DEP_FILES = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
];

export const FINGERPRINT_SKIP_DIRS = new Set<string>([
  ".git",
  "node_modules",
  "venv",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  "target",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".idea",
  ".vscode",
]);

// USD per 1M tokens. Mirrors agent/pr_reviewer.py — keep in sync.
export const MODEL_PRICING_USD_PER_M_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
};

export const FALLBACK_PRICING_MODEL = "claude-opus-4-5";

export const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔥",
  high: "🔴",
  medium: "🟠",
  low: "🟡",
};

export const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

// Verdict emoji + label split, matching the Phase-3 rich-comment renderer
// in agent/pr_reviewer.py (VERDICT_EMOJI + VERDICT_LABEL).
export const VERDICT_EMOJI: Record<string, string> = {
  approve: "✅",
  request_changes: "🔴",
  comment: "💬",
};

export const VERDICT_LABEL: Record<string, string> = {
  approve: "APPROVE",
  request_changes: "REQUEST CHANGES",
  comment: "COMMENT",
};

export const FINGERPRINT_STATUS_LABEL: Record<string, string> = {
  cached: "cached",
  fresh: "fresh",
  unavailable: "unavailable",
};
