import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
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

// Status dot colors for the rules pill. Tooltip text appears on hover
// so the legend is inline rather than a separate affordance.
const DOT: Record<RepoRulesStatus, { color: string; title: string }> = {
  none: {
    color: "#8a8a8a",
    title: "No rules configured for this repo",
  },
  enabled: {
    color: "#4ade80",
    title: "Rules configured · agent enabled",
  },
  disabled: {
    color: "#ff5252",
    title: "Rules configured · agent PAUSED for this repo",
  },
};

export default async function ReposPage() {
  const repos = await getRepoStats();

  return (
    <Container className="py-10 space-y-6">
      <SectionHeading
        eyebrow="Repos"
        title="All watched repositories"
        subtitle="One row per watched repo · totals are all-time · cost window is 30d."
      />

      {repos.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">
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
                <tr key={r.repo} className="hover:bg-bg-elev transition-colors">
                  <Td className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        title={dot.title}
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: dot.color }}
                      />
                      <Link
                        href={`/?repo=${encodeURIComponent(r.repo)}`}
                        className="text-text hover:underline underline-offset-4"
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
                  <Td className="text-right font-mono text-xs">
                    {r.total_reviews}
                  </Td>
                  <Td
                    className="text-right font-mono text-xs"
                    style={
                      r.total_closed > 0
                        ? { color: severityColors.critical }
                        : undefined
                    }
                  >
                    {r.total_closed}
                  </Td>
                  <Td
                    className="text-right font-mono text-xs"
                    style={
                      r.avg_severity
                        ? { color: severityColor(r.avg_severity) }
                        : undefined
                    }
                  >
                    {r.avg_severity ? r.avg_severity.toFixed(1) : "—"}
                  </Td>
                  <Td className="text-right font-mono text-xs">
                    {formatCost(r.estimated_cost_usd)}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs text-muted">
                    {r.last_reviewed_at
                      ? formatRelativeTime(r.last_reviewed_at)
                      : "—"}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-mono text-xs">
                    <Link
                      href={`/repos/${r.repo}/settings`}
                      className="text-text hover:underline underline-offset-4"
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
    </Container>
  );
}
