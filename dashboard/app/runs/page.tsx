import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { Table, TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import { formatDuration, formatRelativeTime } from "@/lib/design";
import { getRuns } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await getRuns(50);
  return (
    <Container className="py-10 space-y-6">
      <SectionHeading
        eyebrow="Runs"
        title="Agent runs"
        subtitle="Last 50 invocations of the cron-driven reviewer."
      />

      {runs.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">
          No runs recorded yet.
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <Th>Started</Th>
              <Th>Duration</Th>
              <Th>Repos scanned</Th>
              <Th>Reviews</Th>
              <Th>Skipped</Th>
              <Th>Errors</Th>
              <Th>Trigger</Th>
            </tr>
          </TableHeader>
          <TableBody>
            {runs.map((r) => {
              const errCount = r.errors?.length ?? 0;
              const hasErr = errCount > 0;
              return (
                <tr key={r.id} className="hover:bg-bg-elev transition-colors">
                  <Td
                    className="whitespace-nowrap font-mono text-xs"
                    style={
                      hasErr
                        ? { borderLeft: "3px solid #ff5252" }
                        : undefined
                    }
                  >
                    {formatRelativeTime(r.started_at)}
                  </Td>
                  <Td className="font-mono text-xs">
                    {formatDuration(r.started_at, r.finished_at)}
                  </Td>
                  <Td className="font-mono text-xs text-muted">
                    {(r.repos_scanned ?? []).join(", ") || "—"}
                  </Td>
                  <Td className="font-mono text-xs">{r.reviews_created}</Td>
                  <Td className="font-mono text-xs text-muted">{r.skipped}</Td>
                  <Td
                    className="font-mono text-xs"
                    style={{
                      color: hasErr ? "#ff5252" : "#8a8a8a",
                      fontWeight: hasErr ? 600 : 400,
                    }}
                  >
                    {errCount}
                  </Td>
                  <Td className="font-mono text-xs text-muted">
                    {r.trigger_source ?? "—"}
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
