import Link from "next/link";
import { redirect } from "next/navigation";
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
import { getRepoStats, getWatchedRepos } from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";
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
  // Auth boundary: the legacy /repos page used to render every row in
  // `reviews` regardless of who created it. On a shared deployment that
  // leaked review history across accounts, so the route is now
  // auth-gated and filtered to the caller's own watched_repos.
  const user = await getUser().catch(() => null);
  if (!user) {
    redirect("/login?next=%2Frepos");
  }

  const [allStats, watched] = await Promise.all([
    getRepoStats(),
    getWatchedRepos(user.id),
  ]);
  const owned = new Set(watched.map((w) => w.repo));
  const repos = allStats.filter((r) => owned.has(r.repo));

  return (
    <Container className="py-10 space-y-6">
      <SectionHeading
        eyebrow="Your repos"
        title="Repositories you've connected"
        subtitle={
          <>
            One row per repo you've connected via the GitHub App ·
            totals are all-time · cost window is{" "}
            <span className="text-white">30d</span>.
          </>
        }
      />

      {repos.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">
          {watched.length === 0 ? (
            <>
              No repos connected yet. Head to{" "}
              <Link
                href="/dashboard/repos"
                className="text-white hover:underline underline-offset-4"
              >
                Repos
              </Link>{" "}
              to install the GitHub App and pick which repositories the
              agent should watch.
            </>
          ) : (
            <>
              The agent hasn&apos;t reviewed a PR on your connected repos
              yet. Once it runs, that repo will appear here.
            </>
          )}
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
                      href={`/dashboard/repos/${r.repo}/settings`}
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
