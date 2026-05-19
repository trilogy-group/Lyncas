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
import type {
  Bug,
  BugSeverityRaw,
  Concern,
  HumanAction,
  HumanActionType,
  Review,
} from "@/lib/types";

// Map every severity the agent might emit (incl. the "critical" tier
// the reviewer/critic nodes use pre-normalisation) onto a palette entry.
const SEVERITY_COLOR_MAP: Record<BugSeverityRaw, string> = {
  critical: severityColors.critical,
  high: severityColors.critical,
  medium: severityColors.serious,
  low: severityColors.moderate,
};

// Normalise a Bug's severity into the three-bucket UI vocabulary
// ("high" | "medium" | "low"). The agent occasionally writes "critical"
// before the final node collapses it; group it with "high" so the
// renderer doesn't drop those bugs.
function bucketSeverity(s: BugSeverityRaw): "high" | "medium" | "low" {
  if (s === "critical" || s === "high") return "high";
  if (s === "medium") return "medium";
  return "low";
}

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
  const out: { high: Bug[]; medium: Bug[]; low: Bug[] } = {
    high: [],
    medium: [],
    low: [],
  };
  for (const b of bugs) out[bucketSeverity(b.severity)].push(b);
  return out;
}

// Coerce any LLM-emitted value into something React can render as a
// child. The reviewer prompt asks for strings, but real outputs have
// occasionally come back as nested objects — that's what triggered the
// React error #31 we're hardening against here. Strings pass through;
// numbers/bools become their string form; objects fall back to JSON.
function safeText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

// React can't render objects as children. The agent's prompt schema
// emits `concerns` as structured objects (`{file, issue, suggestion,
// ...}`), but older rows / `questions` / `praise` are still plain
// strings. This helper accepts either shape and returns a guaranteed
// non-object label string + an optional structured tail so the UI can
// surface the extra context without crashing.
function normalizeConcern(
  c: Concern,
): { label: string; tail?: string | null; file?: string } {
  if (typeof c === "string") return { label: c };
  if (c == null) return { label: "" };
  const file = typeof c.file === "string" ? c.file : undefined;
  const issue = safeText(c.issue);
  const impact = safeText(c.impact);
  const suggestion = safeText(c.suggestion);
  const reference = safeText(c.reference);
  // Prefer issue → impact → suggestion → reference → JSON fallback.
  // We never want an empty bullet, so we keep walking down the chain
  // until something has content.
  const label =
    issue || impact || suggestion || reference || safeText(c) || "";
  const tail = suggestion && suggestion !== label ? suggestion : null;
  return { label, tail, file };
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
            className="text-white hover:underline underline-offset-4"
          >
            {review.repo}#{review.pr_number} ↗
          </a>
          {review.pr_author && (
            <>
              {" · by "}
              <span className="text-white">{review.pr_author}</span>
            </>
          )}
        </div>
        <h1 className="text-2xl sm:text-3xl font-semibold leading-tight tracking-tight text-white">
          {safeText(review.pr_title)}
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
        <p className="mt-2 text-base leading-relaxed">
          {safeText(review.summary)}
        </p>
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
                      {safeText(b.file)}
                      {b.line_hint ? `:${safeText(b.line_hint)}` : ""}
                    </code>
                  </div>
                  <p className="text-sm leading-relaxed">{safeText(b.issue)}</p>
                  {b.impact && (
                    <p className="mt-2 text-sm leading-relaxed text-muted">
                      <span className="font-semibold text-text">Impact: </span>
                      {safeText(b.impact)}
                    </p>
                  )}
                  {b.suggestion && (
                    <p className="mt-2 text-sm leading-relaxed text-muted">
                      <span className="font-semibold text-text">
                        Suggestion:{" "}
                      </span>
                      {safeText(b.suggestion)}
                    </p>
                  )}
                  {b.reference &&
                    (() => {
                      const ref = safeText(b.reference);
                      // Only render as a link if it parses as a URL —
                      // otherwise the agent gave us prose ("RFC 7231")
                      // and we should render it inline.
                      let href: string | null = null;
                      try {
                        href = new URL(ref).toString();
                      } catch {
                        href = null;
                      }
                      return (
                        <p className="mt-2 font-mono text-xs">
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted hover:text-text underline underline-offset-2"
                            >
                              {ref}
                            </a>
                          ) : (
                            <span className="text-muted">{ref}</span>
                          )}
                        </p>
                      );
                    })()}
                </Card>
              )),
            )}
          </div>
        </section>
      )}

      <ConcernList label="Concerns" items={review.concerns} />
      <ConcernList label="Questions" items={review.questions} />
      <ConcernList label="Praise" items={review.praise} />

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

// Collapsible list of "concerns | questions | praise". Each item is
// normalised through normalizeConcern() so an object with the agent's
// rich shape and a plain string both render without React error #31.
function ConcernList({
  label,
  items,
}: {
  label: string;
  items: Concern[] | null | undefined;
}) {
  if (!items || items.length === 0) return null;
  return (
    <details className="rounded-md border border-border bg-card p-4">
      <summary className="cursor-pointer text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
        {label} ({items.length})
      </summary>
      <ul className="mt-3 list-disc space-y-2 pl-6 text-sm">
        {items.map((c, i) => {
          const n = normalizeConcern(c);
          return (
            <li key={i}>
              {n.file && (
                <code className="mr-2 font-mono text-xs text-muted">
                  {n.file}
                </code>
              )}
              <span>{n.label}</span>
              {n.tail && (
                <span className="block text-muted">
                  <span className="font-semibold text-text">
                    Suggestion:{" "}
                  </span>
                  {n.tail}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
