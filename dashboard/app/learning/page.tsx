import Link from "next/link";
import { AccuracyChart } from "@/components/accuracy-chart";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import { formatRelativeTime, palette, severityColors } from "@/lib/design";
import {
  getAccuracyOverTime,
  getAccuracyStats,
  getAgentAlerts,
  getOpenPromptTunerRuns,
  getRecentMisses,
} from "@/lib/queries";
import type { HumanActionType } from "@/lib/types";

export const dynamic = "force-dynamic";

// Self-learning surface.
//   * headline accuracy stat over the last 30 days
//   * 90-day accuracy line chart
//   * recent misses table (false_close + missed_issue)
//   * unresolved drift alerts at the top
//   * open prompt-tuner PRs, each with the failure cases that drove it
//     and the proposed prompt.md diff

const ACTION_LABEL: Record<HumanActionType, string> = {
  agreement_close: "Agreement (close)",
  false_close: "False close",
  agreement_approve: "Agreement (approve)",
  missed_issue: "Missed issue",
  pending: "Pending",
};

const ACTION_COLOR: Record<HumanActionType, string> = {
  agreement_close: severityColors.clean,
  agreement_approve: severityColors.clean,
  false_close: severityColors.critical,
  missed_issue: severityColors.critical,
  pending: palette.muted,
};

const ALERT_LABEL: Record<string, string> = {
  false_close_rate: "False-close rate",
  missed_issue_rate: "Missed-issue rate",
};

export default async function LearningPage() {
  const [stats, timeline, misses, alerts, promptTunerRuns] = await Promise.all([
    getAccuracyStats(30),
    getAccuracyOverTime(90),
    getRecentMisses(50),
    getAgentAlerts(true),
    getOpenPromptTunerRuns(),
  ]);

  return (
    <Container className="py-10 space-y-10">
      <SectionHeading
        eyebrow="Learning"
        title="How the agent improves"
        subtitle={
          <>
            How often the agent agrees with you, and where it doesn&apos;t.
          </>
        }
      />

      {alerts.length > 0 && (
        <section className="rounded-md border border-[#ff5252] bg-[#ff5252]/10 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Badge color={severityColors.critical}>DRIFT</Badge>
            <h2 className="text-sm font-semibold text-text">
              {alerts.length === 1
                ? "1 unresolved alert"
                : `${alerts.length} unresolved alerts`}
            </h2>
          </div>
          <ul className="space-y-1 font-mono text-sm">
            {alerts.map((a) => (
              <li key={a.id}>
                <span className="text-text">
                  {ALERT_LABEL[a.alert_type] ?? a.alert_type}
                </span>{" "}
                = {(a.metric_value * 100).toFixed(1)}%{" "}
                <span className="text-muted">
                  (threshold {(a.threshold * 100).toFixed(0)}%, raised{" "}
                  {formatRelativeTime(a.raised_at)})
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 font-mono text-xs text-muted">
            Resolve in Supabase by setting{" "}
            <code className="rounded-sm border border-border bg-card px-1 py-0.5">
              agent_alerts.resolved_at
            </code>{" "}
            once you&apos;ve audited the cases below.
          </p>
        </section>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Agent accuracy (30d)"
          value={
            stats.total_non_pending > 0
              ? `${stats.accuracy_pct.toFixed(0)}%`
              : "—"
          }
          hint={
            stats.total_non_pending > 0
              ? `${stats.agreements} / ${stats.total_non_pending} settled`
              : "no settled observations yet"
          }
          accent={
            stats.total_non_pending > 0 && stats.accuracy_pct < 95
              ? severityColors.serious
              : undefined
          }
        />
        <StatCard
          label="Failures (30d)"
          value={String(stats.failures)}
          hint="false_close + missed_issue"
          accent={stats.failures > 0 ? severityColors.critical : undefined}
        />
        <StatCard
          label="Agreements (30d)"
          value={String(stats.agreements)}
          hint="agreement_close + approve"
        />
        <StatCard
          label="Pending (30d)"
          value={String(stats.pending)}
          hint="not yet resolvable"
        />
      </section>

      <section>
        <AccuracyChart data={timeline} />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-white tracking-tight">Recent misses</h2>
          <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted">
            false_close + missed_issue · these drive prompt improvements
          </p>
        </div>
        {misses.length === 0 ? (
          <Card className="p-6 text-center font-mono text-sm text-muted">
            no misses yet — either the agent is perfect or there&apos;s not
            enough data
          </Card>
        ) : (
          <Table>
            <TableHeader>
              <tr>
                <Th>PR</Th>
                <Th>Type</Th>
                <Th>Observed</Th>
                <Th>Notes</Th>
              </tr>
            </TableHeader>
            <TableBody>
              {misses.map((m) => (
                <tr key={m.id} className="hover:bg-bg-elev transition-colors">
                  <Td>
                    <Link
                      href={`/pr/${m.review_id}`}
                      className="font-mono text-xs text-text hover:underline underline-offset-4"
                    >
                      {m.repo}#{m.pr_number}
                    </Link>
                    <div className="max-w-[28ch] truncate text-xs text-muted">
                      {m.pr_title}
                    </div>
                  </Td>
                  <Td>
                    <Badge color={ACTION_COLOR[m.action_type]}>
                      {ACTION_LABEL[m.action_type]}
                    </Badge>
                  </Td>
                  <Td className="font-mono text-xs text-muted">
                    {formatRelativeTime(m.observed_at)}
                  </Td>
                  <Td className="max-w-[36ch] truncate text-xs text-muted">
                    {m.notes || <span className="italic text-muted/70">—</span>}
                  </Td>
                </tr>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-white tracking-tight">Pending prompt improvements</h2>
          <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted">
            open PRs from the prompt-tuner agent · each one proposes a{" "}
            <code className="rounded-sm border border-border bg-bg-elev px-1 py-0.5 normal-case tracking-normal">
              agent/prompt.md
            </code>{" "}
            edit driven by the misses above
          </p>
        </div>
        {promptTunerRuns.length === 0 ? (
          <Card className="p-6 text-center font-mono text-sm text-muted">
            no open prompt-tuner PRs · the agent hasn&apos;t found enough
            failure cases to justify a prompt change yet
          </Card>
        ) : (
          <div className="space-y-4">
            {promptTunerRuns.map((run) => (
              <Card key={run.id} className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <a
                      href={run.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-base font-semibold text-text hover:underline underline-offset-4"
                    >
                      {run.agent_repo}#{run.pr_number}
                    </a>
                    <div className="mt-0.5 text-sm text-text">
                      {run.pr_title}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted">
                      opened {formatRelativeTime(run.created_at)} · branch{" "}
                      <code className="rounded-sm border border-border bg-bg-elev px-1 py-0.5">
                        {run.branch_name}
                      </code>
                    </div>
                  </div>
                  <Badge color={severityColors.clean}>OPEN</Badge>
                </div>

                {run.rationale && (
                  <div>
                    <div className="mb-1 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
                      Rationale
                    </div>
                    <p className="whitespace-pre-line text-sm text-text">
                      {run.rationale}
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs">
                  <span>
                    <span className="text-muted">cases driving it:</span>{" "}
                    <span className="font-semibold text-text">
                      {run.failure_case_count}
                    </span>
                  </span>
                  {run.accuracy_before_pct !== null && (
                    <span>
                      <span className="text-muted">accuracy before:</span>{" "}
                      <span className="text-text">
                        {run.accuracy_before_pct.toFixed(1)}%
                      </span>
                    </span>
                  )}
                  {run.accuracy_after_pct_est !== null && (
                    <span>
                      <span className="text-muted">est. after:</span>{" "}
                      <span className="text-text">
                        {run.accuracy_after_pct_est.toFixed(1)}%
                      </span>
                    </span>
                  )}
                </div>

                {run.failure_cases.length > 0 && (
                  <div>
                    <div className="mb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
                      Failure cases
                    </div>
                    <Table>
                      <TableHeader>
                        <tr>
                          <Th>PR</Th>
                          <Th>Type</Th>
                          <Th>Agent verdict</Th>
                          <Th>Observed</Th>
                        </tr>
                      </TableHeader>
                      <TableBody>
                        {run.failure_cases.map((c) => (
                          <tr key={`${run.id}-${c.review_id}`}>
                            <Td>
                              <Link
                                href={`/pr/${c.review_id}`}
                                className="font-mono text-xs text-text hover:underline underline-offset-4"
                              >
                                {c.repo}#{c.pr_number}
                              </Link>
                              <div className="max-w-[28ch] truncate text-xs text-muted">
                                {c.pr_title}
                              </div>
                            </Td>
                            <Td>
                              <Badge color={ACTION_COLOR[c.action_type]}>
                                {ACTION_LABEL[c.action_type]}
                              </Badge>
                            </Td>
                            <Td className="font-mono text-xs text-muted">
                              {c.agent_verdict ?? "?"}
                              {typeof c.agent_severity === "number" && (
                                <> · sev {c.agent_severity}</>
                              )}
                            </Td>
                            <Td className="font-mono text-xs text-muted">
                              {formatRelativeTime(c.observed_at)}
                            </Td>
                          </tr>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                <div>
                  <div className="mb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
                    Proposed diff (agent/prompt.md)
                  </div>
                  <pre className="max-h-96 overflow-x-auto rounded-sm border border-border bg-bg-elev p-3 text-xs leading-relaxed font-mono">
                    {run.proposed_diff}
                  </pre>
                </div>

                <p className="italic font-mono text-xs text-muted">
                  The agent never merges its own PR. Review the diff on GitHub
                  before merging.
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>
    </Container>
  );
}
