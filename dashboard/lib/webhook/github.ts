import { REVIEW_MARKER } from "./config";

const GH_API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const token = process.env.PR_REVIEWER_PAT;
  if (!token) {
    throw new Error("PR_REVIEWER_PAT must be set for webhook GitHub calls");
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "night-pr-reviewer-webhook",
  };
}

async function gh<T = unknown>(
  path: string,
  init: RequestInit = {},
  accept?: string,
): Promise<T> {
  const headers = { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) };
  if (accept) headers.Accept = accept;
  const res = await fetch(`${GH_API}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${init.method ?? "GET"} ${path} -> ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
  }
  // Diff endpoint returns raw text — caller asks for it via the `accept` arg.
  if (accept === "application/vnd.github.v3.diff") {
    return (await res.text()) as T;
  }
  return (await res.json()) as T;
}

export async function fetchPRDiff(repo: string, prNumber: number): Promise<string> {
  return gh<string>(
    `/repos/${repo}/pulls/${prNumber}`,
    {},
    "application/vnd.github.v3.diff",
  );
}

interface IssueComment {
  body?: string | null;
}

export async function alreadyReviewed(repo: string, prNumber: number): Promise<boolean> {
  // GitHub paginates comments; for typical PRs one page (default 30) is plenty,
  // but we walk pages to be safe.
  let page = 1;
  while (page <= 10) {
    const comments = await gh<IssueComment[]>(
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    for (const c of comments) {
      if (typeof c?.body === "string" && c.body.includes(REVIEW_MARKER)) {
        return true;
      }
    }
    if (comments.length < 100) return false;
    page += 1;
  }
  return false;
}

export async function postComment(
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await gh(`/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

export async function closePR(repo: string, prNumber: number): Promise<void> {
  await gh(`/repos/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
}

interface RepoInfo {
  default_branch: string;
}

export async function getDefaultBranch(repo: string): Promise<string> {
  const info = await gh<RepoInfo>(`/repos/${repo}`);
  return info.default_branch || "main";
}

interface ContentsFile {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  content?: string; // base64 when type==file
  encoding?: string;
  size?: number;
  sha?: string;
}

export async function getFileContents(
  repo: string,
  filePath: string,
  ref?: string,
): Promise<string | null> {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  try {
    const data = await gh<ContentsFile>(`/repos/${repo}/contents/${filePath}${qs}`);
    if (data?.type !== "file" || !data.content) return null;
    const enc = data.encoding ?? "base64";
    if (enc !== "base64") return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

interface GitTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
}

interface GitTreeResponse {
  sha: string;
  tree: GitTreeEntry[];
  truncated?: boolean;
}

export async function getRecursiveTree(
  repo: string,
  ref: string,
): Promise<GitTreeResponse> {
  return gh<GitTreeResponse>(
    `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
}

interface BranchInfo {
  commit: { sha: string };
}

export async function getBranchHeadSha(repo: string, branch: string): Promise<string> {
  const data = await gh<BranchInfo>(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  return data.commit.sha;
}
