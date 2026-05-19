// dashboard/lib/github-token.ts
//
// Single source of truth for "what GitHub credential should this server
// route use to act on behalf of <user> on <repo>?". Both /api/chat and
// /api/repo-stats import from here so the resolution rules can't drift.
//
// Resolution order (fail-open, never throws):
//   1. The user's watched_repos row.
//      a. token_type='github_app' + non-null github_installation_id —
//         mint a fresh installation token via createInstallationToken.
//         An installation token is short-lived (~1h) and scoped only to
//         the repos the user picked when they installed the App.
//      b. token_type='pat' (or any other value) — return the row's
//         github_token if it has one.
//   2. The deploy-wide PR_REVIEWER_PAT env var (legacy / fallback).
//   3. null — caller falls back to public-read mode (works for public
//      repos, fails predictably for private ones).
//
// Why a helper instead of POSTing to /api/github-app/installation-token:
// that endpoint exists for *out-of-process* consumers (notably the
// Python agent in agent/). Calling it from another Next.js route in
// the same process would HTTP-serialise a function call to ourselves,
// require forwarding the user's session cookie, and add an extra
// cold-start hop with no security gain. The endpoint and this helper
// both delegate to createInstallationToken(); we use the helper.
//
// Security model:
//   * Always pass an explicit user_id when looking up watched_repos.
//     RLS already scopes SELECT to auth.uid()=user_id, but being
//     explicit is defense-in-depth and makes the intent obvious in
//     code review.
//   * Never log the resolved token. Log only categorical decisions
//     ("github_app for repo=...", "pat", "env-fallback") so an ops
//     reader can answer "did this request use the App or not?"
//     without having a credential in the log.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createInstallationToken } from "./github-app";

// Subset of the watched_repos row needed to resolve a token. Other
// columns (enabled, created_at, ...) are selected by routes that need
// them; this helper deliberately fetches only what it has to.
interface WatchedRepoCredential {
  github_token: string | null;
  github_installation_id: number | null;
  token_type: "pat" | "github_app" | null;
}

export type GithubTokenSource =
  | "github_app" // installation token, freshly minted
  | "pat" // per-user PAT from watched_repos.github_token
  | "env" // deploy-wide PR_REVIEWER_PAT
  | "none"; // no token; caller will hit public-read or fail

export interface ResolvedGithubToken {
  token: string | null;
  source: GithubTokenSource;
  // Surface the user-visible reason a route can pass back to its caller
  // when the resolution lands on `none` and a write op is attempted.
  // Empty string for the happy paths.
  detail: string;
}

interface ResolveOpts {
  supabase: SupabaseClient;
  // The authenticated dashboard user. Routes get this from
  // getUser() in lib/supabase/server.ts.
  userId: string;
  // owner/name. Caller is responsible for validating the shape.
  repo: string;
  // The deploy-wide fallback. Pass process.env.PR_REVIEWER_PAT here;
  // we accept it as a parameter so the helper stays pure (no
  // process.env reads inside, easier to unit-test).
  fallbackPat: string | undefined;
}

export async function resolveGithubToken(
  opts: ResolveOpts,
): Promise<ResolvedGithubToken> {
  const { supabase, userId, repo, fallbackPat } = opts;

  // Explicit user_id scoping. RLS would do this implicitly, but
  // (a) it's free defense-in-depth, (b) it's documenting, and
  // (c) it survives a future RLS bug that quietly widens reads.
  const { data, error } = await supabase
    .from("watched_repos")
    .select("github_token, github_installation_id, token_type")
    .eq("user_id", userId)
    .eq("repo", repo)
    .maybeSingle<WatchedRepoCredential>();

  if (error) {
    // A query error here is exotic (network blip, RLS misconfig).
    // Log it so the operator can see "the credential lookup itself
    // is failing", and degrade to env fallback rather than surfacing
    // a 500 from a chat message.
    console.warn(
      `[github-token] watched_repos lookup failed for repo=${repo}: ${error.message}`,
    );
  }

  // 1a. GitHub App installation — mint a fresh token.
  if (data?.token_type === "github_app" && data.github_installation_id) {
    try {
      const minted = await createInstallationToken(data.github_installation_id);
      return { token: minted.token, source: "github_app", detail: "" };
    } catch (e) {
      // Mint failure is a real operational signal: the App's private
      // key is wrong, the installation was revoked on github.com, or
      // GitHub is rate-limiting our app. Log loudly. Don't return
      // here — fall through to PAT / env so the request still has a
      // chance, but the operator gets a clear breadcrumb.
      console.warn(
        `[github-token] github_app mint failed for repo=${repo} ` +
          `installation=${data.github_installation_id}: ` +
          `${(e as Error).message}`,
      );
    }
  }

  // 1b. Per-user PAT from watched_repos.
  if (data?.github_token) {
    return { token: data.github_token, source: "pat", detail: "" };
  }

  // 2. Deploy-wide fallback.
  if (fallbackPat) {
    return { token: fallbackPat, source: "env", detail: "" };
  }

  // 3. Nothing.
  return {
    token: null,
    source: "none",
    detail:
      "No GitHub credential available: this user has no PAT or App " +
      "installation for this repo, and PR_REVIEWER_PAT is unset on " +
      "the deploy.",
  };
}
