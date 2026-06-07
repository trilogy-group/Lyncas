import Link from "next/link";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, Th, Td } from "./ui/table";
import { formatRelativeTime, severityColor, severityColors } from "@/lib/design";
import type { Review, Verdict } from "@/lib/types";

interface ReviewsTableProps {
  reviews: Review[];
  currentSort: "severity_score" | "created_at";
  currentDir: "asc" | "desc";
  baseSearchParams: URLSearchParams;
  flush?: boolean;
}

// Short, uppercase verdict labels matching the analytics mockup pills.
const VERDICT_LABEL: Record<Verdict, string> = {
  approve: "approve",
  request_changes: "changes",
  comment: "comment",
};
const VERDICT_COLOR: Record<Verdict, string> = {
  approve: severityColors.clean,
  request_changes: severityColors.critical,
  comment: "#6cb6ff",
};

function sortLink(
  field: "severity_score" | "created_at",
  currentSort: string,
  currentDir: "asc" | "desc",
  baseSearchParams: URLSearchParams,
): string {
  const sp = new URLSearchParams(baseSearchParams);
  const sameField = currentSort === field;
  const nextDir = sameField && currentDir === "desc" ? "asc" : "desc";
  sp.set("sortBy", field);
  sp.set("sortDir", nextDir);
  sp.delete("page");
  return `?${sp.toString()}`;
}

function arrow(active: boolean, dir: "asc" | "desc"): string {
  if (!active) return "";
  return dir === "desc" ? " ↓" : " ↑";
}

export function ReviewsTable({
  reviews,
  currentSort,
  currentDir,
  baseSearchParams,
  flush = false,
}: ReviewsTableProps) {
  if (reviews.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted">
        No reviews match the current filters.
      </div>
    );
  }
  return (
    <Table flush={flush}>
      <TableHeader>
        <tr>
          <Th>Repo</Th>
          <Th>PR</Th>
          <Th>Verdict</Th>
          <Th className="text-center">
            <Link
              href={sortLink(
                "severity_score",
                currentSort,
                currentDir,
                baseSearchParams,
              )}
              className="hover:text-text"
            >
              Sev{arrow(currentSort === "severity_score", currentDir)}
            </Link>
          </Th>
          <Th>Action</Th>
          <Th className="text-right">
            <Link
              href={sortLink(
                "created_at",
                currentSort,
                currentDir,
                baseSearchParams,
              )}
              className="hover:text-text"
            >
              When{arrow(currentSort === "created_at", currentDir)}
            </Link>
          </Th>
        </tr>
      </TableHeader>
      <TableBody>
        {reviews.map((r) => {
          const sevColor = severityColor(r.severity_score);
          const closed = r.action === "closed";
          return (
            <tr
              key={r.id}
              className={
                "transition-colors hover:bg-bg-elev " +
                (closed ? "bg-closed-bg" : "")
              }
            >
              <Td className="whitespace-nowrap font-mono text-xs text-muted-strong">
                {r.repo}
              </Td>
              <Td className="max-w-md">
                <div className="flex items-center gap-2">
                  <a
                    href={r.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 font-mono text-xs text-muted hover:text-text"
                  >
                    #{r.pr_number}
                  </a>
                  <Link
                    href={`/pr/${r.id}`}
                    className="line-clamp-1 text-[13px] text-text hover:underline underline-offset-4"
                  >
                    {r.pr_title}
                  </Link>
                </div>
              </Td>
              <Td>
                <Badge color={VERDICT_COLOR[r.verdict]} variant="subtle">
                  {VERDICT_LABEL[r.verdict] ?? r.verdict}
                </Badge>
              </Td>
              <Td className="text-center">
                <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: sevColor }}
                    aria-hidden
                  />
                  <span style={{ color: sevColor }}>{r.severity_score}</span>
                </span>
              </Td>
              <Td>
                {closed ? (
                  <Badge color={severityColors.critical} variant="outline">
                    auto-closed
                  </Badge>
                ) : (
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
                    commented
                  </span>
                )}
              </Td>
              <Td className="whitespace-nowrap text-right font-mono text-xs text-muted">
                {formatRelativeTime(r.created_at)}
              </Td>
            </tr>
          );
        })}
      </TableBody>
    </Table>
  );
}
