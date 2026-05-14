import Link from "next/link";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, Th, Td } from "./ui/table";
import {
  formatRelativeTime,
  palette,
  severityColor,
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
      <div className="bg-card border border-border rounded-lg p-8 text-center text-muted text-sm">
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
            <tr key={r.id} className={closed ? "bg-closed-bg" : undefined}>
              <Td className="font-mono text-xs whitespace-nowrap">{r.repo}</Td>
              <Td className="font-mono text-xs">
                <a
                  href={r.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  #{r.pr_number}
                </a>
              </Td>
              <Td className="max-w-md">
                <Link
                  href={`/pr/${r.id}`}
                  className="hover:underline line-clamp-1"
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
                  <Badge color={palette.text}>closed</Badge>
                ) : (
                  <span className="text-muted">commented</span>
                )}
              </Td>
              <Td className="font-mono text-xs text-muted whitespace-nowrap">
                {formatRelativeTime(r.created_at)}
              </Td>
            </tr>
          );
        })}
      </TableBody>
    </Table>
  );
}
