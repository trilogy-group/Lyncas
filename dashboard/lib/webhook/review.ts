import Anthropic from "@anthropic-ai/sdk";

import {
  AUTO_CLOSE_MIN_SEVERITY,
  AUTO_CLOSE_REQUIRED_CONFIDENCE,
  AUTO_CLOSE_REQUIRED_VERDICT,
  MAX_DIFF_CHARS,
  MAX_TOKENS,
  MODEL,
} from "./config";
import { getOrRefreshFingerprint } from "./fingerprint";
import {
  alreadyReviewed,
  closePR,
  fetchPRDiff,
  postComment,
} from "./github";
import { formatCloseComment, formatReviewComment } from "./format";
import { REVIEW_SYSTEM_PROMPT } from "./prompts";
import { getServiceSupabase } from "./supabase";
import type { ClaudeReview, FingerprintStatus } from "./types";

export interface WebhookPullRequest {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  user: { login: string };
  base: { ref: string };
  changed_files?: number;
  additions?: number;
  deletions?: number;
  draft?: boolean;
}

function stripOuterFence(text: string): string {
  // Mirrors the Phase-3 fix in agent/pr_reviewer.py: only drop the outermost
  // ``` fence so inner code blocks embedded in `suggestion` strings stay
  // intact and the JSON parses cleanly.
  let t = text.trim();
  if (!t.startsWith("```")) return t;
  const firstNl = t.indexOf("\n");
  t = firstNl !== -1 ? t.slice(firstNl + 1) : t.slice(3);
  t = t.trimEnd();
  if (t.endsWith("```")) t = t.slice(0, -3).trimEnd();
  return t;
}

function buildUserMessage(
  pr: WebhookPullRequest,
  diff: string,
  contextBlock: string,
): string {
  return `${contextBlock}PR DIFF:
PR title: ${pr.title}
PR description: ${pr.body || "(none)"}
Author: ${pr.user.login}
Base branch: ${pr.base.ref}
Files changed: ${pr.changed_files ?? "unknown"}
Additions: +${pr.additions ?? "?"} / Deletions: -${pr.deletions ?? "?"}

Unified diff:
\`\`\`diff
${diff}
\`\`\`

Respond ONLY with valid JSON matching this schema (no markdown fences, no prose before or after):
{
  "summary": "1-2 sentence summary of what the PR does AND overall quality",
  "verdict": "approve" | "request_changes" | "comment",
  "confidence": "high" | "medium" | "low",
  "severity_score": 1-10 integer (see prompt rubric — 9+ triggers auto-close, be conservative),
  "bugs": [
    {
      "file": "exact path from the diff, or \\"multiple files\\"",
      "line_hint": "42" | "42-58" | null,
      "severity": "critical" | "high" | "medium" | "low",
      "issue": "one sentence: what is wrong",
      "impact": "one sentence: what could go wrong if unfixed",
      "suggestion": "concrete fix (prose, or a fenced code snippet of <=10 lines)",
      "reference": "URL to a doc/RFC/CVE/spec if you can cite one accurately, else null"
    }
  ],
  "concerns": [
    {
      "file": "path or \\"multiple files\\"",
      "line_hint": "42" | "42-58" | null,
      "severity": "low" | "medium",
      "issue": "non-bug concern: style, naming, testing gap, etc.",
      "impact": "why this concern matters in one sentence",
      "suggestion": "concrete improvement",
      "reference": null
    }
  ],
  "questions": ["questions you'd ask the author if you were unsure"],
  "praise": ["specific things done well — leave empty if nothing stands out"]
}

The prompt.md \`Output format\` section spells out every field's exact content requirements — follow them. If a field doesn't apply (e.g. no good doc to reference), use \`null\`, not a made-up value.`;
}

interface CallClaudeResult {
  review: ClaudeReview;
  truncated: boolean;
  inputTokens: number;
  outputTokens: number;
}

async function callClaudeForReview(
  pr: WebhookPullRequest,
  diff: string,
  fingerprint: string | null,
): Promise<CallClaudeResult> {
  let truncated = false;
  let truncatedDiff = diff;
  if (truncatedDiff.length > MAX_DIFF_CHARS) {
    truncatedDiff = truncatedDiff.slice(0, MAX_DIFF_CHARS) + "\n\n[... diff truncated ...]";
    truncated = true;
  }

  const contextBlock = fingerprint
    ? `REPOSITORY CONTEXT:\n${fingerprint}\n\n---\n\n`
    : "";
  const userMsg = buildUserMessage(pr, truncatedDiff, contextBlock);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set");
  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: REVIEW_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text block");
  }
  const text = stripOuterFence(block.text);
  let review: ClaudeReview;
  try {
    review = JSON.parse(text) as ClaudeReview;
  } catch (e) {
    throw new Error(
      `Failed to parse Claude JSON: ${(e as Error).message} — first 200 chars: ${text.slice(0, 200)}`,
    );
  }

  return {
    review,
    truncated,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

function shouldAutoClose(review: ClaudeReview): { close: boolean; reason: string } {
  const allow = (process.env.ALLOW_AUTO_CLOSE || "false").toLowerCase() === "true";
  if (!allow) return { close: false, reason: "ALLOW_AUTO_CLOSE is false (default)" };

  const failed: string[] = [];
  if (review.verdict !== AUTO_CLOSE_REQUIRED_VERDICT) {
    failed.push(`verdict=${review.verdict} (need ${AUTO_CLOSE_REQUIRED_VERDICT})`);
  }
  if (review.confidence !== AUTO_CLOSE_REQUIRED_CONFIDENCE) {
    failed.push(
      `confidence=${review.confidence} (need ${AUTO_CLOSE_REQUIRED_CONFIDENCE})`,
    );
  }
  const score = review.severity_score;
  if (typeof score !== "number" || !Number.isInteger(score) || score < AUTO_CLOSE_MIN_SEVERITY) {
    failed.push(`severity=${score} (need >= ${AUTO_CLOSE_MIN_SEVERITY})`);
  }
  if (failed.length) return { close: false, reason: failed.join("; ") };
  return { close: true, reason: "" };
}

async function upsertReview(
  repo: string,
  pr: WebhookPullRequest,
  review: ClaudeReview,
  meta: {
    action: "commented" | "closed";
    gateReason: string;
    inputTokens: number;
    outputTokens: number;
    truncated: boolean;
    fingerprintStatus: FingerprintStatus;
    model: string;
  },
): Promise<void> {
  try {
    const sb = getServiceSupabase();
    await sb
      .from("reviews")
      .upsert(
        {
          repo,
          pr_number: pr.number,
          pr_url: pr.html_url,
          pr_title: pr.title,
          pr_author: pr.user?.login ?? null,
          verdict: review.verdict,
          confidence: review.confidence,
          severity_score: review.severity_score,
          summary: review.summary,
          bug_count: (review.bugs ?? []).length,
          bugs: review.bugs,
          concerns: review.concerns,
          questions: review.questions,
          praise: review.praise,
          action: meta.action,
          gate_reason: meta.gateReason || null,
          input_tokens: meta.inputTokens,
          output_tokens: meta.outputTokens,
          truncated: meta.truncated,
          repo_context_used:
            meta.fingerprintStatus === "cached" || meta.fingerprintStatus === "fresh",
          model: meta.model,
        },
        { onConflict: "repo,pr_number" },
      );
  } catch (e) {
    // GitHub side is already done — log and proceed. The cron's daily run
    // will eventually re-upsert if the comment marker is somehow lost.
    console.warn(
      `[webhook:${repo}#${pr.number}] supabase upsert failed: ${(e as Error).message}`,
    );
  }
}

export interface ReviewResult {
  status:
    | "reviewed"
    | "closed"
    | "skipped_already_reviewed"
    | "skipped_draft"
    | "ignored_action";
  detail?: string;
}

export async function reviewPullRequest(
  repo: string,
  pr: WebhookPullRequest,
): Promise<ReviewResult> {
  if (pr.draft) return { status: "skipped_draft" };

  if (await alreadyReviewed(repo, pr.number)) {
    console.log(`[webhook:${repo}#${pr.number}] already reviewed, skipping`);
    return { status: "skipped_already_reviewed" };
  }

  console.log(`[webhook:${repo}#${pr.number}] fetching diff...`);
  const diff = await fetchPRDiff(repo, pr.number);

  const { fingerprint, status: fingerprintStatus } = await getOrRefreshFingerprint(repo);

  console.log(`[webhook:${repo}#${pr.number}] asking Claude for review...`);
  const { review, truncated, inputTokens, outputTokens } = await callClaudeForReview(
    pr,
    diff,
    fingerprint,
  );

  const decision = shouldAutoClose(review);
  let action: "commented" | "closed" = "commented";

  if (decision.close) {
    console.log(
      `[webhook:${repo}#${pr.number}] 🚫 ALL GATES PASSED → auto-closing (severity=${review.severity_score}, verdict=${review.verdict}, confidence=${review.confidence})`,
    );
    const closeComment = formatCloseComment(review);
    await postComment(repo, pr.number, closeComment);
    await closePR(repo, pr.number);
    action = "closed";
  } else {
    const comment = formatReviewComment(review, {
      model: MODEL,
      inputTokens,
      outputTokens,
      truncated,
      fingerprintStatus,
    });
    await postComment(repo, pr.number, comment);
    console.log(
      `[webhook:${repo}#${pr.number}] ✅ posted (${review.verdict}, ${review.confidence} confidence, severity ${review.severity_score ?? "?"}) — close gates not met: ${decision.reason}`,
    );
  }

  await upsertReview(repo, pr, review, {
    action,
    gateReason: decision.reason,
    inputTokens,
    outputTokens,
    truncated,
    fingerprintStatus,
    model: MODEL,
  });

  return action === "closed"
    ? { status: "closed", detail: `severity=${review.severity_score}` }
    : { status: "reviewed", detail: `${review.verdict}, ${review.confidence}` };
}
