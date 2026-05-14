import Anthropic from "@anthropic-ai/sdk";

import {
  FINGERPRINT_DEP_FILES,
  FINGERPRINT_DEP_FILE_MAX_CHARS,
  FINGERPRINT_DIR_DEPTH,
  FINGERPRINT_DIR_MAX_ENTRIES,
  FINGERPRINT_MAX_OUTPUT_TOKENS,
  FINGERPRINT_README_MAX_CHARS,
  FINGERPRINT_SKIP_DIRS,
  FINGERPRINT_TTL_DAYS,
  MODEL,
} from "./config";
import {
  getBranchHeadSha,
  getDefaultBranch,
  getFileContents,
  getRecursiveTree,
} from "./github";
import {
  FINGERPRINT_SUMMARIZER_SYSTEM_PROMPT,
  SUMMARIZER_USER_TEMPLATE,
} from "./prompts";
import { getServiceSupabase } from "./supabase";
import type { FingerprintResult, FingerprintStatus } from "./types";

// Phase 2 (Python) shallow-cloned each repo with `git clone --depth=1` and
// walked the working tree on disk. Vercel Functions don't have a git binary
// and shouldn't shell out to one, so this module uses the GitHub Trees +
// Contents APIs to recover the same inputs (README, dep file, top-level
// directory listing) without any local clone.
//
// The Supabase row schema (`repo_fingerprints`) is identical to the agent's
// — the cron and the webhook are interchangeable cache producers.

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function isStale(lastUpdated: string | null | undefined): boolean {
  if (!lastUpdated) return true;
  const last = Date.parse(lastUpdated);
  if (Number.isNaN(last)) return true;
  const ageMs = Date.now() - last;
  return ageMs > FINGERPRINT_TTL_DAYS * 24 * 60 * 60 * 1000;
}

async function readmeFromRepo(repo: string, ref: string): Promise<string> {
  // Linux paths are case-sensitive — try common variants in priority order.
  for (const name of ["README.md", "Readme.md", "readme.md", "README", "README.rst"]) {
    const content = await getFileContents(repo, name, ref);
    if (content) return truncate(content, FINGERPRINT_README_MAX_CHARS);
  }
  return "";
}

async function depFileFromRepo(repo: string, ref: string): Promise<string> {
  for (const name of FINGERPRINT_DEP_FILES) {
    const content = await getFileContents(repo, name, ref);
    if (content) {
      return `=== ${name} ===\n${truncate(content, FINGERPRINT_DEP_FILE_MAX_CHARS)}`;
    }
  }
  return "";
}

function formatTree(entries: Array<{ path: string; type: string }>): string {
  // Mirror the Python `_list_repo_tree` shape: indented `name/` lines, depth
  // <= FINGERPRINT_DIR_DEPTH, skipping noise dirs and dotfiles other than
  // `.github`. The tree API gives us all paths in one call; we filter in code.
  const kept: Array<{ depth: number; path: string; isDir: boolean }> = [];

  for (const e of entries) {
    const parts = e.path.split("/");
    const depth = parts.length;
    if (depth > FINGERPRINT_DIR_DEPTH) continue;

    let skip = false;
    for (const part of parts) {
      if (FINGERPRINT_SKIP_DIRS.has(part)) {
        skip = true;
        break;
      }
      if (part.startsWith(".") && part !== ".github") {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    kept.push({ depth, path: e.path, isDir: e.type === "tree" });
  }

  kept.sort((a, b) => {
    // Files after dirs within the same parent, then alphabetical.
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });

  const lines: string[] = [];
  for (const k of kept) {
    if (lines.length >= FINGERPRINT_DIR_MAX_ENTRIES) {
      lines.push(`... (truncated at ${FINGERPRINT_DIR_MAX_ENTRIES} entries)`);
      break;
    }
    const prefix = "  ".repeat(k.depth - 1);
    const parts = k.path.split("/");
    const name = parts[parts.length - 1];
    lines.push(`${prefix}${name}${k.isDir ? "/" : ""}`);
  }
  return lines.join("\n");
}

async function summarizeWithClaude(
  repo: string,
  readme: string,
  deps: string,
  tree: string,
): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: FINGERPRINT_MAX_OUTPUT_TOKENS,
    system: FINGERPRINT_SUMMARIZER_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: SUMMARIZER_USER_TEMPLATE(repo, readme, deps, tree) },
    ],
  });
  const block = response.content[0];
  if (!block || block.type !== "text") return "";
  return block.text.trim();
}

async function cacheLookup(repo: string): Promise<{ fingerprint: string | null; stale: boolean }> {
  try {
    const sb = getServiceSupabase();
    const { data, error } = await sb
      .from("repo_fingerprints")
      .select("fingerprint, last_updated")
      .eq("repo", repo)
      .limit(1);
    if (error) {
      console.warn(`[fingerprint:${repo}] cache lookup failed: ${error.message}`);
      return { fingerprint: null, stale: true };
    }
    const row = (data ?? [])[0] as
      | { fingerprint: string; last_updated: string | null }
      | undefined;
    if (!row || !row.fingerprint) return { fingerprint: null, stale: true };
    if (isStale(row.last_updated)) return { fingerprint: row.fingerprint, stale: true };
    return { fingerprint: row.fingerprint, stale: false };
  } catch (e) {
    console.warn(`[fingerprint:${repo}] cache lookup threw: ${(e as Error).message}`);
    return { fingerprint: null, stale: true };
  }
}

async function cacheWrite(
  repo: string,
  fingerprint: string,
  commitSha: string | null,
): Promise<void> {
  try {
    const sb = getServiceSupabase();
    await sb.from("repo_fingerprints").upsert(
      {
        repo,
        fingerprint,
        last_updated: new Date().toISOString(),
        commit_sha: commitSha,
        token_count: fingerprint.split(/\s+/).filter(Boolean).length,
      },
      { onConflict: "repo" },
    );
  } catch (e) {
    console.warn(
      `[fingerprint:${repo}] cache write failed: ${(e as Error).message} (using fingerprint for this run anyway)`,
    );
  }
}

export async function getOrRefreshFingerprint(repo: string): Promise<FingerprintResult> {
  // Mirrors the Phase-2 contract: any failure returns
  // { fingerprint: null, status: "unavailable" } and the caller proceeds
  // with no repo context.
  const wrap = (
    fingerprint: string | null,
    status: FingerprintStatus,
  ): FingerprintResult => ({ fingerprint, status });

  let cached: { fingerprint: string | null; stale: boolean };
  try {
    cached = await cacheLookup(repo);
  } catch {
    return wrap(null, "unavailable");
  }

  if (cached.fingerprint && !cached.stale) {
    console.log(
      `[fingerprint:${repo}] using cached fingerprint (${cached.fingerprint.split(/\s+/).filter(Boolean).length} words)`,
    );
    return wrap(cached.fingerprint, "cached");
  }

  try {
    console.log(`[fingerprint:${repo}] cache miss/stale — refreshing via GitHub API...`);
    const branch = await getDefaultBranch(repo);
    const sha = await getBranchHeadSha(repo, branch);
    const tree = await getRecursiveTree(repo, sha);

    const [readme, deps] = await Promise.all([
      readmeFromRepo(repo, sha),
      depFileFromRepo(repo, sha),
    ]);

    if (!readme && !deps) {
      console.warn(`[fingerprint:${repo}] no README or dep file — skipping`);
      // If we already had a stale cached value, keep using it rather than
      // dropping context entirely on a transient miss.
      if (cached.fingerprint) return wrap(cached.fingerprint, "cached");
      return wrap(null, "unavailable");
    }

    const treeText = formatTree(tree.tree ?? []);
    const fingerprint = await summarizeWithClaude(repo, readme, deps, treeText);
    if (!fingerprint) {
      if (cached.fingerprint) return wrap(cached.fingerprint, "cached");
      return wrap(null, "unavailable");
    }

    await cacheWrite(repo, fingerprint, sha);
    console.log(
      `[fingerprint:${repo}] generated & cached (${fingerprint.split(/\s+/).filter(Boolean).length} words, sha=${sha.slice(0, 7)})`,
    );
    return wrap(fingerprint, "fresh");
  } catch (e) {
    console.warn(
      `[fingerprint:${repo}] refresh failed: ${(e as Error).message}`,
    );
    if (cached.fingerprint) return wrap(cached.fingerprint, "cached");
    return wrap(null, "unavailable");
  }
}
