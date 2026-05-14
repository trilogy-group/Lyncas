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

export const dynamic = "force-dynamic";

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
            {repos.map((r) => (
              <tr key={r.repo}>
                <Td className="font-mono text-xs">
                  <a
                    href={`https://github.com/${r.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:underline"
                  >
                    {r.repo}
                  </a>
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
                <Td className="font-mono text-xs text-right">
                  <Link
                    href={`/?repo=${encodeURIComponent(r.repo)}`}
                    className="text-accent hover:underline whitespace-nowrap"
                  >
                    view reviews →
                  </Link>
                </Td>
              </tr>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
