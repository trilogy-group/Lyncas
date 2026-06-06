import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import { createInstallationToken } from "@/lib/github-app";

// GET /api/repo-tree?repo=owner/name
//
// Returns the *full* recursive tree of the repo's default branch as a
// flat list of { path, type } entries so the chat's Project structure
// panel can render a fully expandable file explorer (folders expand
// in place rather than bouncing the user to GitHub).
//
// We use the git "trees" API with recursive=1 — one request returns the
// entire tree (GitHub caps very large repos and sets `truncated`, which
// we forward). This replaces the old single-level /contents/ listing.
//
// Pricing: two cheap GETs per panel-open per repo (repo meta for the
// default branch, then the recursive tree) — both cached GitHub-side.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_API = "https://api.github.com";
// Bound the payload so a monorepo can't ship a 100k-entry array to the
// browser. GitHub itself truncates around ~100k/7MB; we cap far lower
// because the sidebar only needs a navigable structure.
const MAX_ENTRIES = 6000;

interface WriteTokenLookup {
  github_token: string | null;
  github_installation_id: number | null;
  token_type: "pat" | "github_app" | null;
}

async function resolveReadToken(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  repo: string,
  fallbackPat: string | undefined,
): Promise<string | null> {
  const { data } = await supabase
    .from("watched_repos")
    .select("github_token, github_installation_id, token_type")
    .eq("repo", repo)
    .maybeSingle<WriteTokenLookup>();
  if (data?.token_type === "github_app" && data.github_installation_id) {
    try {
      const t = await createInstallationToken(data.github_installation_id);
      return t.token;
    } catch {
      // fall through to PAT / deploy token
    }
  }
  if (data?.github_token) return data.github_token;
  return fallbackPat ?? null;
}

interface GhTreeEntry {
  path?: string;
  type?: "blob" | "tree" | "commit";
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

  // AuthZ — only connected repos. (Same gate as /api/repo-stats.)
  const supabase = await createSupabaseServerClient();
  const { data: ownership } = await supabase
    .from("watched_repos")
    .select("id")
    .eq("repo", repo)
    .maybeSingle();
  if (!ownership) {
    return NextResponse.json(
      { error: "Repository not connected" },
      { status: 403 },
    );
  }

  const token = await resolveReadToken(
    supabase,
    repo,
    process.env.PR_REVIEWER_PAT,
  );

  const ghHeaders = {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `token ${token}` } : {}),
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lyncas-tree",
  };

  // 1. Resolve the default branch. If this fails we fall back to the
  //    "HEAD" ref, which the trees API also accepts.
  let defaultBranch = "HEAD";
  try {
    const meta = await fetch(`${GITHUB_API}/repos/${repo}`, {
      headers: ghHeaders,
      cache: "no-store",
    });
    if (meta.ok) {
      const m = (await meta.json()) as { default_branch?: string };
      if (m.default_branch) defaultBranch = m.default_branch;
    }
  } catch {
    // keep HEAD
  }

  // 2. Recursive git tree of that branch — the entire repo structure in
  //    one shot. GitHub returns { tree: [{ path, type }], truncated }.
  let raw: GhTreeEntry[] = [];
  let truncated = false;
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      { headers: ghHeaders, cache: "no-store" },
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: `GitHub ${res.status}`, entries: [], defaultBranch },
        { status: res.status === 404 ? 404 : 200 },
      );
    }
    const body = (await res.json()) as {
      tree?: GhTreeEntry[];
      truncated?: boolean;
    };
    if (Array.isArray(body.tree)) raw = body.tree;
    truncated = !!body.truncated;
  } catch {
    return NextResponse.json({ entries: [], defaultBranch });
  }

  // Map to { path, dir } and bound the count. We sort by path so the
  // client can build the hierarchy deterministically; the client does
  // the dirs-first ordering per level.
  const entries = raw
    .filter((e) => (e.type === "blob" || e.type === "tree") && !!e.path)
    .map((e) => ({ path: e.path as string, dir: e.type === "tree" }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const capped = entries.length > MAX_ENTRIES;
  const out = capped ? entries.slice(0, MAX_ENTRIES) : entries;

  return NextResponse.json({
    repo,
    defaultBranch,
    truncated: truncated || capped,
    entries: out,
  });
}
