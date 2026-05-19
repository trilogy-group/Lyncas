import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";

// POST /api/chat — server-sent-events endpoint backing the
// /dashboard/chat UI.
//
// Flow:
//   1. AuthN: must be a logged-in dashboard user. Without this any
//      caller could burn our Anthropic + GitHub quota.
//   2. AuthZ: the requested `repo` must be in the caller's
//      watched_repos. Avoids leaking arbitrary repo metadata to a
//      user who hasn't connected the repo.
//   3. Pre-fetch GitHub context based on simple keyword routing.
//      Each fetch is independently best-effort — a 404 / 500 on one
//      doesn't take the rest down.
//   4. Build a compact context blob, send it + the user message to
//      Claude Sonnet 4.5 with streaming enabled.
//   5. Re-emit Claude's `content_block_delta` text events on the wire
//      as `data: <text>\n\n` SSE frames, terminated by `data: [DONE]`.
//      The client decodes one frame at a time and appends to the
//      in-flight assistant message — see /dashboard/chat/page.tsx.
//
// Why not @anthropic-ai/sdk: the SDK is not installed in this project
// (and the spec says "no new packages"). The Messages API speaks
// SSE natively when `stream: true`, so a plain fetch + ReadableStream
// pipe is sufficient and keeps the bundle thin.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHAT_MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 1024;
const HISTORY_LIMIT = 10;

// Cap each GitHub payload so we don't blow Claude's context window
// when a repo has hundreds of branches / PRs. The numbers below are
// soft caps; the GitHub queries already use `per_page` to limit the
// upstream side.
const TRUNC = {
  prs: 20,
  branches: 30,
  collaborators: 30,
  commits: 10,
  files: 30,
  patchChars: 6000,
  reviewRowsFromDB: 10,
};

const SYSTEM_PROMPT = (repo: string) => `\
You are a GitHub repository assistant for Night PR Reviewer.
You help developers understand their repositories, review pull requests, and manage their codebase.
Current repository: ${repo}
You have access to real GitHub data fetched before this conversation.
Answer questions about PRs, branches, collaborators, diffs, and recent activity based on the data provided.
Be concise and specific. Format lists with bullet points.
For code diffs, use markdown code blocks.
When asked to review a PR, give a structured review:
verdict (approve/request changes), severity (1-10), key bugs found, and a recommendation.
If the relevant data isn't in the REPOSITORY DATA block, say so plainly rather than guessing.`;

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

interface RequestBody {
  message?: unknown;
  repo?: unknown;
  history?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// --- GitHub helpers ------------------------------------------------------

interface GhFetchOpts {
  // Truncate to this many top-level array entries after the response
  // is parsed. Saves us from threading a per-call slice() everywhere.
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
        "User-Agent": "night-pr-reviewer-chat",
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
    // Per the spec: a failed fetch is logged-and-continue, not fatal.
    return null;
  }
}

// Per-keyword routing. We do simple includes() rather than NLP because
// (a) it's predictable, (b) Claude itself fills the gap when the
// keyword routing misses — it just answers from whatever data we
// happened to attach.
function classifyMessage(message: string): {
  prs: boolean;
  branches: boolean;
  collaborators: boolean;
  commits: boolean;
  reviewPR: number | null;
  stats: boolean;
} {
  const m = message.toLowerCase();
  const reviewIntent =
    m.includes("review") || m.includes("diff") || m.includes("changes");
  // Pull a #-prefixed or bare PR number out of the message when the
  // user asks for a review. "review pr 42" / "diff for #42" both work.
  let reviewPR: number | null = null;
  if (reviewIntent) {
    const match =
      /#(\d{1,6})/.exec(message) ||
      /\b(?:pr|pull request)\s*#?(\d{1,6})/i.exec(message);
    if (match) reviewPR = Number(match[1]);
  }
  return {
    prs: m.includes("pr") || m.includes("pull request"),
    branches: m.includes("branch"),
    collaborators: m.includes("collaborator") || m.includes("team"),
    commits:
      m.includes("recent") ||
      m.includes("activity") ||
      m.includes("commit"),
    reviewPR,
    stats: m.includes("stats") || m.includes("overview"),
  };
}

interface FetchedContext {
  fetched: Record<string, unknown>;
  errors: string[];
}

async function fetchGitHubContext(
  repo: string,
  message: string,
  pat: string | undefined,
): Promise<FetchedContext> {
  const intent = classifyMessage(message);
  const ctx: Record<string, unknown> = {};
  const errors: string[] = [];

  const base = `https://api.github.com/repos/${repo}`;
  const jobs: Array<Promise<void>> = [];

  if (intent.prs || intent.reviewPR !== null) {
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
            "Could not fetch collaborators (PAT may lack admin scope)",
          );
        }
      }),
    );
  }

  if (intent.commits) {
    jobs.push(
      ghJSON<Array<Record<string, unknown>>>(
        `${base}/commits?per_page=10`,
        pat,
        { trunc: TRUNC.commits },
      ).then((data) => {
        if (data) {
          ctx.recent_commits = data.map((c) => {
            const commit = c.commit as
              | {
                  message?: string;
                  author?: { name?: string; date?: string };
                }
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

  if (intent.reviewPR !== null) {
    // PR review path. Fetch the PR + its file list in parallel; we
    // intentionally don't pull `.patch` for the whole PR because the
    // files endpoint already includes per-file patches that are
    // easier to truncate.
    const n = intent.reviewPR;
    jobs.push(
      Promise.all([
        ghJSON<Record<string, unknown>>(`${base}/pulls/${n}`, pat),
        ghJSON<Array<Record<string, unknown>>>(
          `${base}/pulls/${n}/files?per_page=${TRUNC.files}`,
          pat,
          { trunc: TRUNC.files },
        ),
      ]).then(([pr, files]) => {
        if (!pr && !files) {
          errors.push(`Could not fetch PR #${n}`);
          return;
        }
        ctx.target_pr = pr
          ? {
              number: pr.number,
              title: pr.title,
              body:
                typeof pr.body === "string"
                  ? pr.body.slice(0, 1500)
                  : null,
              user: (pr.user as { login?: string } | null)?.login,
              state: pr.state,
              merged: pr.merged,
              additions: pr.additions,
              deletions: pr.deletions,
              changed_files: pr.changed_files,
              url: pr.html_url,
            }
          : { error: "pr not found" };
        if (files) {
          // Keep filenames + truncated patches; this is what Claude
          // actually needs to assess severity / suggest changes.
          let budget = TRUNC.patchChars;
          ctx.target_pr_files = files.map((f) => {
            const patch =
              typeof f.patch === "string" ? (f.patch as string) : "";
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
      }),
    );
  }

  if (intent.stats) {
    // Supabase-side stats — the agent's prior review history for this
    // repo. We use the request-scoped Supabase client so RLS applies
    // (no cross-tenant leakage even if the input were tampered).
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

async function streamFromAnthropic(
  apiKey: string,
  systemPrompt: string,
  history: HistoryEntry[],
  userMessage: string,
): Promise<Response> {
  const messages = [
    ...history.slice(-HISTORY_LIMIT).map((h) => ({
      role: h.role,
      content: h.content,
    })),
    { role: "user", content: userMessage },
  ];

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      system: systemPrompt,
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    let detail = `Anthropic returned HTTP ${upstream.status}`;
    try {
      const j = (await upstream.json()) as { error?: { message?: string } };
      if (j.error?.message) detail = j.error.message;
    } catch {
      // non-json body
    }
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  // Re-emit the Anthropic SSE stream as our own simpler SSE format:
  // every `content_block_delta` of type `text_delta` becomes a single
  // `data: <text>\n\n` frame; a `[DONE]` sentinel marks completion.
  // Anything else (ping, message_start, etc.) is dropped.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // Anthropic frames are `event: <name>\ndata: <json>\n\n`.
          // Split on \n\n, keep partial trailing frame in buf.
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
                controller.enqueue(
                  encoder.encode(`data: ${evt.delta.text}\n\n`),
                );
              } else if (evt.type === "message_stop") {
                controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                controller.close();
                return;
              }
            } catch {
              // Malformed JSON — skip frame, keep streaming.
            }
          }
        }
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

export async function POST(request: NextRequest) {
  // 1. AuthN
  const user = await getUser().catch(() => null);
  if (!user) return jsonError("Not authenticated", 401);

  // 2. Body parse + light validation
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Body must be JSON", 400);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
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

  // 3. AuthZ — repo must be in the caller's watched_repos. RLS on
  // watched_repos enforces auth.uid()=user_id, so a missing row here
  // is indistinguishable from "this repo belongs to someone else".
  const supabase = await createSupabaseServerClient();
  const { data: ownership } = await supabase
    .from("watched_repos")
    .select("id")
    .eq("repo", repo)
    .maybeSingle();
  if (!ownership) {
    return jsonError(
      "You haven't connected this repo. Visit /dashboard/connect-repo first.",
      403,
    );
  }

  // 4. Anthropic API key required to actually answer
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return jsonError("ANTHROPIC_API_KEY is not configured on this deploy", 503);
  }

  // 5. Pre-fetch GitHub context. PR_REVIEWER_PAT is optional for
  // public-repo queries but private repos won't return anything
  // without it — surface that clearly via the errors[] field in the
  // context blob so Claude can mention it instead of hallucinating.
  const pat = process.env.PR_REVIEWER_PAT;
  const { fetched, errors } = await fetchGitHubContext(repo, message, pat);

  const repoDataJSON = JSON.stringify(
    {
      ...fetched,
      ...(errors.length > 0 ? { _fetch_errors: errors } : {}),
    },
    null,
    2,
  );

  const userPayload =
    `REPOSITORY DATA:\n${repoDataJSON}\n\nUSER QUESTION:\n${message}`;

  // 6. Stream
  return streamFromAnthropic(
    anthropicKey,
    SYSTEM_PROMPT(repo),
    history,
    userPayload,
  );
}
