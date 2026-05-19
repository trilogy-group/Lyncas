import Link from "next/link";
import { redirect } from "next/navigation";
import { ExternalLinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { Table, TableBody, TableHeader, Td, Th } from "@/components/ui/table";
import { formatRelativeTime } from "@/lib/design";
import { getWatchedRepos } from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";

// User-scoped repo list. Shows only watched_repos owned by the logged-
// in user (RLS enforced in queries.ts → getWatchedRepos). The legacy
// /repos page stays public and continues to show every repo with
// reviews — that's the v1 demo route.
//
// As of the App-only flow: there is NO repo limit and NO connect-repo
// page. Adding a repo means installing (or re-configuring) the GitHub
// App, which is a single button that bounces through GitHub.

export const dynamic = "force-dynamic";

function appInstallUrl(): string | null {
  const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  if (!slug) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}

export default async function DashboardReposPage() {
  const user = await getUser().catch(() => null);
  if (!user) redirect("/login");

  const watched = await getWatchedRepos(user.id);
  const installUrl = appInstallUrl();

  return (
    <Container className="py-10 space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading
          eyebrow="Repositories"
          title="Your repositories"
          subtitle={
            <>
              <span className="text-white font-medium">{watched.length}</span>{" "}
              watched · managed via the Night PR Reviewer GitHub App.
            </>
          }
        />
        {installUrl ? (
          <ExternalLinkButton href={installUrl} variant="primary" size="md">
            + Add repos via GitHub
          </ExternalLinkButton>
        ) : null}
      </section>

      {watched.length === 0 ? (
        <Card className="p-12 text-center space-y-5" tone="elev">
          <p className="text-sm text-muted-strong">
            No repositories connected yet. Install the GitHub App and pick the
            repos you want reviewed — GitHub will bring you back here.
          </p>
          {installUrl && (
            <div className="flex justify-center">
              <ExternalLinkButton href={installUrl} variant="primary">
                Install Night PR Reviewer →
              </ExternalLinkButton>
            </div>
          )}
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
                        backgroundColor: r.enabled ? "#58e684" : "#ff5a5a",
                      }}
                    />
                    <Link
                      href={`/dashboard/overview?repo=${encodeURIComponent(r.repo)}`}
                      className="text-white hover:underline underline-offset-4"
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
                <Td className="font-mono text-xs uppercase tracking-[0.14em]">
                  {r.enabled ? (
                    <span style={{ color: "#58e684" }}>active</span>
                  ) : (
                    <span style={{ color: "#ff5a5a" }}>paused</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs text-muted">
                  {formatRelativeTime(r.created_at)}
                </Td>
                <Td className="whitespace-nowrap text-right font-mono text-xs">
                  <Link
                    href={`/repos/${r.repo}/settings`}
                    className="text-white hover:underline underline-offset-4"
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
