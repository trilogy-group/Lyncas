import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import {
  formatCost,
  formatRelativeTime,
  severityColor,
  severityColors,
} from "@/lib/design";
import { getRepoStats } from "@/lib/queries";
import type { RepoRulesStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

// Status dot colors — mirror the palette in lib/design.ts (no new design
// tokens). Tooltip-style title text appears on hover so the legend is
// inline rather than requiring a separate UI affordance.
const DOT: Record<RepoRulesStatus, { color: string; title: string }> = {
  none: {
    color: "#a8a29e", // muted/stone-400, indicates "no rules yet"
    title: "No rules configured for this repo",
  },
  enabled: {
    color: "#16a34a", // severityColors.clean
    title: "Rules configured · agent enabled",
  },
  disabled: {
    color: "#dc2626", // severityColors.critical
    title: "Rules configured · agent PAUSED for this repo",
  },
};

export default async function ReposPage() {
  const repos = await getRepoStats();

  return (
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <section>
        <h1 className="text-xl font-semibold mb-1">Repos</h1>
        <p className="text-sm text-muted italic font-serif">
          one row per watched repo · totals are all-time · cost window is 30d
        </p>
      </section>

      {repos.length === 0 ? (
        <Card className="p-8 text-center text-muted text-sm">
          No reviews recorded yet. Once the agent reviews a PR, that repo
          will appear here.
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <Th>Repo</Th>
              <Th className="text-right">Reviews</Th>
              <Th className="text-right">Closed</Th>
              <Th className="text-right">Avg severity</Th>
              <Th className="text-right">Cost (30d)</Th>
              <Th>Last reviewed</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </TableHeader>
          <TableBody>
            {repos.map((r) => {
              const dot = DOT[r.rules_status];
              return (
                <tr key={r.repo}>
                  <Td className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        title={dot.title}
                        className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: dot.color }}
                      />
                      <Link
                        href={`/?repo=${encodeURIComponent(r.repo)}`}
                        className="text-accent hover:underline"
                      >
                        {r.repo}
                      </Link>
                      <a
                        href={`https://github.com/${r.repo}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open on GitHub"
                        className="text-muted hover:text-text"
                        aria-label={`Open ${r.repo} on GitHub`}
                      >
                        ↗
                      </a>
                    </div>
                  </Td>
                  <Td className="font-mono text-xs text-right">
                    {r.total_reviews}
                  </Td>
                  <Td
                    className="font-mono text-xs text-right"
                    style={
                      r.total_closed > 0
                        ? { color: severityColors.critical }
                        : undefined
                    }
                  >
                    {r.total_closed}
                  </Td>
                  <Td
                    className="font-mono text-xs text-right"
                    style={
                      r.avg_severity
                        ? { color: severityColor(r.avg_severity) }
                        : undefined
                    }
                  >
                    {r.avg_severity ? r.avg_severity.toFixed(1) : "—"}
                  </Td>
                  <Td className="font-mono text-xs text-right">
                    {formatCost(r.estimated_cost_usd)}
                  </Td>
                  <Td className="font-mono text-xs text-muted whitespace-nowrap">
                    {r.last_reviewed_at
                      ? formatRelativeTime(r.last_reviewed_at)
                      : "—"}
                  </Td>
                  <Td className="font-mono text-xs text-right whitespace-nowrap">
                    <Link
                      href={`/repos/${r.repo}/settings`}
                      className="text-accent hover:underline"
                      title={`Configure ${r.repo}`}
                    >
                      ⚙ Configure
                    </Link>
                  </Td>
                </tr>
              );
            })}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
