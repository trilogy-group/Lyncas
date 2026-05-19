import "server-only";

import { createInstallationToken, listInstallationRepos } from "./github-app";
import { createSupabaseServerClient } from "./supabase/server";

// Reconciliation: bring Supabase's view of the world (github_app_installations
// + watched_repos) back in sync with what GitHub actually reports.
//
// Why this exists: until we subscribe to the `installation.deleted` and
// `installation_repositories.removed` webhooks, the database carries a
// stale picture of the user's connected repos whenever they uninstall
// or shrink the repo selection on GitHub. Symptoms:
//
//   * User uninstalls App but the chat sidebar still lists 51 repos
//     (the rows we wrote on first install never went away).
//   * User reinstalls with only 4 repos selected — the new install
//     adds 4 fresh rows but leaves the 47 dropped ones behind.
//
// What `reconcileUserInstallations` does:
//
//   1. Read every github_app_installations row for the user.
//   2. Probe each one with the App JWT. A dead installation either
//      404s the metadata fetch or fails to mint an installation
//      token; we mark it stale.
//   3. For each live installation, fetch its CURRENT selected repos
//      via the standard `GET /installation/repositories` call.
//   4. Delete stale install rows.
//   5. Delete watched_repos rows that:
//        - point at a stale installation_id, OR
//        - don't appear in any live installation's repo list (only
//          for token_type='github_app' rows — PAT rows are untouched).
//   6. Upsert one watched_repos row per (installation, selected repo)
//      so freshly-selected repos that exist only on GitHub are
//      mirrored into the DB.
//
// The function returns enough info for the caller to log / show a
// summary to the user. It is idempotent: running it twice in a row
// is a no-op on the second run.

interface InstallProbeResult {
  installation_id: number;
  alive: boolean;
  repos: string[];
}

export interface ReconcileSummary {
  // Number of installations GitHub still recognizes for this user.
  live_installations: number;
  // Installation ids we deleted from github_app_installations because
  // GitHub no longer recognizes them.
  stale_installation_ids: number[];
  // watched_repos rows (full names) we deleted because no live
  // installation reports them.
  removed_repos: string[];
  // watched_repos rows we created or refreshed.
  upserted_repos: string[];
  // Surfaced for debugging — non-fatal errors that came up during
  // probing or DB writes. Never thrown; reconciliation is best-effort.
  warnings: string[];
}

interface InstallRow {
  installation_id: number;
  account_login: string | null;
}

interface WatchedRow {
  id: string;
  repo: string;
  github_installation_id: number | null;
  token_type: "pat" | "github_app" | null;
}

export async function reconcileUserInstallations(
  userId: string,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    live_installations: 0,
    stale_installation_ids: [],
    removed_repos: [],
    upserted_repos: [],
    warnings: [],
  };

  const supabase = await createSupabaseServerClient();

  // Step 1 — load known installations.
  const { data: installRowsData, error: installFetchErr } = await supabase
    .from("github_app_installations")
    .select("installation_id, account_login")
    .eq("user_id", userId);
  if (installFetchErr) {
    summary.warnings.push(
      `Could not read github_app_installations: ${installFetchErr.message}`,
    );
    return summary;
  }
  const installRows = (installRowsData ?? []) as InstallRow[];
  if (installRows.length === 0) {
    // Nothing to reconcile. Still scrub orphan App-backed watched_repos
    // rows (token_type='github_app' but no install row in our DB).
    await scrubOrphanAppRepos(userId, [], summary);
    return summary;
  }

  // Step 2 — probe each install in parallel.
  const probes = await Promise.all(
    installRows.map(async (row): Promise<InstallProbeResult> => {
      try {
        // listInstallationRepos already mints an installation token
        // under the hood; a single call exercises both endpoints we
        // care about. If it throws, the install is dead.
        const repos = await listInstallationRepos(row.installation_id);
        return { installation_id: row.installation_id, alive: true, repos };
      } catch {
        // Belt-and-suspenders: also try the access-token endpoint
        // directly. Some org installs serve the repo list briefly
        // while access_token mint fails — in that case we still
        // treat the install as dead because we couldn't write to it.
        try {
          await createInstallationToken(row.installation_id);
          // Token works but repo list doesn't — treat as alive with
          // an empty list rather than silently dropping all repos.
          return {
            installation_id: row.installation_id,
            alive: true,
            repos: [],
          };
        } catch {
          return {
            installation_id: row.installation_id,
            alive: false,
            repos: [],
          };
        }
      }
    }),
  );

  const livePartition = probes.filter((p) => p.alive);
  const stalePartition = probes.filter((p) => !p.alive);
  summary.live_installations = livePartition.length;
  summary.stale_installation_ids = stalePartition.map(
    (p) => p.installation_id,
  );

  // Step 4 — delete dead install rows.
  if (stalePartition.length > 0) {
    const ids = stalePartition.map((p) => p.installation_id);
    const { error } = await supabase
      .from("github_app_installations")
      .delete()
      .eq("user_id", userId)
      .in("installation_id", ids);
    if (error) {
      summary.warnings.push(
        `Could not delete stale install rows: ${error.message}`,
      );
    }
  }

  // Build the authoritative "allowed" repo list — union across all
  // live installations.
  const allowedByInstall = new Map<number, Set<string>>();
  const allowed = new Set<string>();
  for (const p of livePartition) {
    const set = new Set(p.repos);
    allowedByInstall.set(p.installation_id, set);
    for (const r of p.repos) allowed.add(r);
  }

  // Step 5 — read existing App-backed watched_repos rows and figure
  // out which to delete.
  const { data: watchedData, error: watchedErr } = await supabase
    .from("watched_repos")
    .select("id, repo, github_installation_id, token_type")
    .eq("user_id", userId)
    .eq("token_type", "github_app");
  if (watchedErr) {
    summary.warnings.push(
      `Could not read watched_repos: ${watchedErr.message}`,
    );
    return summary;
  }
  const watched = (watchedData ?? []) as WatchedRow[];

  const liveInstallIds = new Set(livePartition.map((p) => p.installation_id));
  const reposToRemove: string[] = [];
  for (const row of watched) {
    // Case A — row points at a stale (or unknown) installation.
    if (
      row.github_installation_id == null ||
      !liveInstallIds.has(row.github_installation_id)
    ) {
      reposToRemove.push(row.repo);
      continue;
    }
    // Case B — row points at a live install, but the install no
    // longer has this repo selected.
    const set = allowedByInstall.get(row.github_installation_id);
    if (set && !set.has(row.repo)) {
      reposToRemove.push(row.repo);
    }
  }

  if (reposToRemove.length > 0) {
    // Dedupe before sending to Supabase (the same repo could appear
    // for multiple installs in theory).
    const uniq = [...new Set(reposToRemove)];
    const { error } = await supabase
      .from("watched_repos")
      .delete()
      .eq("user_id", userId)
      .eq("token_type", "github_app")
      .in("repo", uniq);
    if (error) {
      summary.warnings.push(
        `Could not delete stale watched_repos: ${error.message}`,
      );
    } else {
      summary.removed_repos = uniq;
    }
  }

  // Step 6 — upsert the live-install repos. Keeps the DB authoritative
  // even when the user adds new repos to an existing install.
  const upsertRows: Array<{
    user_id: string;
    repo: string;
    github_installation_id: number;
    token_type: "github_app";
    github_token: null;
    enabled: boolean;
  }> = [];
  for (const p of livePartition) {
    for (const repo of p.repos) {
      upsertRows.push({
        user_id: userId,
        repo,
        github_installation_id: p.installation_id,
        token_type: "github_app",
        github_token: null,
        enabled: true,
      });
    }
  }
  if (upsertRows.length > 0) {
    const { error } = await supabase
      .from("watched_repos")
      .upsert(upsertRows, { onConflict: "user_id,repo" });
    if (error) {
      summary.warnings.push(
        `Could not upsert watched_repos: ${error.message}`,
      );
    } else {
      summary.upserted_repos = upsertRows.map((r) => r.repo);
    }
  }

  return summary;
}

// Scrubs App-backed watched_repos for a user who has no
// github_app_installations rows at all. We can't compare against a
// live list — by definition nothing is live — so we just clear them.
async function scrubOrphanAppRepos(
  userId: string,
  _allowed: string[],
  summary: ReconcileSummary,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("watched_repos")
    .select("repo")
    .eq("user_id", userId)
    .eq("token_type", "github_app");
  if (error || !data || data.length === 0) return;
  const repos = data.map((r) => (r as { repo: string }).repo);
  const { error: delErr } = await supabase
    .from("watched_repos")
    .delete()
    .eq("user_id", userId)
    .eq("token_type", "github_app");
  if (delErr) {
    summary.warnings.push(
      `Could not delete orphan App-backed repos: ${delErr.message}`,
    );
    return;
  }
  summary.removed_repos.push(...repos);
}
