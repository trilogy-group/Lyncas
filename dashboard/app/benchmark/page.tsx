import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import {
  palette,
  severityColors,
  verdictBadge,
} from "@/lib/design";
import { getBenchmarkRuns, getBenchmarkStats } from "@/lib/queries";
import type { BenchmarkRun, BenchmarkStats, Bug } from "@/lib/types";

export const dynamic = "force-dynamic";

// --- Bug matching (mirrors agent/benchmark.py's heuristic) ----------------
// Same Jaccard-on-(file + first-60-chars-of-issue) approach the Python
// runner uses. We re-do it here so the drill-down can highlight matched
// vs unique bugs visually — the DB only stores counts, not match pairs.
// If we ever care to be authoritative, store the matches in the row.

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

  const agree =
    stats.agreement_pct >= 80 && stats.mean_sev_delta <= 1;
  const disagreePct = 100 - stats.agreement_pct;
  const ratio = formatRatio(stats.cost_ratio);

  const headline = agree
    ? `On this small sample, the models agree on verdict and severity within tolerance. Cost difference (${ratio}) is not justified by output divergence at current evaluation depth.`
    : `Models disagree meaningfully on ${disagreePct.toFixed(0)}% of cases. Cost savings of choosing Sonnet may not be worth the quality variance for production use. Larger benchmark + ground truth needed before committing.`;

  return (
    <Card className="p-6 bg-bg">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-3">
        Conclusion
      </div>
      <p className="text-sm leading-relaxed">{headline}</p>
      <p className="mt-3 font-serif italic text-sm text-muted leading-relaxed">
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
    <div className="flex items-center gap-2 min-w-0">
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
        <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-2">
          {label}
        </div>
        <div className="text-xs text-muted italic">no bugs flagged</div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-2">
        {label} ({bugs.length})
      </div>
      <ul className="space-y-2">
        {bugs.map((b, i) => {
          const isMatched = matched[i];
          // matched -> green tint, unique -> amber tint
          const borderColor = isMatched
            ? severityColors.clean
            : severityColors.moderate;
          return (
            <li
              key={i}
              className="rounded border-l-4 px-3 py-2 text-xs bg-card"
              style={{ borderColor }}
            >
              <div className="font-mono text-[11px] text-muted mb-0.5">
                {b.file || "?"} ·{" "}
                <span style={{ color: borderColor }}>
                  {isMatched ? "matched" : "only here"}
                </span>{" "}
                · sev {b.severity}
              </div>
              <div className="text-text leading-snug">{b.issue}</div>
              {b.suggestion && (
                <div className="mt-1 text-muted leading-snug">
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
  // Opus failed entirely on this row — don't pretend we have a comparison
  const opusFailed = row.verdict_agreement === null;

  return (
    <details className="group bg-card open:bg-bg">
      <summary className="cursor-pointer list-none px-5 py-4 hover:bg-bg transition-colors">
        <div className="grid grid-cols-12 gap-3 items-center">
          <div className="col-span-4 min-w-0">
            <a
              href={row.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block font-medium text-sm truncate hover:text-accent"
            >
              {row.pr_title}
            </a>
            <div className="text-[11px] font-mono text-muted truncate">
              {row.pr_url.replace("https://github.com/", "")}
            </div>
          </div>
          <div className="col-span-3">
            <ModelCell
              verdict={row.sonnet_verdict}
              severity={row.sonnet_severity}
            />
          </div>
          <div className="col-span-3">
            <ModelCell
              verdict={row.opus_verdict}
              severity={row.opus_severity}
            />
          </div>
          <div className="col-span-2 flex flex-wrap gap-2 justify-end text-xs font-mono">
            {opusFailed ? (
              <Badge color={palette.muted} variant="outline">
                no opus data
              </Badge>
            ) : (
              <>
                <Badge
                  color={agree ? severityColors.clean : severityColors.critical}
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
            <span className="text-muted group-open:rotate-180 transition-transform">
              ▾
            </span>
          </div>
        </div>
      </summary>

      <div className="px-5 pb-5 pt-1 border-t border-border bg-bg">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-4">
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted mb-2">
              Sonnet summary
            </div>
            <p className="text-sm leading-relaxed text-text">
              {row.sonnet_summary ?? <span className="italic text-muted">no summary</span>}
            </p>
          </div>
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted mb-2">
              Opus summary
            </div>
            <p className="text-sm leading-relaxed text-text">
              {row.opus_summary ?? <span className="italic text-muted">no summary</span>}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-6">
          <BugList
            bugs={sonnetBugs}
            matched={sonnetMatched}
            label="Sonnet bugs"
          />
          <BugList
            bugs={opusBugs}
            matched={opusMatched}
            label="Opus bugs"
          />
        </div>

        <div className="mt-5 pt-4 border-t border-border grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] font-mono text-muted">
          <div>
            <div className="uppercase tracking-wider">Sonnet tokens</div>
            <div className="text-text mt-1">
              {row.sonnet_input_tokens ?? "?"} in /{" "}
              {row.sonnet_output_tokens ?? "?"} out
            </div>
            <div className="mt-0.5">{formatMicros(row.sonnet_cost_micros)}</div>
          </div>
          <div>
            <div className="uppercase tracking-wider">Opus tokens</div>
            <div className="text-text mt-1">
              {row.opus_input_tokens ?? "?"} in /{" "}
              {row.opus_output_tokens ?? "?"} out
            </div>
            <div className="mt-0.5">{formatMicros(row.opus_cost_micros)}</div>
          </div>
          <div>
            <div className="uppercase tracking-wider">Sonnet confidence</div>
            <div className="text-text mt-1">{row.sonnet_confidence}</div>
          </div>
          <div>
            <div className="uppercase tracking-wider">Opus confidence</div>
            <div className="text-text mt-1">
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
    <div className="max-w-6xl mx-auto px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Sonnet vs Opus benchmark
        </h1>
        <p className="mt-2 font-serif italic text-muted">
          comparing two models on the same diffs with the same prompt. n=
          {stats.sample_size}.
        </p>
      </header>

      {stats.sample_size === 0 ? (
        <Card className="p-8 text-center">
          <div className="text-sm text-muted leading-relaxed max-w-md mx-auto">
            <p>No benchmark runs yet.</p>
            <p className="mt-3">
              Populate the table by running{" "}
              <code className="px-1.5 py-0.5 bg-bg border border-border rounded text-[12px] font-mono">
                cd agent && python benchmark.py --latest 5
              </code>{" "}
              from the repo root with the same env vars the agent uses.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
            accent={palette.accent}
          />
        </div>
      )}

      <details
        open
        className="bg-card border border-border rounded-lg px-5 py-4"
      >
        <summary className="cursor-pointer text-sm font-medium select-none">
          Methodology
        </summary>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Each PR diff was sent through both models using the same system
          prompt (
          <code className="font-mono text-[12px]">prompt.md</code>
          ). Outputs were compared on verdict, severity, and bug list. Bug
          overlap is computed via a simple 70% token Jaccard on file + issue
          text — a heuristic, not perfect. Sample size is small (&lt;10 in
          v1); this is directional evidence, not statistically significant. A
          larger benchmark would need a hand-graded ground truth, which I
          haven&apos;t built yet.
        </p>
      </details>

      {rows.length > 0 && (
        <div>
          <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-2 px-1">
            Per-PR comparison · {rows.length} row{rows.length === 1 ? "" : "s"}
          </div>
          <div className="bg-card border border-border rounded-lg divide-y divide-border overflow-hidden">
            <div className="hidden md:grid grid-cols-12 gap-3 px-5 py-3 text-[11px] font-mono uppercase tracking-wider text-muted bg-bg border-b border-border">
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
    </div>
  );
}
