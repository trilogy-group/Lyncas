import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import { resolveGithubToken } from "@/lib/github-token";

// GET /api/repo-stats?repo=owner/name
//
// Server-side aggregator for the chat page's right-sidebar Repository
// panel. All GitHub calls happen here (never client-side) so the PAT /
// installation token never reaches the browser.
//
// Returns:
//   {
//     languages:   Record<string, number>,        // bytes per language
//     open_prs:    number,
//     stars:       number,
//     last_commit: string | null,                 // ISO-8601
//     contributors: Array<{ login, avatar_url, contributions }>,
//   }
//
// All five fetches are best-effort. A 404 / rate-limit on one section
// returns null/0 for that section and the others still render.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_API = "https://api.github.com";

async function gh<T>(path: string, token: string | null): Promise<{
  data: T | null;
  // Raw Link header — exposed so the caller can extract pagination
  // counts (e.g. "rel=last" gives us total open-PR count without
  // pulling every page).
  link: string | null;
}> {
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `token ${token}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "night-pr-reviewer-stats",
      },
      cache: "no-store",
    });
    if (!res.ok) return { data: null, link: null };
    const data = (await res.json()) as T;
    return { data, link: res.headers.get("link") };
  } catch {
    return { data: null, link: null };
  }
}

// Extract the page count from a Link header. GitHub paginates with
// per_page=1 + rel=last so we can read the count out of the URL.
// Returns 0 when the header is absent (single-page response).
function countFromLink(link: string | null, perPage: number, fetched: number): number {
  if (!link) return fetched;
  // Link looks like: `<...&page=12>; rel="last", <...>; rel="first"`
  const m = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  if (!m) return fetched;
  const lastPage = Number(m[1]);
  if (!Number.isFinite(lastPage) || lastPage <= 0) return fetched;
  // We know lastPage * perPage upper-bounds and (lastPage-1)*perPage+1
  // lower-bounds the count. Returning lastPage * perPage is good enough
  // for the UI's "open PRs" number — exact counts cost a search query.
  // When perPage=1 this is an exact count.
  return perPage === 1 ? lastPage : Math.max(fetched, lastPage * perPage);
}

interface GhRepo {
  stargazers_count?: number;
  pushed_at?: string;
}
interface GhContributor {
  login?: string;
  avatar_url?: string;
  contributions?: number;
}

export async function GET(request: NextRequest) {
  const user = await getUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const repo = request.nextUrl.searchParams.get("repo")?.trim() ?? "";
  if (!repo || !REPO_PATTERN.test(repo)) {
    return NextResponse.json(
      { error: "`repo` must look like owner/name" },
      { status: 400 },
    );
  }

  // AuthZ — must be a connected repo for this user. user_id-scoped so
  // a future RLS misconfig can't widen the read.
  const supabase = await createSupabaseServerClient();
  const { data: ownership } = await supabase
    .from("watched_repos")
    .select("id")
    .eq("user_id", user.id)
    .eq("repo", repo)
    .maybeSingle();
  if (!ownership) {
    return NextResponse.json(
      { error: "Repository not connected" },
      { status: 403 },
    );
  }

  // Resolve the GitHub credential. Same precedence as /api/chat:
  // per-user GitHub App installation token → per-user PAT →
  // deploy-wide PR_REVIEWER_PAT → null (public-read fallback).
  const resolved = await resolveGithubToken({
    supabase,
    userId: user.id,
    repo,
    fallbackPat: process.env.PR_REVIEWER_PAT,
  });
  const token = resolved.token;

  // Run all five fetches in parallel. Each tolerates a null result.
  const [repoMeta, languages, openPRsHead, contributors] = await Promise.all([
    gh<GhRepo>(`/repos/${repo}`, token),
    gh<Record<string, number>>(`/repos/${repo}/languages`, token),
    // per_page=1 forces GitHub to advertise total via rel=last on the
    // Link header — an exact count without paging the full PR list.
    gh<unknown[]>(`/repos/${repo}/pulls?state=open&per_page=1`, token),
    gh<GhContributor[]>(`/repos/${repo}/contributors?per_page=3`, token),
  ]);

  const stars = repoMeta.data?.stargazers_count ?? null;
  const last_commit = repoMeta.data?.pushed_at ?? null;
  const open_prs = openPRsHead.data
    ? countFromLink(
        openPRsHead.link,
        1,
        (openPRsHead.data as unknown[]).length,
      )
    : null;

  const contribs =
    (contributors.data ?? [])
      .filter((c): c is GhContributor => c !== null && typeof c === "object")
      .slice(0, 3)
      .map((c) => ({
        login: c.login ?? "?",
        avatar_url: c.avatar_url ?? null,
        contributions: c.contributions ?? 0,
      })) ?? [];

  return NextResponse.json({
    repo,
    languages: languages.data ?? {},
    open_prs,
    stars,
    last_commit,
    contributors: contribs,
  });
}
