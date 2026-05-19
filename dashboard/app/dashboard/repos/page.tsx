import Link from "next/link";
import { redirect } from "next/navigation";
import { LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { Table, TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import { formatRelativeTime } from "@/lib/design";
import { getUserProfile, getWatchedRepos } from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";

// User-scoped repo list. Shows only watched_repos owned by the logged-
// in user (RLS enforced in queries.ts → getWatchedRepos). The legacy
// /repos page stays public and continues to show every repo with
// reviews — that's the v1 demo route.

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
    <Container className="py-10 space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading
          eyebrow="Repositories"
          title="Your repositories"
          subtitle={
            <>
              {watched.length} of {repoLimit >= 9999 ? "unlimited" : repoLimit}{" "}
              watched
              {profile?.plan ? ` · ${profile.plan} plan` : ""}
            </>
          }
        />
        {atLimit ? (
          <LinkButton href="/dashboard/connect-repo" variant="default" size="md">
            Limit reached
          </LinkButton>
        ) : (
          <LinkButton href="/dashboard/connect-repo" variant="primary" size="md">
            + Connect repo
          </LinkButton>
        )}
      </section>

      {watched.length === 0 ? (
        <Card className="p-12 text-center space-y-4">
          <p className="text-sm text-muted">
            No repositories connected yet.
          </p>
          <div className="flex justify-center">
            <LinkButton href="/dashboard/connect-repo" variant="primary">
              Connect your first repo
            </LinkButton>
          </div>
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
              <tr key={r.id} className="hover:bg-bg-elev transition-colors">
                <Td className="font-mono text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-full"
                      style={{
                        backgroundColor: r.enabled ? "#4ade80" : "#ff5252",
                      }}
                    />
                    <Link
                      href={`/dashboard/overview?repo=${encodeURIComponent(r.repo)}`}
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
                    >
                      ↗
                    </a>
                  </div>
                </Td>
                <Td className="font-mono text-xs uppercase tracking-[0.14em]">
                  {r.enabled ? (
                    <span style={{ color: "#4ade80" }}>active</span>
                  ) : (
                    <span style={{ color: "#ff5252" }}>paused</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs text-muted">
                  {formatRelativeTime(r.created_at)}
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
            ))}
          </TableBody>
        </Table>
      )}
    </Container>
  );
}
