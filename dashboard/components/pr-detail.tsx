import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import {
  formatCost,
  formatRelativeTime,
  palette,
  severityColor,
  severityColors,
  tokenCostUSD,
  verdictBadge,
} from "@/lib/design";
import type { Bug, HumanAction, HumanActionType, Review } from "@/lib/types";

const SEVERITY_COLOR_MAP: Record<Bug["severity"], string> = {
  high: severityColors.critical,
  medium: severityColors.serious,
  low: severityColors.moderate,
};

const HUMAN_ACTION_LABEL: Record<HumanActionType, string> = {
  agreement_close: "Agreement (close)",
  false_close: "False close",
  agreement_approve: "Agreement (approve)",
  missed_issue: "Missed issue",
  pending: "Pending",
};
const HUMAN_ACTION_COLOR: Record<HumanActionType, string> = {
  agreement_close: severityColors.clean,
  agreement_approve: severityColors.clean,
  false_close: severityColors.critical,
  missed_issue: severityColors.critical,
  pending: palette.muted,
};

function groupBugs(bugs: Bug[]): {
  high: Bug[];
  medium: Bug[];
  low: Bug[];
} {
  return {
    high: bugs.filter((b) => b.severity === "high"),
    medium: bugs.filter((b) => b.severity === "medium"),
    low: bugs.filter((b) => b.severity === "low"),
  };
}

export function PrDetail({
  review,
  humanAction,
}: {
  review: Review;
  humanAction?: HumanAction | null;
}) {
  const v = verdictBadge(review.verdict);
  const sevColor = severityColor(review.severity_score);
  const cost = tokenCostUSD(review.input_tokens, review.output_tokens);
  const grouped = groupBugs(review.bugs ?? []);
  const totalBugs =
    grouped.high.length + grouped.medium.length + grouped.low.length;

  return (
    <div className="space-y-6 animate-fade-up">
      <div>
        <div className="mb-2 font-mono text-xs text-muted">
          <a
            href={review.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text hover:underline underline-offset-4"
          >
            {review.repo}#{review.pr_number} ↗
          </a>
          {review.pr_author && (
            <>
              {" · by "}
              <span className="text-text">{review.pr_author}</span>
            </>
          )}
        </div>
        <h1 className="text-2xl font-semibold leading-tight">
          {review.pr_title}
        </h1>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge color={v.color}>{v.label}</Badge>
        <Badge color={sevColor}>severity {review.severity_score}/10</Badge>
        <Badge color={palette.muted} variant="outline">
          {review.confidence} confidence
        </Badge>
        {review.action === "closed" && (
          <Badge color={severityColors.critical}>auto-closed</Badge>
        )}
        {review.truncated && (
          <Badge color={palette.muted} variant="outline">
            diff truncated
          </Badge>
        )}
      </div>

      <Card className="p-5">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Summary
        </div>
        <p className="mt-2 text-base leading-relaxed">{review.summary}</p>
      </Card>

      {humanAction && (
        <Card className="p-5">
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Human verdict
          </div>
          <div className="mt-3 mb-3 flex flex-wrap items-center gap-2">
            <Badge color={HUMAN_ACTION_COLOR[humanAction.action_type]}>
              {HUMAN_ACTION_LABEL[humanAction.action_type]}
            </Badge>
            <span className="font-mono text-xs text-muted">
              observed {formatRelativeTime(humanAction.observed_at)}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-4">
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-[0.18em] text-muted">
                PR state
              </div>
              <div className="text-text">{humanAction.pr_state}</div>
            </div>
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-[0.18em] text-muted">
                Reopened
              </div>
              <div className="text-text">
                {humanAction.reopened ? "yes" : "no"}
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-[0.18em] text-muted">
                Merged
              </div>
              <div className="text-text">
                {humanAction.merged ? "yes" : "no"}
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-[0.18em] text-muted">
                Reverted
              </div>
              <div className="text-text">
                {humanAction.reverted ? "yes" : "no"}
              </div>
            </div>
          </div>
          {humanAction.notes && (
            <p className="mt-3 text-sm leading-relaxed text-muted">
              <span className="font-semibold text-text">Notes: </span>
              {humanAction.notes}
            </p>
          )}
        </Card>
      )}

      {totalBugs > 0 && (
        <section>
          <div className="mb-3 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Bugs ({review.bug_count})
          </div>
          <div className="space-y-3">
            {(["high", "medium", "low"] as const).flatMap((sev) =>
              grouped[sev].map((b, i) => (
                <Card
                  key={`${sev}-${i}`}
                  className="p-4 border-l-2"
                  style={{ borderLeftColor: SEVERITY_COLOR_MAP[sev] }}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge color={SEVERITY_COLOR_MAP[sev]}>
                      {sev.toUpperCase()}
                    </Badge>
                    <code className="font-mono text-xs text-muted">
                      {b.file}
                    </code>
                  </div>
                  <p className="text-sm leading-relaxed">{b.issue}</p>
                  {b.suggestion && (
                    <p className="mt-2 text-sm leading-relaxed text-muted">
                      <span className="font-semibold text-text">
                        Suggestion:{" "}
                      </span>
                      {b.suggestion}
                    </p>
                  )}
                </Card>
              )),
            )}
          </div>
        </section>
      )}

      {review.concerns && review.concerns.length > 0 && (
        <details className="rounded-md border border-border bg-card p-4">
          <summary className="cursor-pointer text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Concerns ({review.concerns.length})
          </summary>
          <ul className="mt-3 list-disc space-y-2 pl-6 text-sm">
            {review.concerns.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      )}

      {review.questions && review.questions.length > 0 && (
        <details className="rounded-md border border-border bg-card p-4">
          <summary className="cursor-pointer text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Questions ({review.questions.length})
          </summary>
          <ul className="mt-3 list-disc space-y-2 pl-6 text-sm">
            {review.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </details>
      )}

      {review.praise && review.praise.length > 0 && (
        <details className="rounded-md border border-border bg-card p-4">
          <summary className="cursor-pointer text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Praise ({review.praise.length})
          </summary>
          <ul className="mt-3 list-disc space-y-2 pl-6 text-sm">
            {review.praise.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      )}

      <Card className="p-5 font-mono text-xs text-muted">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em]">
              Tokens in
            </div>
            <div className="text-base text-text">
              {review.input_tokens ?? "—"}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em]">
              Tokens out
            </div>
            <div className="text-base text-text">
              {review.output_tokens ?? "—"}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em]">
              Est. cost
            </div>
            <div className="text-base text-text">{formatCost(cost)}</div>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em]">
              Reviewed
            </div>
            <div className="text-base text-text">
              {formatRelativeTime(review.created_at)}
            </div>
          </div>
        </div>
        {review.gate_reason && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em]">
              Auto-close gate result
            </div>
            <div className="text-sm text-text">{review.gate_reason}</div>
          </div>
        )}
      </Card>
    </div>
  );
}
