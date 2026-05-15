import Link from "next/link";
import { AccuracyChart } from "@/components/accuracy-chart";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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

// Self-learning surface. Originally Phase 7; Phase 8 adds the
// "Pending prompt improvements" section at the bottom.
//  * headline accuracy stat over the last 30 days
//  * 90-day accuracy line chart
//  * recent misses table (false_close + missed_issue) — the cases that
//    drive prompt improvements
//  * unresolved drift alerts at the top, red banner
//  * Phase 8 — open PRs from agent/prompt_tuner.py, each with the
//    failure cases that drove it and the proposed prompt.md diff

const ACTION_LABEL: Record<HumanActionType, string> = {
  agreement_close: "Agreement (close)",
  false_close: "False close",
  agreement_approve: "Agreement (approve)",
  missed_issue: "Missed issue",
  pending: "Pending",
};

const ACTION_COLOR: Record<HumanActionType, string> = {
  agreement_close: "#16a34a",
  agreement_approve: "#16a34a",
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
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      <section>
        <h1 className="text-xl font-semibold mb-1">Learning</h1>
        <p className="text-sm text-muted italic font-serif">
          how often the agent agrees with you, and where it doesn&apos;t
        </p>
      </section>

      {alerts.length > 0 && (
        <section
          className="rounded-lg border p-4"
          style={{
            borderColor: severityColors.critical,
            background: "#fef2f2",
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <Badge color={severityColors.critical}>DRIFT</Badge>
            <h2 className="text-sm font-semibold text-text">
              {alerts.length === 1
                ? "1 unresolved alert"
                : `${alerts.length} unresolved alerts`}
            </h2>
          </div>
          <ul className="text-sm font-mono space-y-1">
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
          <p className="text-xs font-mono text-muted mt-3">
            Resolve in Supabase by setting{" "}
            <code className="px-1 py-0.5 bg-card rounded border border-border">
              agent_alerts.resolved_at
            </code>{" "}
            once you&apos;ve audited the cases below.
          </p>
        </section>
      )}

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
          <h2 className="text-lg font-semibold">Recent misses</h2>
          <p className="text-xs text-muted font-mono">
            false_close + missed_issue · these drive prompt improvements
          </p>
        </div>
        {misses.length === 0 ? (
          <Card className="p-6 text-sm font-mono text-muted text-center">
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
                <tr key={m.id}>
                  <Td>
                    <Link
                      href={`/pr/${m.review_id}`}
                      className="text-accent hover:underline font-mono text-xs"
                    >
                      {m.repo}#{m.pr_number}
                    </Link>
                    <div className="text-xs text-muted truncate max-w-[28ch]">
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
                  <Td className="text-xs text-muted max-w-[36ch] truncate">
                    {m.notes || (
                      <span className="italic text-muted/70">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Pending prompt improvements</h2>
          <p className="text-xs text-muted font-mono">
            open PRs from the prompt-tuner agent · each one proposes a{" "}
            <code className="px-1 py-0.5 bg-card rounded border border-border">
              agent/prompt.md
            </code>{" "}
            edit driven by the misses above
          </p>
        </div>
        {promptTunerRuns.length === 0 ? (
          <Card className="p-6 text-sm font-mono text-muted text-center">
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
                      className="text-accent hover:underline font-semibold"
                    >
                      {run.agent_repo}#{run.pr_number}
                    </a>
                    <div className="text-sm text-text mt-0.5">
                      {run.pr_title}
                    </div>
                    <div className="text-xs font-mono text-muted mt-1">
                      opened {formatRelativeTime(run.created_at)} · branch{" "}
                      <code className="px-1 py-0.5 bg-bg rounded border border-border">
                        {run.branch_name}
                      </code>
                    </div>
                  </div>
                  <Badge color={palette.accent}>OPEN</Badge>
                </div>

                {run.rationale && (
                  <div>
                    <div className="text-xs font-mono text-muted uppercase tracking-wide mb-1">
                      Rationale
                    </div>
                    <p className="text-sm text-text whitespace-pre-line">
                      {run.rationale}
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs font-mono">
                  <span>
                    <span className="text-muted">cases driving it:</span>{" "}
                    <span className="text-text font-semibold">
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
                    <div className="text-xs font-mono text-muted uppercase tracking-wide mb-2">
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
                                className="text-accent hover:underline font-mono text-xs"
                              >
                                {c.repo}#{c.pr_number}
                              </Link>
                              <div className="text-xs text-muted truncate max-w-[28ch]">
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
                  <div className="text-xs font-mono text-muted uppercase tracking-wide mb-2">
                    Proposed diff (agent/prompt.md)
                  </div>
                  <pre className="text-xs font-mono bg-bg border border-border rounded p-3 overflow-x-auto max-h-96 leading-relaxed">
                    {run.proposed_diff}
                  </pre>
                </div>

                <p className="text-xs font-mono text-muted italic">
                  The agent never merges its own PR. Review the diff on
                  GitHub before merging.
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
