import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import {
  formatCost,
  formatRelativeTime,
  palette,
  severityColor,
  tokenCostUSD,
  verdictBadge,
} from "@/lib/design";
import type { Bug, Review } from "@/lib/types";

const SEVERITY_COLOR_MAP: Record<Bug["severity"], string> = {
  high: "#dc2626",
  medium: "#ea580c",
  low: "#ca8a04",
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

export function PrDetail({ review }: { review: Review }) {
  const v = verdictBadge(review.verdict);
  const sevColor = severityColor(review.severity_score);
  const cost = tokenCostUSD(review.input_tokens, review.output_tokens);
  const grouped = groupBugs(review.bugs ?? []);
  const totalBugs =
    grouped.high.length + grouped.medium.length + grouped.low.length;

  return (
    <div className="space-y-6">
      <div>
        <div className="font-mono text-xs text-muted mb-2">
          <a
            href={review.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
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
          <Badge color={palette.text}>auto-closed</Badge>
        )}
        {review.truncated && (
          <Badge color={palette.muted} variant="outline">
            diff truncated
          </Badge>
        )}
      </div>

      <Card className="p-5">
        <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-2">
          Summary
        </div>
        <p className="text-base leading-relaxed">{review.summary}</p>
      </Card>

      {totalBugs > 0 && (
        <section>
          <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-3">
            Bugs ({review.bug_count})
          </div>
          <div className="space-y-3">
            {(["high", "medium", "low"] as const).flatMap((sev) =>
              grouped[sev].map((b, i) => (
                <Card
                  key={`${sev}-${i}`}
                  className="p-4 border-l-4"
                  style={{ borderLeftColor: SEVERITY_COLOR_MAP[sev] }}
                >
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <Badge color={SEVERITY_COLOR_MAP[sev]}>
                      {sev.toUpperCase()}
                    </Badge>
                    <code className="text-xs font-mono text-muted">
                      {b.file}
                    </code>
                  </div>
                  <p className="text-sm leading-relaxed">{b.issue}</p>
                  {b.suggestion && (
                    <p className="mt-2 text-sm text-muted leading-relaxed">
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
        <details className="bg-card border border-border rounded-lg p-4">
          <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-wider text-muted">
            Concerns ({review.concerns.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm list-disc pl-6">
            {review.concerns.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      )}

      {review.questions && review.questions.length > 0 && (
        <details className="bg-card border border-border rounded-lg p-4">
          <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-wider text-muted">
            Questions ({review.questions.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm list-disc pl-6">
            {review.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </details>
      )}

      {review.praise && review.praise.length > 0 && (
        <details className="bg-card border border-border rounded-lg p-4">
          <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-wider text-muted">
            Praise ({review.praise.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm list-disc pl-6">
            {review.praise.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      )}

      <Card className="p-5 font-mono text-xs text-muted">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <div className="uppercase tracking-wider text-[10px] mb-1">
              Tokens in
            </div>
            <div className="text-text text-base">
              {review.input_tokens ?? "—"}
            </div>
          </div>
          <div>
            <div className="uppercase tracking-wider text-[10px] mb-1">
              Tokens out
            </div>
            <div className="text-text text-base">
              {review.output_tokens ?? "—"}
            </div>
          </div>
          <div>
            <div className="uppercase tracking-wider text-[10px] mb-1">
              Est. cost
            </div>
            <div className="text-text text-base">{formatCost(cost)}</div>
          </div>
          <div>
            <div className="uppercase tracking-wider text-[10px] mb-1">
              Reviewed
            </div>
            <div className="text-text text-base">
              {formatRelativeTime(review.created_at)}
            </div>
          </div>
        </div>
        {review.gate_reason && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="uppercase tracking-wider text-[10px] mb-1">
              Auto-close gate result
            </div>
            <div className="text-text text-sm">{review.gate_reason}</div>
          </div>
        )}
      </Card>
    </div>
  );
}
