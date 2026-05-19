import Link from "next/link";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, Th, Td } from "./ui/table";
import {
  formatRelativeTime,
  severityColor,
  severityColors,
  verdictBadge,
} from "@/lib/design";
import type { Review } from "@/lib/types";

interface ReviewsTableProps {
  reviews: Review[];
  currentSort: "severity_score" | "created_at";
  currentDir: "asc" | "desc";
  baseSearchParams: URLSearchParams;
}

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
}: ReviewsTableProps) {
  if (reviews.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted">
        No reviews match the current filters.
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <tr>
          <Th>Repo</Th>
          <Th>PR</Th>
          <Th>Title</Th>
          <Th>Verdict</Th>
          <Th>
            <Link
              href={sortLink(
                "severity_score",
                currentSort,
                currentDir,
                baseSearchParams,
              )}
              className="hover:text-text"
            >
              Severity{arrow(currentSort === "severity_score", currentDir)}
            </Link>
          </Th>
          <Th>Conf</Th>
          <Th>Action</Th>
          <Th>
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
          const v = verdictBadge(r.verdict);
          const sevColor = severityColor(r.severity_score);
          const closed = r.action === "closed";
          return (
            <tr
              key={r.id}
              className={
                "hover:bg-bg-elev transition-colors " +
                (closed ? "bg-closed-bg" : "")
              }
            >
              <Td className="whitespace-nowrap font-mono text-xs">{r.repo}</Td>
              <Td className="font-mono text-xs">
                <a
                  href={r.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-text hover:underline underline-offset-4"
                >
                  #{r.pr_number}
                </a>
              </Td>
              <Td className="max-w-md">
                <Link
                  href={`/pr/${r.id}`}
                  className="line-clamp-1 hover:underline underline-offset-4"
                >
                  {r.pr_title}
                </Link>
              </Td>
              <Td>
                <Badge color={v.color}>{v.label}</Badge>
              </Td>
              <Td>
                <Badge color={sevColor}>{r.severity_score}/10</Badge>
              </Td>
              <Td className="font-mono text-xs text-muted">{r.confidence}</Td>
              <Td className="font-mono text-xs">
                {closed ? (
                  <Badge color={severityColors.critical}>closed</Badge>
                ) : (
                  <span className="text-muted">commented</span>
                )}
              </Td>
              <Td className="whitespace-nowrap font-mono text-xs text-muted">
                {formatRelativeTime(r.created_at)}
              </Td>
            </tr>
          );
        })}
      </TableBody>
    </Table>
  );
}
