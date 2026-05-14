import {
  AUTO_CLOSE_MIN_SEVERITY,
  CLOSE_MARKER,
  FINGERPRINT_STATUS_LABEL,
  MODEL,
  MODEL_PRICING_USD_PER_M_TOKENS,
  REVIEW_MARKER,
  SEVERITY_EMOJI,
  SEVERITY_ORDER,
  VERDICT_EMOJI,
  VERDICT_LABEL,
} from "./config";
import type { BugLike, ClaudeReview, FingerprintStatus } from "./types";

// Port of agent/pr_reviewer.py's Phase-3 rich-comment renderer. The output
// markdown is intentionally identical (modulo minor whitespace) so a PR
// reviewed by the webhook and a PR reviewed by the cron look the same to
// the author. If you change one, change the other.

export function computeCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = MODEL_PRICING_USD_PER_M_TOKENS[model];
  if (!rates) return 0;
  return ((inputTokens || 0) * rates.input + (outputTokens || 0) * rates.output) / 1_000_000;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

function bugLocation(bug: BugLike): string {
  const file = bug.file || "?";
  const line = bug.line_hint;
  if (line === null || line === undefined || line === "" || line === "null") {
    return `\`${file}\``;
  }
  return `\`${file}:${line}\``;
}

function renderBugSection(bugs: BugLike[]): string[] {
  if (!bugs.length) return [];

  const bySev: Record<string, BugLike[]> = {};
  for (const s of SEVERITY_ORDER) bySev[s] = [];
  const extras: BugLike[] = [];
  for (const b of bugs) {
    const sev = (b.severity || "").toString().toLowerCase();
    if (sev in bySev) bySev[sev].push(b);
    else extras.push(b);
  }

  const lines: string[] = [`### 🐛 Bugs (${bugs.length})`, ""];
  let renderedAny = false;
  for (const sev of SEVERITY_ORDER) {
    for (const b of bySev[sev]) {
      renderedAny = true;
      const emoji = SEVERITY_EMOJI[sev] ?? "•";
      const issue = (b.issue || "").trim();
      lines.push(`#### ${emoji} ${issue} — ${bugLocation(b)}`);
      lines.push("");
      const impact = (b.impact || "").trim();
      if (impact) {
        lines.push(`**Impact:** ${impact}`);
        lines.push("");
      }
      const suggestion = (b.suggestion || "").trim();
      if (suggestion) {
        lines.push("**Suggested fix:**");
        lines.push("");
        lines.push(suggestion);
        lines.push("");
      }
      const reference = (b.reference || "").trim();
      if (reference && reference.toLowerCase() !== "null") {
        lines.push(`_Reference:_ ${reference}`);
        lines.push("");
      }
      lines.push("---");
      lines.push("");
    }
  }
  for (const b of extras) {
    renderedAny = true;
    const issue = (b.issue || "").trim();
    lines.push(`#### • ${issue} — ${bugLocation(b)}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  if (!renderedAny) return [];
  return lines;
}

function renderConcernsSection(concerns: unknown[]): string[] {
  if (!concerns?.length) return [];
  const lines: string[] = [`### ⚠️ Concerns (${concerns.length})`, ""];
  for (const c of concerns) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cc = c as BugLike;
      const issue = (cc.issue || "").trim();
      const location = cc.file ? bugLocation(cc) : "";
      const sev = (cc.severity || "").toString().toLowerCase();
      const sevTag = sev in SEVERITY_EMOJI ? ` _[${sev}]_` : "";
      let head = `- ${issue}`;
      if (location) head += ` — ${location}`;
      if (sevTag) head += sevTag;
      lines.push(head);
      const impact = (cc.impact || "").trim();
      if (impact) lines.push(`  - **Impact:** ${impact}`);
      const suggestion = (cc.suggestion || "").trim();
      if (suggestion) lines.push(`  - **Suggestion:** ${suggestion}`);
    } else {
      lines.push(`- ${String(c)}`);
    }
  }
  lines.push("");
  return lines;
}

function renderSimpleListSection(heading: string, items: unknown[]): string[] {
  if (!items?.length) return [];
  const lines: string[] = [`${heading} (${items.length})`, ""];
  for (const x of items) lines.push(`- ${String(x)}`);
  lines.push("");
  return lines;
}

export interface ReviewFooterMeta {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  truncated?: boolean;
  fingerprintStatus?: FingerprintStatus | string;
}

export function formatReviewComment(
  review: ClaudeReview,
  meta: ReviewFooterMeta = {},
): string {
  const verdict = review.verdict || "";
  const confidence = review.confidence || "";
  const severityScore = review.severity_score ?? "?";
  const verdictEmoji = VERDICT_EMOJI[verdict] ?? "🤖";
  const verdictLabel =
    VERDICT_LABEL[verdict] ?? (verdict ? verdict.toString().toUpperCase() : "REVIEW");

  const bugs = review.bugs ?? [];
  const concerns = review.concerns ?? [];
  const questions = review.questions ?? [];
  const praise = review.praise ?? [];

  const lines: string[] = [
    REVIEW_MARKER,
    "## 🌙 Night PR Reviewer",
    "",
    `**Verdict:** ${verdictEmoji} ${verdictLabel}  `,
    `**Severity:** ${severityScore}/10 · **Confidence:** ${confidence}`,
    "",
    `> ${(review.summary || "").trim()}`,
    "",
    "---",
    "",
  ];

  const bugLines = renderBugSection(bugs);
  if (bugLines.length) {
    lines.push(...bugLines);
  } else {
    lines.push("### 🐛 Bugs (0)");
    lines.push("");
    lines.push("_No bugs flagged._");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push(...renderConcernsSection(concerns));
  lines.push(...renderSimpleListSection("### ❓ Questions", questions));
  lines.push(...renderSimpleListSection("### ✅ Praise", praise));

  if (meta.truncated) {
    lines.push(
      "> ⚠️ Diff was truncated due to size. Review is based on the first portion only.",
    );
    lines.push("");
  }

  const model = meta.model || MODEL;
  const inTok = meta.inputTokens ?? 0;
  const outTok = meta.outputTokens ?? 0;
  const cost = computeCostUSD(model, inTok, outTok);
  const fpStatus = meta.fingerprintStatus || "unavailable";
  const fpLabel = FINGERPRINT_STATUS_LABEL[fpStatus] ?? String(fpStatus);

  lines.push("---");
  lines.push(
    `*Reviewed by \`${model}\` · ${inTok} in / ${outTok} out · ${formatCost(cost)}*`,
  );
  lines.push(`*Repo context: ${fpLabel}*`);
  return lines.join("\n");
}

export function formatCloseComment(review: ClaudeReview): string {
  const bugLines: string[] = [];
  for (const b of review.bugs ?? []) {
    const sev = ((b.severity || "?") as string).toUpperCase();
    bugLines.push(`- **[${sev}]** \`${b.file || "?"}\` — ${b.issue || ""}`);
  }

  const lines: string[] = [
    CLOSE_MARKER,
    "## 🚫 PR auto-closed by night-pr-reviewer",
    "",
    "This PR was automatically closed because all three gates were met:",
    "- Verdict: `request_changes`",
    "- Confidence: `high`",
    `- Severity score: **${review.severity_score ?? "?"}/10** (threshold: ${AUTO_CLOSE_MIN_SEVERITY})`,
    "",
    "### Why",
    review.summary || "",
    "",
  ];

  if (bugLines.length) {
    lines.push("### Issues flagged");
    lines.push(...bugLines);
    lines.push("");
  }

  lines.push(
    "### Disagree?",
    "**If you believe this close is wrong, reopen the PR with the `Reopen pull request` button at the bottom.** The agent will not close it again (it leaves a marker). The repo owner will review the dispute in the morning digest.",
    "",
    "### Recommended path forward",
    "1. Address the issues listed above in a new commit on the same branch",
    "2. Open a fresh PR",
    "",
    "---",
    "*This action was automated. LLMs can be wrong. The repo owner audits every auto-close in the daily digest.*",
  );
  return lines.join("\n");
}
