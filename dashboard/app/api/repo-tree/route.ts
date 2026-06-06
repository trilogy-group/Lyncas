import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import { createInstallationToken } from "@/lib/github-app";

// GET /api/repo-tree?repo=owner/name
//
// Returns the *live* root listing of the repo's default branch, rendered
// as one entry per line (directories suffixed with "/").  The chat's
// Project structure panel used to render repo_rules.repo_directory_tree
// which the agent only fills in from the files touched by a PR — so for
// repos where the latest PR was a README-only edit the operator saw
// just "./" and nothing else.  We hit GitHub directly here so the panel
// reflects what's actually in the repo regardless of agent activity.
//
// Pricing: one GET /repos/{repo}/contents/  call per panel-open per repo
// — cheap and cached on GitHub's side.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_API = "https://api.github.com";

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

interface GhContentEntry {
  name?: string;
  type?: "file" | "dir" | "symlink" | "submodule";
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

  // GET /repos/{repo}/contents/ → array of root entries on the default
  // branch. Cheap, single request, no recursion (we don't want a full
  // git-tree dump in the sidebar — root is enough context).
  let entries: GhContentEntry[] = [];
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `token ${token}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lyncas-tree",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `GitHub ${res.status}`, tree: null },
        { status: res.status === 404 ? 404 : 200 },
      );
    }
    const body = (await res.json()) as unknown;
    if (Array.isArray(body)) entries = body as GhContentEntry[];
  } catch {
    return NextResponse.json({ tree: null });
  }

  // Sort: directories first (alpha), then files (alpha). Suffix dirs
  // with "/" so the visual scan reads as a tree at a glance.
  const dirs = entries
    .filter((e) => e.type === "dir")
    .map((e) => `${e.name}/`)
    .sort();
  const files = entries
    .filter((e) => e.type === "file" || e.type === "symlink")
    .map((e) => e.name ?? "")
    .filter(Boolean)
    .sort();

  return NextResponse.json({
    repo,
    tree: [...dirs, ...files].join("\n"),
  });
}
