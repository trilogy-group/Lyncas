"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { ExternalLinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import { formatRelativeTime } from "@/lib/design";

// Client-side wrapper around the watched-repo table. The page fetches
// the rows server-side and hands them in; everything interactive (the
// filter box and the DATA / EMPTY preview toggle) lives here so the
// page itself can stay a server component.

export interface RepoRow {
  id: string;
  repo: string;
  enabled: boolean;
  created_at: string;
  total_reviews: number;
  total_closed: number;
  last_reviewed_at: string | null;
}

type View = "data" | "empty";

export function ReposTable({
  rows,
  installUrl,
}: {
  rows: RepoRow[];
  installUrl: string | null;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("data");

  const activeCount = useMemo(
    () => rows.filter((r) => r.enabled).length,
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.repo.toLowerCase().includes(q));
  }, [rows, query]);

  const showEmpty = view === "empty" || rows.length === 0;

  return (
    <Card flush className="overflow-hidden">
      {/* Panel header — title on the left, count summary on the right. */}
      <div className="flex items-center justify-between gap-4 border-b border-border bg-bg-elev px-4 py-3">
        <div className="flex items-center gap-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-white">
          <span aria-hidden className="text-muted">
            ☰ ✕
          </span>
          Connected
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
          {rows.length} {rows.length === 1 ? "repo" : "repos"}
          <span className="mx-1.5 text-border-strong">·</span>
          {activeCount} active
        </div>
      </div>

      {showEmpty ? (
        <div className="space-y-5 px-6 py-16 text-center">
          <p className="mx-auto max-w-md text-sm text-muted-strong">
            {rows.length === 0
              ? "No repositories connected yet. Install the GitHub App and pick the repos you want reviewed — GitHub will bring you back here."
              : "Showing the empty state. Switch back to DATA to see your connected repositories."}
          </p>
          {installUrl && (
            <div className="flex justify-center">
              <ExternalLinkButton href={installUrl} variant="primary">
                Install Lyncas →
              </ExternalLinkButton>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Filter box. */}
          <div className="border-b border-border px-4 py-3">
            <div className="relative max-w-sm">
              <span
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
              >
                ⌕
              </span>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter repositories…"
                className="h-10 w-full rounded-md border border-border bg-bg-elev pl-9 pr-3 font-mono text-xs text-white placeholder:text-muted focus:border-border-strong focus:outline-none"
              />
            </div>
          </div>

          <Table>
            <TableHeader>
              <tr>
                <Th>Repository</Th>
                <Th>Status</Th>
                <Th className="text-right">Reviews</Th>
                <Th className="text-right">Closed</Th>
                <Th>Last activity</Th>
                <Th className="text-right">Configure</Th>
              </tr>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center font-mono text-xs text-muted"
                  >
                    No repositories match “{query}”.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => <RepoTr key={r.id} r={r} />)
              )}
            </TableBody>
          </Table>
        </>
      )}

      {/* View toggle lives in the footer so the header stays clean. */}
      <div className="flex items-center justify-end gap-1 border-t border-border bg-bg-elev px-4 py-2">
        <ViewTab active={view === "data"} onClick={() => setView("data")}>
          Data
        </ViewTab>
        <ViewTab active={view === "empty"} onClick={() => setView("empty")}>
          Empty
        </ViewTab>
      </div>
    </Card>
  );
}

function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "h-7 rounded px-3 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors",
        active
          ? "bg-white text-black"
          : "text-muted hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

function RepoTr({ r }: { r: RepoRow }) {
  return (
    <tr className="transition-colors hover:bg-bg-elev">
      <Td className="font-mono text-xs">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: r.enabled ? "#58e684" : "#ff5a5a" }}
          />
          <Link
            href={`/dashboard/overview?repo=${encodeURIComponent(r.repo)}`}
            className="text-white underline-offset-4 hover:underline"
          >
            {r.repo}
          </Link>
          <a
            href={`https://github.com/${r.repo}`}
            target="_blank"
            rel="noreferrer"
            title="Open on GitHub"
            className="text-muted hover:text-white"
          >
            ↗
          </a>
        </div>
      </Td>
      <Td>
        <StatusPill enabled={r.enabled} />
      </Td>
      <Td className="text-right font-mono text-xs text-muted-strong">
        {r.total_reviews}
      </Td>
      <Td className="text-right font-mono text-xs text-muted-strong">
        {r.total_closed}
      </Td>
      <Td className="whitespace-nowrap font-mono text-xs text-muted">
        {r.last_reviewed_at
          ? formatRelativeTime(r.last_reviewed_at)
          : "—"}
      </Td>
      <Td className="whitespace-nowrap text-right font-mono text-xs">
        <Link
          href={`/repos/${r.repo}/settings`}
          className="text-white underline-offset-4 hover:underline"
          title={`Configure ${r.repo}`}
        >
          ⚙ Configure
        </Link>
      </Td>
    </tr>
  );
}

function StatusPill({ enabled }: { enabled: boolean }) {
  const color = enabled ? "#58e684" : "#9aa0a6";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]"
      style={{ color, borderColor: `${color}55` }}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {enabled ? "active" : "paused"}
    </span>
  );
}
