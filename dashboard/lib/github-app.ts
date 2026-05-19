// dashboard/lib/github-app.ts
//
// Server-only helpers for talking to GitHub as the Night PR Reviewer
// GitHub App. Two flavors of credential live in this module:
//
//   1. App JWT — short-lived (10 min) RS256 token signed with the App's
//      private key. Used to call:
//        GET  /app/installations/{id}
//        GET  /app/installations/{id}/repositories
//        POST /app/installations/{id}/access_tokens
//      Nothing else uses it; in particular the App JWT does NOT have
//      access to a repo's contents — it just identifies "this is the
//      App, asking for an installation-scoped token".
//
//   2. Installation token — short-lived (~1h) opaque string returned by
//      POST /app/installations/{id}/access_tokens. THIS is the
//      credential the agent uses to read diffs, post comments, and
//      close PRs. We mint a fresh one on demand rather than caching;
//      Phase 9 of PROJECT_PLAN.md sketches an optional per-installation
//      token cache once we're paying for the round-trip latency.
//
// IMPORTANT: This module is `import "server-only"` so it can never be
// pulled into a client bundle. The private key would leak otherwise.

import "server-only";

import jwt from "jsonwebtoken";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

interface AppConfig {
  appId: string;
  privateKey: string;
}

// Centralized config read so a missing env throws once with a clear
// message rather than landing as a cryptic jwt.sign error inside
// node-jsonwebtoken. The Vercel env panel strips newlines from
// multiline values, so private keys are stored with literal `\n`
// sequences and decoded at read time.
function appConfig(): AppConfig {
  const appId = process.env.GITHUB_APP_ID;
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId) throw new Error("GITHUB_APP_ID env var is not set");
  if (!rawKey) throw new Error("GITHUB_APP_PRIVATE_KEY env var is not set");
  return {
    appId,
    privateKey: rawKey.replace(/\\n/g, "\n"),
  };
}

/**
 * Sign a short-lived App JWT (10 minutes — GitHub's documented max).
 * `iat` is intentionally backdated 60s to cope with mild clock skew
 * between Vercel's serverless runtime and GitHub's API; without this,
 * a request that arrives "before" the iat fails 401 with no useful
 * error message.
 */
export function getAppJWT(): string {
  const { appId, privateKey } = appConfig();
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 600, iss: appId },
    privateKey,
    { algorithm: "RS256" },
  );
}

interface FetchOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}

/**
 * Authenticated fetch against the GitHub API using an App JWT.
 * Throws on non-2xx so callers can rely on a successful return.
 * Errors include the status + GitHub-supplied message so the
 * /auth/github-app/callback surface can render something useful.
 */
async function ghFetch<T>(
  path: string,
  token: string,
  opts: FetchOptions = {},
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    // GitHub recommends no caching for App auth flows; setting
    // `cache: 'no-store'` keeps Next from memoizing across requests.
    cache: "no-store",
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = (body as { message?: string }).message ?? "";
    } catch {
      // Non-JSON error body — fall through with empty detail.
    }
    throw new Error(
      `GitHub ${opts.method ?? "GET"} ${path} failed: ` +
        `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
    );
  }

  return (await res.json()) as T;
}

// --- Installation metadata -----------------------------------------------

export interface InstallationAccount {
  login: string;
  type: "User" | "Organization";
}

export interface Installation {
  id: number;
  account: InstallationAccount;
  // Other fields exist on the GitHub response; we narrow to what we
  // persist + display. Add fields here when you persist them.
}

export async function getInstallation(
  installationId: number | string,
): Promise<Installation> {
  return ghFetch<Installation>(
    `/app/installations/${installationId}`,
    getAppJWT(),
  );
}

export interface InstallationRepoListItem {
  full_name: string;
}

export interface InstallationRepoList {
  total_count: number;
  repositories: InstallationRepoListItem[];
}

/**
 * Lists repos the user picked during install. Paginated — GitHub
 * defaults to 30 per page and caps at 100. We follow the `next`
 * Link header so an org with hundreds of selected repos still
 * surfaces every one.
 */
export async function listInstallationRepos(
  installationId: number | string,
): Promise<string[]> {
  const token = getAppJWT();
  const collected: string[] = [];
  let page = 1;
  const perPage = 100;
  // Cap at 10 pages (1000 repos) as a runaway-loop guard — well
  // beyond anything a single user will plausibly install on.
  for (let i = 0; i < 10; i++) {
    const data = await ghFetch<InstallationRepoList>(
      `/app/installations/${installationId}/repositories?per_page=${perPage}&page=${page}`,
      token,
    );
    for (const r of data.repositories) {
      collected.push(r.full_name);
    }
    if (data.repositories.length < perPage) break;
    page += 1;
  }
  return collected;
}

// --- Installation access tokens ------------------------------------------

export interface InstallationAccessToken {
  token: string;
  // ISO-8601 — GitHub returns this exactly as we relay it to clients.
  expires_at: string;
}

/**
 * Mint a short-lived (≈1h) installation token. Used by:
 *   * the /api/github-app/installation-token POST endpoint (for the
 *     agent or any server-side consumer that needs to act on a repo)
 *   * potentially the agent itself, if it ever calls into the dashboard
 *     directly rather than holding a static PAT
 *
 * NB: the returned token is the credential the caller needs to keep
 * secret. Do NOT log it, do NOT return it from any browser-facing
 * route handler without first verifying the caller owns the
 * installation.
 */
export async function createInstallationToken(
  installationId: number | string,
): Promise<InstallationAccessToken> {
  return ghFetch<InstallationAccessToken>(
    `/app/installations/${installationId}/access_tokens`,
    getAppJWT(),
    { method: "POST" },
  );
}
