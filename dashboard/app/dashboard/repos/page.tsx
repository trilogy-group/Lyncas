import { redirect } from "next/navigation";
import { ExternalLinkButton } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { GridBackdrop } from "@/components/ui/grid-backdrop";
import { SectionHeading } from "@/components/ui/section-heading";
import { getRepoStats, getWatchedRepos } from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";
import { ReposTable, type RepoRow } from "./repos-table";

// User-scoped repo list. Shows only watched_repos owned by the logged-
// in user (RLS enforced in queries.ts → getWatchedRepos). The legacy
// /repos page stays public and continues to show every repo with
// reviews — that's the v1 demo route.
//
// As of the App-only flow: there is NO repo limit and NO connect-repo
// page. Adding a repo means installing (or re-configuring) the GitHub
// App, which is a single button that bounces through GitHub.
//
// The per-row review counts come from getRepoStats (aggregated from the
// reviews table). It's a global aggregate, so we look each repo up by
// name and tolerate misses — a freshly-connected repo with no reviews
// yet simply shows zeros.

export const dynamic = "force-dynamic";

function appInstallUrl(): string | null {
  const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  if (!slug) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}

export default async function DashboardReposPage() {
  const user = await getUser().catch(() => null);
  if (!user) redirect("/login");

  const [watched, stats] = await Promise.all([
    getWatchedRepos(user.id),
    // getRepoStats reads the public reviews table; if it throws (e.g. a
    // fresh DB), fall back to no stats rather than failing the page.
    getRepoStats().catch(() => []),
  ]);
  const installUrl = appInstallUrl();

  const statsByRepo = new Map(stats.map((s) => [s.repo, s]));
  const rows: RepoRow[] = watched.map((r) => {
    const s = statsByRepo.get(r.repo);
    return {
      id: r.id,
      repo: r.repo,
      enabled: r.enabled,
      created_at: r.created_at,
      total_reviews: s?.total_reviews ?? 0,
      total_closed: s?.total_closed ?? 0,
      last_reviewed_at: s?.last_reviewed_at ?? null,
    };
  });

  return (
    <div className="relative">
      <GridBackdrop tone="fuchsia" />
      <Container className="relative py-10 space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading
          eyebrow="REPOSITORIES"
          title="REPOSITORIES"
          subtitle="Repositories the Lyncas GitHub App can review. Configure behavior per repo."
        />
        {installUrl ? (
          <ExternalLinkButton href={installUrl} variant="primary" size="md">
            + Add repos via GitHub
          </ExternalLinkButton>
        ) : null}
      </section>

      <ReposTable rows={rows} installUrl={installUrl} />
      </Container>
    </div>
  );
}
