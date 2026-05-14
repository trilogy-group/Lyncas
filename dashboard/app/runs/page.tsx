import { Card } from "@/components/ui/card";
import { Table, TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import { formatDuration, formatRelativeTime, palette } from "@/lib/design";
import { getRuns } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await getRuns(50);
  return (
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <section>
        <h1 className="text-xl font-semibold mb-1">Agent runs</h1>
        <p className="text-sm text-muted italic font-serif">
          last 50 invocations
        </p>
      </section>

      {runs.length === 0 ? (
        <Card className="p-8 text-center text-muted text-sm">
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
                <tr key={r.id}>
                  <Td
                    className="font-mono text-xs whitespace-nowrap"
                    style={
                      hasErr
                        ? { borderLeft: "4px solid #dc2626" }
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
                  <Td className="font-mono text-xs text-muted">
                    {r.skipped}
                  </Td>
                  <Td
                    className="font-mono text-xs"
                    style={{
                      color: hasErr ? palette.text : palette.muted,
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
    </main>
  );
}
