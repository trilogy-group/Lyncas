import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import { resolveGithubToken } from "@/lib/github-token";
import {
  normalizeGithubUsername,
  resolveUserIdByAuthUsername,
  verifyConnectToken,
} from "@/lib/devpod";
import { getSandboxResultsForRepo } from "@/lib/queries";

// POST /api/chat — server-sent-events endpoint backing the
// /dashboard/chat UI.
//
// Flow:
//   1. AuthN: must be a logged-in dashboard user.
//   2. AuthZ: the requested `repo` must be in the caller's
//      watched_repos. We scope by user_id explicitly (RLS does too,
//      this is defense-in-depth) and 403 when the row is missing.
//   3. Pick the right GitHub token for this repo via
//      lib/github-token.ts. Precedence:
//        a. watched_repos.token_type='github_app' — mint a fresh
//           installation token via createInstallationToken().
//        b. watched_repos.token_type='pat' — use github_token.
//        c. fallback to PR_REVIEWER_PAT env var (legacy single-tenant).
//        d. null — public-read; private repos will 404.
//      The same token is used for both pre-fetch (read) and ACTION
//      execution (write); installation tokens carry the App-granted
//      scopes, no read/write split.
//   4. Pre-fetch GitHub context based on keyword routing. Each fetch
//      is best-effort.
//   5. Send context + message to Claude Sonnet 4.5 with streaming.
//      The system prompt teaches Claude to emit `ACTION: ...` blocks
//      at the END of its response when the user asks for write
//      operations. We strip those blocks from what we forward to the
//      client and execute them server-side, then append a clean
//      confirmation line.
//
// "Research briefing" mode (isResearchBriefing=true) overrides the
// system prompt and pre-fetches a specific bundle of repo metadata
// instead of doing keyword routing. The chat page renders the
// response as a special "Research Briefing" card.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHAT_MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 1024;
const HISTORY_LIMIT = 10;

// Cap each GitHub payload so we don't blow Claude's context window.
const TRUNC = {
  prs: 20,
  branches: 30,
  collaborators: 30,
  commits: 30,
  files: 30,
  patchChars: 6000,
  reviewRowsFromDB: 10,
  contributors: 20,
};

function systemPromptChat(repo: string): string {
  return `\
You are a GitHub repository assistant for Lyncas.
You help developers understand their repositories, review pull requests, and manage their codebase.
Current repository: ${repo}
You have access to real GitHub data fetched before this conversation.
Answer questions about PRs, branches, collaborators, diffs, and recent activity based on the data provided.
Be concise and specific. Format lists with bullet points.
For code diffs, use markdown code blocks.
When asked to review a PR, give a structured review: verdict (approve/request changes), severity (1-10), key bugs found, and a recommendation.
If the relevant data isn't in the REPOSITORY DATA block, say so plainly rather than guessing.

WRITE OPERATIONS — when the user asks you to close, reopen, comment on, or merge a PR, include the appropriate ACTION block(s) at the END of your response, each on its own line. The user does not see the ACTION lines — they are parsed server-side and the platform executes each action for you, then appends a confirmation message.

Supported actions:
  ACTION: CLOSE_PR {number}
  ACTION: OPEN_PR {number}
  ACTION: COMMENT_PR {number} {your comment text on one line}
  ACTION: MERGE_PR {number}

Rules:
- Use ACTION blocks ONLY when the user explicitly requests the action ("close pr 42", "merge this pr", etc.). Do not invent actions.
- Always confirm BEFORE merging. For "merge pr 42" requests, first reply with "Are you sure you want to merge PR #42? Reply 'yes, merge' to proceed." and DO NOT include ACTION: MERGE_PR. Only include ACTION: MERGE_PR after the user explicitly confirms ("yes, merge", "confirmed", etc.). The same confirmation rule applies to bulk merges — never emit ACTION: MERGE_PR for multiple PRs without an explicit confirmation in the prior turn.
- For COMMENT_PR, the comment text follows the number on the SAME line. Keep it under 1000 characters and use plain text (no triple backticks — they break the parser). Markdown without code fences is fine.
- When closing/opening multiple PRs, include one ACTION block per PR at the end of your response. Example for closing 3 PRs:
    ACTION: CLOSE_PR 38
    ACTION: CLOSE_PR 37
    ACTION: CLOSE_PR 33
  Put each ACTION on its own line with no blank lines between them. The platform executes them in order and appends one confirmation per PR.
- The user sees only your prose. Do not refer to "the ACTION block" in your prose.`;
}

const RESEARCH_BRIEFING_PROMPT = `\
You are generating a Research Briefing for a GitHub repository room. Be structured and crisp — this renders as a small reference card, not a chat response.

Use exactly four sections with the headings shown below. Do NOT include any other prose, greetings, or sign-off. Do NOT use ACTION blocks here.

### What this repo does
Two sentences max, grounded in the data provided (languages, recent commits, README signals).

### Current focus areas
Two or three bullets inferred from the most recent PRs and commits. Each bullet: one line.

### Suggested research topics
Three bullets. Each: a topic + one short clause explaining why it matters for this repo.

### Resources to check
Two or three bullets pointing at concrete docs/files (e.g. "README", "docs/architecture.md", "package.json"). Only mention files that appear in the data — do not invent paths.`;

// "Generate Report" mode: full-page health report rendered in the chat
// pane as a print-friendly card. The shape is dictated so the user
// can reliably skim across repos.
function reportSystemPrompt(repo: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `\
Generate a comprehensive repository health report in markdown for ${repo}.

Structure (use these exact H1/H2 headings):

# Repository Health Report: ${repo}

## Executive Summary
3-4 sentences. Plain English, no jargon.

## PR Review Statistics
- Total reviews, auto-closed count, approval rate
- Average severity score (1-10)
- Most common bug types found

## Recent Activity (last 30 days)
Brief narrative of PR volume, merge frequency, contributor mix. Cite specific numbers from the data.

## Code Quality Trends
What's improving / regressing. Anchor to the review history when possible.

## Top Issues Found
Three to five concrete bugs / smells the reviewer has flagged across the most recent reviews. Quote PR numbers.

## Recommendations
Three to five actionable items, each one line. Use imperative voice ("Add CI lint…", "Reduce…").

## Sandbox Test Results
If the REPOSITORY DATA block contains a \`sandbox_results\` array, summarize the latest 5–10 entries: pass/fail counts, any PRs whose tests are currently failing, and any live preview URLs that were captured. If \`sandbox_results\` is empty or absent, write "No sandbox runs recorded — connect a DevPod from the dashboard chat to enable live PR testing." (verbatim) and move on.

## Risk Assessment
One of: Low / Medium / High. One paragraph of justification grounded in the data.

Rules:
  * Be specific with numbers — pull them from the REPOSITORY DATA block.
  * If a section's data is missing, write "Insufficient data" rather than inventing.
  * No ACTION blocks. No greetings. No closing fluff. Today's date: ${today}.
  * Do not wrap the whole response in a code fence — it's rendered as markdown.`;
}

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

interface RequestBody {
  message?: unknown;
  repo?: unknown;
  history?: unknown;
  isResearchBriefing?: unknown;
  isReport?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// --- GitHub helpers ------------------------------------------------------

interface GhFetchOpts {
  trunc?: number;
}

async function ghJSON<T = unknown>(
  url: string,
  pat: string | undefined,
  opts: GhFetchOpts = {},
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(pat ? { Authorization: `token ${pat}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lyncas-chat",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as T;
    if (opts.trunc && Array.isArray(data)) {
      return (data as unknown[]).slice(0, opts.trunc) as unknown as T;
    }
    return data;
  } catch {
    return null;
  }
}

// Per-keyword routing. Includes write-action intents (close/open/merge/
// comment) so the right context is loaded BEFORE Claude generates a
// response — Claude can't post a comment about a PR it didn't see.
function classifyMessage(message: string): {
  prs: boolean;
  branches: boolean;
  collaborators: boolean;
  commits: boolean;
  reviewPR: number | null;
  stats: boolean;
  closePR: number | null;
  openPR: number | null;
  mergePR: number | null;
  commentPR: number | null;
} {
  const m = message.toLowerCase();
  const reviewIntent =
    m.includes("review") || m.includes("diff") || m.includes("changes");
  let reviewPR: number | null = null;
  if (reviewIntent) {
    const match =
      /#(\d{1,6})/.exec(message) ||
      /\b(?:pr|pull request)\s*#?(\d{1,6})/i.exec(message);
    if (match) reviewPR = Number(match[1]);
  }

  // Action intent extractors. Each looks for a verb + a PR number.
  // The verbs are deliberately restrictive ("close pr 42", not "I think
  // they should close 42") so we don't accidentally pre-fetch on every
  // mention of "close".
  function pick(re: RegExp): number | null {
    const x = re.exec(message);
    return x ? Number(x[1]) : null;
  }
  const closePR = pick(
    /\bclose(?:\s+pr|\s+pull\s+request)?\s+#?(\d{1,6})/i,
  );
  const openPR =
    pick(/\b(?:open|reopen)\s+(?:pr|pull\s+request)\s+#?(\d{1,6})/i) ||
    pick(/\breopen\s+#?(\d{1,6})/i);
  const mergePR = pick(/\bmerge(?:\s+pr|\s+pull\s+request)?\s+#?(\d{1,6})/i);
  const commentPR = pick(
    /\bcomment(?:\s+on)?\s+(?:pr|pull\s+request)\s+#?(\d{1,6})/i,
  );

  return {
    prs: m.includes("pr") || m.includes("pull request"),
    branches: m.includes("branch"),
    collaborators: m.includes("collaborator") || m.includes("team"),
    commits:
      m.includes("recent") ||
      m.includes("activity") ||
      m.includes("commit") ||
      m.includes("latest"),
    reviewPR,
    stats:
      m.includes("stats") ||
      m.includes("overview") ||
      m.includes("repo stats"),
    closePR,
    openPR,
    mergePR,
    commentPR,
  };
}

interface FetchedContext {
  fetched: Record<string, unknown>;
  errors: string[];
}

async function fetchPRDetail(
  base: string,
  pat: string | undefined,
  n: number,
  ctx: Record<string, unknown>,
  errors: string[],
  key: string,
): Promise<void> {
  const [pr, files] = await Promise.all([
    ghJSON<Record<string, unknown>>(`${base}/pulls/${n}`, pat),
    ghJSON<Array<Record<string, unknown>>>(
      `${base}/pulls/${n}/files?per_page=${TRUNC.files}`,
      pat,
      { trunc: TRUNC.files },
    ),
  ]);
  if (!pr && !files) {
    errors.push(`Could not fetch PR #${n}`);
    return;
  }
  ctx[key] = pr
    ? {
        number: pr.number,
        title: pr.title,
        body: typeof pr.body === "string" ? pr.body.slice(0, 1500) : null,
        user: (pr.user as { login?: string } | null)?.login,
        state: pr.state,
        merged: pr.merged,
        mergeable: pr.mergeable,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        url: pr.html_url,
      }
    : { error: "pr not found" };
  if (files) {
    let budget = TRUNC.patchChars;
    ctx[`${key}_files`] = files.map((f) => {
      const patch = typeof f.patch === "string" ? (f.patch as string) : "";
      const allowed = Math.max(0, Math.min(patch.length, budget));
      budget -= allowed;
      return {
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: patch.slice(0, allowed) || undefined,
        patch_truncated: patch.length > allowed,
      };
    });
  }
}

async function fetchGitHubContext(
  repo: string,
  message: string,
  pat: string | undefined,
  isResearchBriefing: boolean,
  isReport: boolean = false,
): Promise<FetchedContext> {
  const ctx: Record<string, unknown> = {};
  const errors: string[] = [];
  const base = `https://api.github.com/repos/${repo}`;
  const jobs: Array<Promise<void>> = [];

  if (isReport) {
    // Health-report bundle: last-30-days commits + open PRs +
    // contributors + languages + the last 30 reviews from Supabase.
    // The report prompt explicitly tells Claude to ground numbers
    // here, so we pull more rows than the chat path normally would.
    jobs.push(
      ghJSON<Record<string, unknown>>(`${base}`, pat).then((data) => {
        if (data) {
          ctx.repo_meta = {
            name: data.full_name,
            description: data.description,
            primary_language: data.language,
            default_branch: data.default_branch,
            stars: data.stargazers_count,
            forks: data.forks_count,
            open_issues: data.open_issues_count,
            pushed_at: data.pushed_at,
          };
        }
      }),
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/pulls?state=open&per_page=30`,
        pat,
        { trunc: 30 },
      ).then((data) => {
        if (data) {
          ctx.open_pull_requests = data.map((p) => ({
            number: p.number,
            title: p.title,
            user: (p.user as { login?: string } | null)?.login,
            created_at: p.created_at,
            draft: p.draft,
          }));
        }
      }),
      ghJSON<Array<Record<string, unknown>>>(
        // Commits since 30d ago — GitHub takes ISO-8601 in &since=.
        `${base}/commits?per_page=100&since=${new Date(Date.now() - 30 * 86_400_000).toISOString()}`,
        pat,
        { trunc: 100 },
      ).then((data) => {
        if (data) {
          ctx.recent_commits_30d = data.map((c) => {
            const commit = c.commit as
              | { message?: string; author?: { name?: string; date?: string } }
              | null;
            return {
              sha: (c.sha as string | undefined)?.slice(0, 7),
              author: commit?.author?.name,
              date: commit?.author?.date,
              message: commit?.message?.split("\n")[0],
            };
          });
          ctx.commit_count_30d = data.length;
        }
      }),
      ghJSON<Record<string, number>>(`${base}/languages`, pat).then((data) => {
        if (data) ctx.languages = data;
      }),
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/contributors?per_page=10`,
        pat,
        { trunc: 10 },
      ).then((data) => {
        if (data) {
          ctx.contributors = data.map((c) => ({
            login: c.login,
            contributions: c.contributions,
          }));
        }
      }),
      // Last 30 reviews from Supabase — the agent's own history is
      // the meat of the report. Verdict + severity + action lets
      // Claude compute approval rate, auto-closed count, etc.
      (async () => {
        try {
          const supabase = await createSupabaseServerClient();
          const { data } = await supabase
            .from("reviews")
            .select(
              "id, created_at, pr_number, pr_title, verdict, severity_score, action, bugs_found",
            )
            .eq("repo", repo)
            .order("created_at", { ascending: false })
            .limit(30);
          if (data) ctx.recent_reviews = data;
        } catch {
          errors.push("Could not fetch review history");
        }
      })(),
      // Sandbox runs (migration 015). RLS-scoped to the caller's
      // user_id, so an unowned repo returns []. The report prompt
      // explicitly handles the empty case.
      (async () => {
        try {
          const rows = await getSandboxResultsForRepo(repo, 20);
          ctx.sandbox_results = rows.map((r) => ({
            pr_number: r.pr_number,
            overall: r.overall,
            tests_passed: r.tests_passed,
            tests_failed: r.tests_failed,
            app_url: r.app_url,
            created_at: r.created_at,
          }));
        } catch {
          // Soft-fail: missing migration or transient DB error. The
          // report prompt's "if sandbox_results is empty" branch
          // handles this gracefully.
          ctx.sandbox_results = [];
        }
      })(),
    );
    await Promise.all(jobs);
    return { fetched: ctx, errors };
  }

  if (isResearchBriefing) {
    // Briefing bundle: fixed, repo-scoped. Recent commits + open PRs +
    // languages + contributors. Languages and contributors are what
    // tell Claude "this is a Python data repo" vs "this is a TS frontend".
    jobs.push(
      ghJSON<Record<string, unknown>>(`${base}`, pat).then((data) => {
        if (data) {
          ctx.repo_meta = {
            name: data.full_name,
            description: data.description,
            primary_language: data.language,
            default_branch: data.default_branch,
            stars: data.stargazers_count,
            forks: data.forks_count,
            open_issues: data.open_issues_count,
            pushed_at: data.pushed_at,
          };
        } else {
          errors.push("Could not fetch repo metadata");
        }
      }),
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/pulls?state=open&per_page=20`,
        pat,
        { trunc: TRUNC.prs },
      ).then((data) => {
        if (data) {
          ctx.open_pull_requests = data.map((p) => ({
            number: p.number,
            title: p.title,
            user: (p.user as { login?: string } | null)?.login,
            url: p.html_url,
          }));
        } else {
          errors.push("Could not fetch open PRs");
        }
      }),
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/commits?per_page=20`,
        pat,
        { trunc: TRUNC.commits },
      ).then((data) => {
        if (data) {
          ctx.recent_commits = data.map((c) => {
            const commit = c.commit as
              | { message?: string; author?: { name?: string; date?: string } }
              | null;
            return {
              sha: (c.sha as string | undefined)?.slice(0, 7),
              author: commit?.author?.name,
              date: commit?.author?.date,
              message: commit?.message?.split("\n")[0],
            };
          });
        } else {
          errors.push("Could not fetch commits");
        }
      }),
      ghJSON<Record<string, number>>(`${base}/languages`, pat).then((data) => {
        if (data) ctx.languages = data;
      }),
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/contributors?per_page=${TRUNC.contributors}`,
        pat,
        { trunc: TRUNC.contributors },
      ).then((data) => {
        if (data) {
          ctx.contributors = data.map((c) => ({
            login: c.login,
            contributions: c.contributions,
          }));
        }
      }),
    );
    await Promise.all(jobs);
    return { fetched: ctx, errors };
  }

  const intent = classifyMessage(message);

  // PRs list — pulled when the user mentions PRs, asks to review, or
  // asks for an action that targets a specific number we haven't yet
  // identified (so Claude has something to anchor "the latest PR" on).
  if (intent.prs || intent.reviewPR !== null || intent.mergePR !== null) {
    jobs.push(
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/pulls?state=open&per_page=20`,
        pat,
        { trunc: TRUNC.prs },
      ).then((data) => {
        if (data) {
          ctx.open_pull_requests = data.map((p) => ({
            number: p.number,
            title: p.title,
            user: (p.user as { login?: string } | null)?.login,
            head: (p.head as { ref?: string } | null)?.ref,
            base: (p.base as { ref?: string } | null)?.ref,
            url: p.html_url,
            created_at: p.created_at,
            draft: p.draft,
          }));
        } else {
          errors.push("Could not fetch open PRs");
        }
      }),
    );
  }

  if (intent.branches) {
    jobs.push(
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/branches?per_page=30`,
        pat,
        { trunc: TRUNC.branches },
      ).then((data) => {
        if (data) {
          ctx.branches = data.map((b) => ({
            name: b.name,
            sha: (b.commit as { sha?: string } | null)?.sha,
            protected: b.protected,
          }));
        } else {
          errors.push("Could not fetch branches");
        }
      }),
    );
  }

  if (intent.collaborators) {
    jobs.push(
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/collaborators`,
        pat,
        { trunc: TRUNC.collaborators },
      ).then((data) => {
        if (data) {
          ctx.collaborators = data.map((c) => ({
            login: c.login,
            permissions: c.permissions,
          }));
        } else {
          errors.push(
            "Could not fetch collaborators (token may lack admin scope)",
          );
        }
      }),
    );
  }

  if (intent.commits) {
    jobs.push(
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/commits?per_page=30`,
        pat,
        { trunc: TRUNC.commits },
      ).then((data) => {
        if (data) {
          ctx.recent_commits = data.map((c) => {
            const commit = c.commit as
              | { message?: string; author?: { name?: string; date?: string } }
              | null;
            return {
              sha: (c.sha as string | undefined)?.slice(0, 7),
              author: commit?.author?.name,
              date: commit?.author?.date,
              message: commit?.message?.split("\n")[0],
            };
          });
        } else {
          errors.push("Could not fetch commits");
        }
      }),
    );
  }

  // Each "target PR" intent (review, close, open, merge, comment) pulls
  // the PR + its files once. Different keys keep Claude's view sharp:
  // "the user wants to close PR 42 (target_close_pr)" reads cleaner than
  // a shared "target_pr".
  const targets: Array<{ n: number; key: string }> = [];
  if (intent.reviewPR !== null)
    targets.push({ n: intent.reviewPR, key: "target_pr" });
  if (intent.closePR !== null)
    targets.push({ n: intent.closePR, key: "target_close_pr" });
  if (intent.openPR !== null)
    targets.push({ n: intent.openPR, key: "target_open_pr" });
  if (intent.mergePR !== null)
    targets.push({ n: intent.mergePR, key: "target_merge_pr" });
  if (intent.commentPR !== null)
    targets.push({ n: intent.commentPR, key: "target_comment_pr" });
  // Dedupe by (n, key) — a single "review and close pr 42" command
  // could otherwise fetch the same PR twice.
  const seen = new Set<string>();
  for (const t of targets) {
    const k = `${t.n}:${t.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    jobs.push(fetchPRDetail(base, pat, t.n, ctx, errors, t.key));
  }

  if (intent.stats) {
    jobs.push(
      ghJSON<Record<string, number>>(`${base}/languages`, pat).then(
        (data) => {
          if (data) ctx.languages = data;
        },
      ),
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/contributors?per_page=${TRUNC.contributors}`,
        pat,
        { trunc: TRUNC.contributors },
      ).then((data) => {
        if (data) {
          ctx.contributors = data.map((c) => ({
            login: c.login,
            contributions: c.contributions,
          }));
        }
      }),
      // Closed PR count (last 30d) — list endpoint with state=closed,
      // sliced. /search/issues would be exact but burns more rate
      // limit; the list endpoint is good enough for "rough volume".
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/pulls?state=closed&per_page=30&sort=updated&direction=desc`,
        pat,
        { trunc: 30 },
      ).then((data) => {
        if (data) {
          const since = Date.now() - 30 * 86_400_000;
          const recent = data.filter((p) => {
            const updated = p.updated_at as string | undefined;
            return updated ? Date.parse(updated) >= since : false;
          });
          ctx.closed_prs_recent_count = recent.length;
        }
      }),
    );

    // Supabase-side stats — the agent's prior review history for this
    // repo. Server client carries the user's session; RLS keeps it
    // owner-scoped.
    jobs.push(
      (async () => {
        try {
          const supabase = await createSupabaseServerClient();
          const { data } = await supabase
            .from("reviews")
            .select(
              "id, created_at, pr_number, pr_title, verdict, severity_score, action",
            )
            .eq("repo", repo)
            .order("created_at", { ascending: false })
            .limit(TRUNC.reviewRowsFromDB);
          if (data) ctx.recent_reviews_in_db = data;
        } catch {
          errors.push("Could not fetch review history");
        }
      })(),
    );
  }

  await Promise.all(jobs);
  return { fetched: ctx, errors };
}

// --- Action execution ----------------------------------------------------
// Parses + executes ACTION blocks emitted by Claude at the tail of a
// response. The streaming layer hides everything from the first
// `ACTION:` marker onward so the user never sees the raw markers;
// here we walk the hidden region line-by-line, parse each ACTION:
// line, and execute them in source order. Failures are surfaced as
// user-visible warnings instead of swallowing — the user asked for
// these actions and deserves to know if GitHub rejected any.
//
// Multiple ACTIONs in one response are supported (bulk close /
// reopen / comment). The system prompt asks for one ACTION per
// line with no blank lines between them; we're tolerant of stray
// non-ACTION lines (they're just skipped by parseAction) but we
// preserve the order so confirmations match the user's mental
// model of "what got done, in the order I asked".

type ActionKind = "CLOSE_PR" | "OPEN_PR" | "COMMENT_PR" | "MERGE_PR";

interface ParsedAction {
  kind: ActionKind;
  number: number;
  comment?: string;
}

function parseAction(line: string): ParsedAction | null {
  // Strip any leading whitespace + the "ACTION:" prefix.
  const m = /^ACTION:\s*(CLOSE_PR|OPEN_PR|COMMENT_PR|MERGE_PR)\s+(\d{1,6})(?:\s+([\s\S]*))?$/.exec(
    line.trim(),
  );
  if (!m) return null;
  const kind = m[1] as ActionKind;
  const number = Number(m[2]);
  const comment = m[3]?.trim() || undefined;
  if (kind === "COMMENT_PR" && !comment) return null;
  return { kind, number, comment };
}

async function executeAction(
  repo: string,
  token: string,
  action: ParsedAction,
): Promise<string> {
  const base = `https://api.github.com/repos/${repo}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `token ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lyncas-chat",
  } as const;

  try {
    if (action.kind === "CLOSE_PR") {
      const res = await fetch(`${base}/pulls/${action.number}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      });
      if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
      return `**PR #${action.number} closed.**`;
    }
    if (action.kind === "OPEN_PR") {
      const res = await fetch(`${base}/pulls/${action.number}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ state: "open" }),
      });
      if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
      return `**PR #${action.number} reopened.**`;
    }
    if (action.kind === "MERGE_PR") {
      const res = await fetch(`${base}/pulls/${action.number}/merge`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ merge_method: "merge" }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { message?: string };
          if (j.message) detail = j.message;
        } catch {
          // non-json
        }
        throw new Error(detail);
      }
      return `**PR #${action.number} merged.**`;
    }
    if (action.kind === "COMMENT_PR") {
      const res = await fetch(`${base}/issues/${action.number}/comments`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body: action.comment }),
      });
      if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
      return `**Comment posted on PR #${action.number}.**`;
    }
  } catch (e) {
    return `**Action failed (${action.kind} #${action.number}):** ${(e as Error).message}`;
  }
  return "";
}

// --- Anthropic streaming -------------------------------------------------

interface AnthropicMessageContent {
  type: string;
  text?: string;
}

interface AnthropicSSEEvent {
  type: string;
  delta?: AnthropicMessageContent;
  message?: { content?: AnthropicMessageContent[] };
}

// Action stripping: Claude is instructed to put the ACTION line at the
// END. We can't simply emit text as it arrives or the user will briefly
// see "ACTION: CLOSE_PR 42" flash on screen before we'd otherwise hide
// it. Instead we keep a small trailing window (LOOKAHEAD chars) buffered
// at all times — when an ACTION marker appears in that window, we know
// to stop emitting before it. After the upstream finishes, we parse the
// captured ACTION line, execute it, and emit a confirmation as a final
// SSE frame.
const LOOKAHEAD = 32;

async function streamFromAnthropic(opts: {
  apiKey: string;
  systemPrompt: string;
  history: HistoryEntry[];
  userMessage: string;
  // When set, we'll parse ACTION blocks from the full response and run
  // them with this token. When null, we still strip ACTION blocks (so
  // the user never sees them) but never execute — used for the research
  // briefing path where actions are nonsensical.
  writeToken: string | null;
  repo: string;
  allowActions: boolean;
  // Optional override — the report path needs ~4x the default to fit
  // a full markdown document without truncation.
  maxTokens?: number;
}): Promise<Response> {
  const messages = [
    ...opts.history.slice(-HISTORY_LIMIT).map((h) => ({
      role: h.role,
      content: h.content,
    })),
    { role: "user", content: opts.userMessage },
  ];

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      max_tokens: opts.maxTokens ?? MAX_TOKENS,
      stream: true,
      system: opts.systemPrompt,
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    let detail = `Anthropic returned HTTP ${upstream.status}`;
    try {
      const j = (await upstream.json()) as { error?: { message?: string } };
      if (j.error?.message) detail = j.error.message;
    } catch {
      // non-json
    }
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  const writeToken = opts.writeToken;
  const repo = opts.repo;
  const allowActions = opts.allowActions;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Full accumulated assistant text (unmodified). Used for action
      // parsing at end-of-stream.
      let accum = "";
      // Index into `accum` of the next char NOT yet emitted to the
      // client. Always <= accum.length.
      let emitted = 0;
      // Once we've locked onto an ACTION block in the stream we stop
      // emitting forward — `actionStart` is the char index in accum
      // where the ACTION line begins (right after the newline, or 0
      // if it starts at the very top).
      let actionStart = -1;

      function tryFindAction(): void {
        if (actionStart !== -1) return;
        // Search the unemitted portion (minus the LOOKAHEAD tail —
        // the action marker might be straddling the next chunk).
        // For simplicity we search the entire accum window, since
        // ACTION: is meant to appear once at the END.
        const tail = accum.slice(emitted);
        const idx = tail.search(/(^|\n)ACTION:/);
        if (idx === -1) return;
        // Compute the absolute start position. If the match was on
        // a \n, skip it so actionStart points at "ACTION:" itself.
        const matchedNewline = tail[idx] === "\n";
        actionStart = emitted + idx + (matchedNewline ? 1 : 0);
      }

      function flushSafe(controller_: ReadableStreamDefaultController<Uint8Array>): void {
        if (actionStart !== -1) {
          // Emit everything before the ACTION marker, then stop.
          // The marker line itself (and anything after) is captured
          // silently for parsing.
          if (actionStart > emitted) {
            const chunk = accum.slice(emitted, actionStart);
            // Strip the trailing newline directly before ACTION:
            // for a cleaner visual hand-off to the confirmation.
            const trimmed = chunk.replace(/\n+$/, "");
            if (trimmed) {
              controller_.enqueue(
                encoder.encode(`data: ${trimmed}\n\n`),
              );
            }
            emitted = accum.length; // skip past the captured action region
          }
          return;
        }
        // No action detected yet — hold back the trailing LOOKAHEAD
        // chars in case "ACTION:" is forming there. Emit the rest.
        const safeEnd = Math.max(emitted, accum.length - LOOKAHEAD);
        if (safeEnd > emitted) {
          const chunk = accum.slice(emitted, safeEnd);
          controller_.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          emitted = safeEnd;
        }
      }

      function flushFinal(controller_: ReadableStreamDefaultController<Uint8Array>): void {
        tryFindAction();
        if (actionStart !== -1) {
          // Emit pre-action text. Skip the rest.
          if (actionStart > emitted) {
            const chunk = accum.slice(emitted, actionStart);
            const trimmed = chunk.replace(/\n+$/, "");
            if (trimmed) {
              controller_.enqueue(
                encoder.encode(`data: ${trimmed}\n\n`),
              );
            }
            emitted = accum.length;
          }
        } else {
          // No action — emit everything that's left.
          if (emitted < accum.length) {
            const chunk = accum.slice(emitted);
            controller_.enqueue(encoder.encode(`data: ${chunk}\n\n`));
            emitted = accum.length;
          }
        }
      }

      async function maybeExecuteAction(
        controller_: ReadableStreamDefaultController<Uint8Array>,
      ): Promise<void> {
        if (actionStart === -1) return;

        // Walk every line in the captured action region. Lines that
        // don't parse as an ACTION are silently skipped — Claude is
        // instructed to keep ACTIONs contiguous at the end, but a
        // stray prose line shouldn't abort the bulk operation.
        const actionRegion = accum.slice(actionStart);
        const parsed: ParsedAction[] = [];
        for (const rawLine of actionRegion.split("\n")) {
          const line = rawLine.trim();
          if (!line) continue;
          const p = parseAction(line);
          if (p) parsed.push(p);
        }
        if (parsed.length === 0) return;

        // Dedupe by (kind, number) so a model that emitted the same
        // ACTION twice doesn't double-close a PR. Comment_PR isn't
        // collapsed (two different comments to the same PR is a
        // legitimate, if rare, request).
        const seen = new Set<string>();
        const actions: ParsedAction[] = [];
        for (const p of parsed) {
          const key =
            p.kind === "COMMENT_PR"
              ? `${p.kind}#${p.number}#${p.comment}`
              : `${p.kind}#${p.number}`;
          if (seen.has(key)) continue;
          seen.add(key);
          actions.push(p);
        }

        if (!allowActions || !writeToken) {
          // Actions stripped but not executed — leave one discreet
          // hint per planned action so the user knows what was
          // suppressed and why.
          const lines = actions
            .map(
              (a) =>
                `_(${a.kind} #${a.number} not executed — no write token for this repo.)_`,
            )
            .join("\n");
          controller_.enqueue(encoder.encode(`data: \n\n${lines}\n\n`));
          return;
        }

        // Execute sequentially. We deliberately do NOT Promise.all
        // these: GitHub's secondary rate-limit punishes burst
        // writes against the same repo, and sequential execution
        // also gives the user a deterministic confirmation order
        // matching the order the model emitted (which mirrored
        // the order they asked for). Each result is emitted
        // immediately so a slow nth action doesn't hide the
        // earlier confirmations.
        const confirmations: string[] = [];
        for (const action of actions) {
          const result = await executeAction(repo, writeToken, action);
          if (result) confirmations.push(result);
        }
        if (confirmations.length > 0) {
          // One blank line between confirmations keeps the markdown
          // renderer from collapsing them into a single paragraph.
          controller_.enqueue(
            encoder.encode(`data: \n\n${confirmations.join("\n\n")}\n\n`),
          );
        }
      }

      try {
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const dataLine = frame
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            const payload = dataLine.slice(6).trim();
            if (!payload) continue;
            try {
              const evt = JSON.parse(payload) as AnthropicSSEEvent;
              if (
                evt.type === "content_block_delta" &&
                evt.delta?.type === "text_delta" &&
                typeof evt.delta.text === "string"
              ) {
                accum += evt.delta.text;
                tryFindAction();
                flushSafe(controller);
              } else if (evt.type === "message_stop") {
                flushFinal(controller);
                await maybeExecuteAction(controller);
                controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                controller.close();
                return;
              }
            } catch {
              // Malformed JSON — skip frame, keep streaming.
            }
          }
        }
        flushFinal(controller);
        await maybeExecuteAction(controller);
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      } catch (e) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: (e as Error).message })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      }
    },
    cancel() {
      void reader.cancel();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// --- Route handler -------------------------------------------------------

// Authenticated principal for downstream code. We support two auth
// modes: the standard Supabase JWT (cookie-based) AND an
// X-DevPod-Token header that the in-DevPod `lyncas` CLI sends. Only the
// `.id` field is read downstream; using a narrow shape keeps both
// paths pluggable without leaking JWT-specific fields into the
// DevPod path's principal.
interface AuthedPrincipal {
  id: string;
  // "jwt" or "devpod" — included in observability logs so an
  // operator can see which auth mode served a given request.
  source: "jwt" | "devpod";
}

// Resolve the X-DevPod-Token header into a user_id, or null if the
// header is absent/invalid. The token is the same composite the
// /api/devpod/token route hands out:
//   <github_username>:<DEVPOD_CONNECT_SECRET>
// We lower-case the username, verify the secret half against
// DEVPOD_CONNECT_SECRET in constant time, then look up the
// matching auth.users row by raw_user_meta_data->>'user_name'
// via the migration-016 security-definer RPC. We use the auth.users
// path (not user_profiles) so the lyncas CLI works even when the
// profile-row upsert hasn't run yet.
async function resolveDevpodAuth(
  request: NextRequest,
): Promise<AuthedPrincipal | null> {
  const headerValue =
    request.headers.get("x-devpod-token") ??
    request.headers.get("X-DevPod-Token");
  if (!headerValue) return null;
  const idx = headerValue.indexOf(":");
  if (idx <= 0) return null;
  const claimedUsername = normalizeGithubUsername(headerValue.slice(0, idx));
  if (!claimedUsername) return null;
  const serverSecret = process.env.DEVPOD_CONNECT_SECRET;
  if (!verifyConnectToken(headerValue, claimedUsername, serverSecret)) {
    return null;
  }
  const userId = await resolveUserIdByAuthUsername(claimedUsername);
  if (!userId) return null;
  return { id: userId, source: "devpod" };
}

export async function POST(request: NextRequest) {
  // 1. AuthN — try DevPod-token first, then Supabase JWT. The order
  // matters only for observability: an in-DevPod CLI that ALSO has a
  // dashboard cookie (rare) gets logged as the more specific source.
  let principal: AuthedPrincipal | null = await resolveDevpodAuth(
    request,
  ).catch(() => null);
  if (!principal) {
    const jwtUser = await getUser().catch(() => null);
    if (jwtUser) principal = { id: jwtUser.id, source: "jwt" };
  }
  if (!principal) return jsonError("Not authenticated", 401);
  const user = principal;

  // 2. Body parse
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Body must be JSON", 400);
  }
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const isResearchBriefing = body.isResearchBriefing === true;
  const isReport = body.isReport === true;
  // Reports don't need a user prompt — the system prompt is fully
  // self-contained. Briefings always synthesize a stub prompt
  // client-side, so they look like a normal message at this layer.
  const message =
    typeof body.message === "string"
      ? body.message.trim()
      : isReport
        ? "Generate the report now."
        : "";
  if (!message) return jsonError("`message` is required", 400);
  if (!repo || !REPO_PATTERN.test(repo)) {
    return jsonError("`repo` must look like owner/name", 400);
  }
  const historyRaw = Array.isArray(body.history) ? body.history : [];
  const history: HistoryEntry[] = historyRaw
    .filter(
      (h): h is HistoryEntry =>
        typeof h === "object" &&
        h !== null &&
        (("role" in h && (h as HistoryEntry).role === "user") ||
          (h as HistoryEntry).role === "assistant") &&
        typeof (h as HistoryEntry).content === "string",
    )
    .slice(-HISTORY_LIMIT);

  // 3. AuthZ + token resolution.
  //
  // Two paths diverge here:
  //
  //   * JWT (dashboard) — the user MUST have a watched_repos row for
  //     this repo. resolveGithubToken would happily fall through to
  //     PR_REVIEWER_PAT for any repo (which is correct for non-write
  //     reads), but for the dashboard we want a hard 403 instead of
  //     letting the user silently query someone else's public repo
  //     using the deploy-wide PAT.
  //
  //   * DevPod token (lyncas CLI) — the user is authenticated by
  //     possession of <github_username>:<DEVPOD_CONNECT_SECRET>, and
  //     the CLI is meant to work in any git checkout the user has
  //     locally. We deliberately skip the watched_repos ownership
  //     check: if the user has connected the repo we'll mint an
  //     installation token below; if not, resolveGithubToken falls
  //     through to PR_REVIEWER_PAT, which on EC2 has read access to
  //     everything we care about. Result: `lyncas` works in any repo.
  const supabase = await createSupabaseServerClient();
  if (user.source === "jwt") {
    const { data: ownership } = await supabase
      .from("watched_repos")
      .select("id")
      .eq("user_id", user.id)
      .eq("repo", repo)
      .maybeSingle();
    if (!ownership) {
      return jsonError(
        "You haven't connected this repo. Install the GitHub App from the chat page first.",
        403,
      );
    }
  }

  // 4. Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return jsonError("ANTHROPIC_API_KEY is not configured on this deploy", 503);
  }

  // 5. Mint the GitHub credential. One token serves both the pre-fetch
  // (read) phase and the ACTION-block (write) phase — installation
  // tokens carry the contents/metadata/PR write scopes the App was
  // granted at install time, so there's no read-vs-write split to
  // make here.
  const resolved = await resolveGithubToken({
    supabase,
    userId: user.id,
    repo,
    fallbackPat: process.env.PR_REVIEWER_PAT,
  });
  // Single line, parseable in Vercel logs: tells an operator at a
  // glance which auth flow served this request without leaking the
  // token. Keep this terse — it fires on every chat message.
  console.log(
    `[chat] repo=${repo} user=${user.id} auth=${user.source} token_source=${resolved.source}`,
  );

  const { fetched, errors } = await fetchGitHubContext(
    repo,
    message,
    resolved.token ?? undefined,
    isResearchBriefing,
    isReport,
  );

  const repoDataJSON = JSON.stringify(
    {
      ...fetched,
      ...(errors.length > 0 ? { _fetch_errors: errors } : {}),
    },
    null,
    2,
  );

  const userPayload = isReport
    ? `REPOSITORY DATA:\n${repoDataJSON}\n\nGenerate the report now.`
    : `REPOSITORY DATA:\n${repoDataJSON}\n\nUSER QUESTION:\n${message}`;

  // 6. Stream
  const systemPrompt = isReport
    ? reportSystemPrompt(repo)
    : isResearchBriefing
      ? RESEARCH_BRIEFING_PROMPT
      : systemPromptChat(repo);

  return streamFromAnthropic({
    apiKey: anthropicKey,
    systemPrompt,
    // Reports + briefings start a fresh context — neither benefits
    // from prior chit-chat.
    history: isReport || isResearchBriefing ? [] : history,
    userMessage: userPayload,
    writeToken: resolved.token,
    repo,
    // Reports are pure read-only generation — never execute ACTIONs
    // even if Claude hallucinates one.
    allowActions: !isResearchBriefing && !isReport,
    maxTokens: isReport ? 4096 : undefined,
  });
}
