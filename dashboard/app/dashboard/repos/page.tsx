import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import { formatRelativeTime } from "@/lib/design";
import { getUserProfile, getWatchedRepos } from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";

// User-scoped repo list. Only shows watched_repos owned by the logged-
// in user (RLS already enforces this in queries.ts → getWatchedRepos).
// The legacy /repos page stays public and continues to show every
// repo with reviews — that's the v1 demo route.
//
// Connect-repo CTA in the header is the one-and-only way to add a
// repo; gated on the free-plan repo_limit. When the user is at limit
// we render the CTA as a disabled-looking pill that links to a future
// upgrade page (for now /dashboard/connect-repo will itself render
// the upgrade banner — see that page).

export const dynamic = "force-dynamic";

export default async function DashboardReposPage() {
  const user = await getUser().catch(() => null);
  if (!user) redirect("/login");

  const [profile, watched] = await Promise.all([
    getUserProfile(user.id),
    getWatchedRepos(user.id),
  ]);
  const repoLimit = profile?.repo_limit ?? 2;
  const atLimit = watched.length >= repoLimit;

  return (
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <section className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold mb-1">Your repositories</h1>
          <p className="text-sm text-muted">
            {watched.length} of{" "}
            {repoLimit >= 9999 ? "unlimited" : repoLimit} watched
            {profile?.plan ? ` · ${profile.plan} plan` : ""}
          </p>
        </div>
        <Link
          href="/dashboard/connect-repo"
          className="px-4 py-2 rounded-md text-sm font-medium text-white"
          style={{
            backgroundColor: atLimit ? "#a1a1aa" : "#4338ca",
            pointerEvents: atLimit ? "none" : undefined,
          }}
          aria-disabled={atLimit}
          tabIndex={atLimit ? -1 : undefined}
        >
          {atLimit ? "Limit reached" : "+ Connect repo"}
        </Link>
      </section>

      {watched.length === 0 ? (
        <Card className="p-10 text-center space-y-3">
          <p className="text-sm text-muted">
            No repositories connected yet.
          </p>
          <Link
            href="/dashboard/connect-repo"
            className="inline-block px-4 py-2 rounded-md text-sm font-medium text-white"
            style={{ backgroundColor: "#4338ca" }}
          >
            Connect your first repo
          </Link>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <Th>Repo</Th>
              <Th>Status</Th>
              <Th>Connected</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </TableHeader>
          <TableBody>
            {watched.map((r) => (
              <tr key={r.id}>
                <Td className="font-mono text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block w-2 h-2 rounded-full"
                      style={{
                        backgroundColor: r.enabled ? "#16a34a" : "#dc2626",
                      }}
                    />
                    <Link
                      href={`/dashboard/overview?repo=${encodeURIComponent(r.repo)}`}
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
                    >
                      ↗
                    </a>
                  </div>
                </Td>
                <Td className="text-xs">
                  {r.enabled ? (
                    <span style={{ color: "#16a34a" }}>active</span>
                  ) : (
                    <span style={{ color: "#dc2626" }}>paused</span>
                  )}
                </Td>
                <Td className="font-mono text-xs text-muted whitespace-nowrap">
                  {formatRelativeTime(r.created_at)}
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
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
