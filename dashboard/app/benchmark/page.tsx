import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatCard } from "@/components/ui/stat-card";
import { palette, severityColors, verdictBadge } from "@/lib/design";
import { getBenchmarkRuns, getBenchmarkStats } from "@/lib/queries";
import type { BenchmarkRun, BenchmarkStats, Bug } from "@/lib/types";

export const dynamic = "force-dynamic";

// --- Bug matching (mirrors agent/benchmark.py's heuristic) ----------------
// Same Jaccard-on-(file + first-60-chars-of-issue) approach the Python
// runner uses. Re-done here so the drill-down can highlight matched
// vs unique bugs.

const BUG_OVERLAP_THRESHOLD = 0.7;

function bugTokens(b: Bug): Set<string> {
  const filePart = (b.file ?? "").trim();
  const issuePart = (b.issue ?? "").trim().slice(0, 60);
  const text = `${filePart} ${issuePart}`.toLowerCase();
  const matches = text.match(/\w+/g) ?? [];
  return new Set(matches);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function matchBugs(
  sonnetBugs: Bug[],
  opusBugs: Bug[],
): { sonnetMatched: boolean[]; opusMatched: boolean[] } {
  const sTok = sonnetBugs.map(bugTokens);
  const oTok = opusBugs.map(bugTokens);
  const sonnetMatched = sonnetBugs.map(() => false);
  const opusMatched = opusBugs.map(() => false);
  for (let i = 0; i < sonnetBugs.length; i++) {
    let bestJ = -1;
    let bestScore = 0;
    for (let j = 0; j < opusBugs.length; j++) {
      if (opusMatched[j]) continue;
      const s = jaccard(sTok[i], oTok[j]);
      if (s > bestScore) {
        bestScore = s;
        bestJ = j;
      }
    }
    if (bestJ >= 0 && bestScore >= BUG_OVERLAP_THRESHOLD) {
      sonnetMatched[i] = true;
      opusMatched[bestJ] = true;
    }
  }
  return { sonnetMatched, opusMatched };
}

// --- Small render helpers -------------------------------------------------

function sevDeltaColor(d: number | null | undefined): string {
  const v = d ?? 0;
  if (v === 0) return severityColors.clean;
  if (v <= 2) return severityColors.moderate;
  return severityColors.critical;
}

function formatRatio(r: number): string {
  if (!isFinite(r) || r <= 0) return "—";
  if (r < 10) return `${r.toFixed(1)}x`;
  return `${Math.round(r)}x`;
}

function microsToUSD(micros: number | null | undefined): number {
  return (micros ?? 0) / 1_000_000;
}

function formatMicros(micros: number | null | undefined): string {
  const usd = microsToUSD(micros);
  if (usd <= 0) return "$0";
  if (usd < 0.001) return "<$0.001";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// --- Conclusion (dynamic — text driven by data, not opinion) --------------

function Conclusion({ stats }: { stats: BenchmarkStats }) {
  if (stats.sample_size === 0) return null;

  const agree = stats.agreement_pct >= 80 && stats.mean_sev_delta <= 1;
  const disagreePct = 100 - stats.agreement_pct;
  const ratio = formatRatio(stats.cost_ratio);

  const headline = agree
    ? `On this small sample, the models agree on verdict and severity within tolerance. Cost difference (${ratio}) is not justified by output divergence at current evaluation depth.`
    : `Models disagree meaningfully on ${disagreePct.toFixed(0)}% of cases. Cost savings of choosing Sonnet may not be worth the quality variance for production use. Larger benchmark + ground truth needed before committing.`;

  return (
    <Card className="p-6">
      <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
        Conclusion
      </div>
      <p className="mt-3 text-sm leading-relaxed">{headline}</p>
      <p className="mt-3 text-sm text-muted leading-relaxed">
        This is n={stats.sample_size}, single-grader, directional only. Not a
        substitute for a ground-truth labeled benchmark with multiple raters.
      </p>
    </Card>
  );
}

// --- Per-PR row (with drill-down) -----------------------------------------

function ModelCell({
  verdict,
  severity,
}: {
  verdict: string | null;
  severity: number | null;
}) {
  if (!verdict) {
    return <span className="text-muted">—</span>;
  }
  const meta = verdictBadge(verdict);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Badge color={meta.color}>{meta.label}</Badge>
      <span className="text-xs font-mono text-muted">
        sev {severity ?? "?"}
      </span>
    </div>
  );
}

function BugList({
  bugs,
  matched,
  label,
}: {
  bugs: Bug[];
  matched: boolean[];
  label: string;
}) {
  if (bugs.length === 0) {
    return (
      <div>
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          {label}
        </div>
        <div className="mt-2 text-xs italic text-muted">no bugs flagged</div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
        {label} ({bugs.length})
      </div>
      <ul className="mt-2 space-y-2">
        {bugs.map((b, i) => {
          const isMatched = matched[i];
          const borderColor = isMatched
            ? severityColors.clean
            : severityColors.moderate;
          return (
            <li
              key={i}
              className="rounded-sm border-l-2 bg-card px-3 py-2 text-xs"
              style={{ borderLeftColor: borderColor }}
            >
              <div className="mb-0.5 font-mono text-[11px] text-muted">
                {b.file || "?"} ·{" "}
                <span style={{ color: borderColor }}>
                  {isMatched ? "matched" : "only here"}
                </span>{" "}
                · sev {b.severity}
              </div>
              <div className="leading-snug text-text">{b.issue}</div>
              {b.suggestion && (
                <div className="mt-1 leading-snug text-muted">
                  → {b.suggestion}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BenchmarkRow({ row }: { row: BenchmarkRun }) {
  const sonnetBugs = row.sonnet_bugs ?? [];
  const opusBugs = row.opus_bugs ?? [];
  const { sonnetMatched, opusMatched } = matchBugs(sonnetBugs, opusBugs);

  const overlap = row.bug_overlap_count ?? 0;
  const totalUnique =
    overlap + (row.bugs_only_in_sonnet ?? 0) + (row.bugs_only_in_opus ?? 0);
  const overlapStr =
    totalUnique === 0 ? "no bugs" : `${overlap}/${totalUnique} matched`;

  const sonnetCost = row.sonnet_cost_micros ?? 0;
  const opusCost = row.opus_cost_micros ?? 0;
  const ratio = sonnetCost > 0 ? opusCost / sonnetCost : 0;

  const agree = row.verdict_agreement === true;
  const sevDelta = row.severity_delta ?? 0;
  const opusFailed = row.verdict_agreement === null;

  return (
    <details className="group bg-card open:bg-bg-elev">
      <summary className="cursor-pointer list-none px-5 py-4 hover:bg-bg-elev transition-colors">
        <div className="grid grid-cols-12 items-center gap-3">
          <div className="col-span-4 min-w-0">
            <a
              href={row.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate text-sm font-medium hover:text-text"
            >
              {row.pr_title}
            </a>
            <div className="truncate font-mono text-[11px] text-muted">
              {row.pr_url.replace("https://github.com/", "")}
            </div>
          </div>
          <div className="col-span-3">
            <ModelCell verdict={row.sonnet_verdict} severity={row.sonnet_severity} />
          </div>
          <div className="col-span-3">
            <ModelCell verdict={row.opus_verdict} severity={row.opus_severity} />
          </div>
          <div className="col-span-2 flex flex-wrap items-center justify-end gap-2 font-mono text-xs">
            {opusFailed ? (
              <Badge color={palette.muted} variant="outline">
                no opus data
              </Badge>
            ) : (
              <>
                <Badge
                  color={
                    agree ? severityColors.clean : severityColors.critical
                  }
                >
                  {agree ? "✓ agree" : "✗ disagree"}
                </Badge>
                <span
                  style={{ color: sevDeltaColor(sevDelta) }}
                  title="Severity delta"
                >
                  Δ{sevDelta}
                </span>
                <span className="text-muted" title="Bug overlap">
                  {overlapStr}
                </span>
                <span className="text-muted" title="Opus cost / Sonnet cost">
                  {formatRatio(ratio)}
                </span>
              </>
            )}
            <span className="text-muted transition-transform group-open:rotate-180">
              ▾
            </span>
          </div>
        </div>
      </summary>

      <div className="border-t border-border bg-bg px-5 pb-5 pt-4">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
              Sonnet summary
            </div>
            <p className="mt-2 text-sm leading-relaxed text-text">
              {row.sonnet_summary ?? <span className="italic text-muted">no summary</span>}
            </p>
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
              Opus summary
            </div>
            <p className="mt-2 text-sm leading-relaxed text-text">
              {row.opus_summary ?? <span className="italic text-muted">no summary</span>}
            </p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
          <BugList bugs={sonnetBugs} matched={sonnetMatched} label="Sonnet bugs" />
          <BugList bugs={opusBugs} matched={opusMatched} label="Opus bugs" />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 text-[11px] font-mono text-muted md:grid-cols-4">
          <div>
            <div className="uppercase tracking-[0.14em]">Sonnet tokens</div>
            <div className="mt-1 text-text">
              {row.sonnet_input_tokens ?? "?"} in /{" "}
              {row.sonnet_output_tokens ?? "?"} out
            </div>
            <div className="mt-0.5">{formatMicros(row.sonnet_cost_micros)}</div>
          </div>
          <div>
            <div className="uppercase tracking-[0.14em]">Opus tokens</div>
            <div className="mt-1 text-text">
              {row.opus_input_tokens ?? "?"} in /{" "}
              {row.opus_output_tokens ?? "?"} out
            </div>
            <div className="mt-0.5">{formatMicros(row.opus_cost_micros)}</div>
          </div>
          <div>
            <div className="uppercase tracking-[0.14em]">Sonnet confidence</div>
            <div className="mt-1 text-text">{row.sonnet_confidence}</div>
          </div>
          <div>
            <div className="uppercase tracking-[0.14em]">Opus confidence</div>
            <div className="mt-1 text-text">
              {row.opus_confidence ?? <span className="italic">—</span>}
            </div>
          </div>
        </div>
      </div>
    </details>
  );
}

// --- Page -----------------------------------------------------------------

export default async function BenchmarkPage() {
  const [rows, stats] = await Promise.all([
    getBenchmarkRuns(),
    getBenchmarkStats(),
  ]);

  return (
    <Container className="py-10 space-y-8">
      <SectionHeading
        eyebrow="Benchmark"
        title="Sonnet vs Opus"
        subtitle={
          <>Comparing two models on the same diffs with the same prompt. n=
          {stats.sample_size}.</>
        }
      />

      {stats.sample_size === 0 ? (
        <Card className="p-8 text-center">
          <div className="mx-auto max-w-md text-sm leading-relaxed text-muted">
            <p>No benchmark runs yet.</p>
            <p className="mt-3">
              Populate the table by running{" "}
              <code className="rounded-sm border border-border bg-bg-elev px-1.5 py-0.5 font-mono text-[12px]">
                cd agent && python benchmark.py --latest 5
              </code>{" "}
              from the repo root with the same env vars the agent uses.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            label="Verdict agreement"
            value={`${stats.agreement_pct.toFixed(0)}%`}
            hint={`${Math.round((stats.agreement_pct / 100) * stats.sample_size)} / ${stats.sample_size} match`}
            accent={
              stats.agreement_pct >= 80
                ? severityColors.clean
                : severityColors.critical
            }
          />
          <StatCard
            label="Mean sev delta"
            value={stats.mean_sev_delta.toFixed(1)}
            hint="|sonnet − opus|"
            accent={sevDeltaColor(stats.mean_sev_delta)}
          />
          <StatCard
            label="Mean bug overlap"
            value={`${stats.mean_bug_overlap_pct.toFixed(0)}%`}
            hint="bugs both models found"
          />
          <StatCard
            label="Cost ratio"
            value={formatRatio(stats.cost_ratio)}
            hint="opus / sonnet"
          />
        </div>
      )}

      <details open className="rounded-md border border-border bg-card px-5 py-4">
        <summary className="cursor-pointer select-none text-sm font-medium">
          Methodology
        </summary>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Each PR diff was sent through both models using the same system
          prompt (
          <code className="font-mono text-[12px]">prompt.md</code>). Outputs
          were compared on verdict, severity, and bug list. Bug overlap is
          computed via a simple 70% token Jaccard on file + issue text — a
          heuristic, not perfect. Sample size is small (&lt;10 in v1); this is
          directional evidence, not statistically significant. A larger
          benchmark would need a hand-graded ground truth, which I haven&apos;t
          built yet.
        </p>
      </details>

      {rows.length > 0 && (
        <div>
          <div className="mb-2 px-1 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Per-PR comparison · {rows.length} row{rows.length === 1 ? "" : "s"}
          </div>
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
            <div className="hidden grid-cols-12 gap-3 border-b border-border bg-bg-elev px-5 py-3 text-[10px] font-mono uppercase tracking-[0.18em] text-muted md:grid">
              <div className="col-span-4">PR</div>
              <div className="col-span-3">Sonnet</div>
              <div className="col-span-3">Opus</div>
              <div className="col-span-2 text-right">Agreement · Δ · bugs · cost</div>
            </div>
            {rows.map((row) => (
              <BenchmarkRow key={row.id} row={row} />
            ))}
          </div>
        </div>
      )}

      <Conclusion stats={stats} />
    </Container>
  );
}
