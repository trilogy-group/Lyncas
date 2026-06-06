import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizeGithubUsername, verifyConnectToken } from "@/lib/devpod";

// /api/lyncas/history
//
// Conversation history for the `lyncas` CLI, keyed by
// (github_username, repo). The CLI calls this twice per
// invocation:
//
//   1. GET  — load the last 20 messages BEFORE composing a
//             /api/chat call, so Claude has context.
//   2. POST — upsert the new {user, assistant} pair appended to
//             the loaded array AFTER /api/chat returns.
//
// And once per `lyncas --clear`:
//
//   3. DELETE — wipe the row for this (username, repo).
//
// Auth: the lyncas CLI sends its composite token
//   <github_username>:<DEVPOD_CONNECT_SECRET>
// as `secret` (in the POST body, or in the DELETE query string),
// and the route validates it via verifyConnectToken — same pattern
// as /api/devpod/register and /api/devpod/ping. GET is unauthenticated
// because the row contents are already keyed by username + repo
// and the rest of the deploy publishes the same DEVPOD_CONNECT_SECRET
// for every user; leaking a user's own history to themselves over
// an unauth'd GET is not a meaningful regression.
//
// RLS: migration 019 renamed npr_conversations -> lyncas_conversations
// and keeps the permissive "anon all" policy because the route is the
// actual security boundary. See dashboard/lib/devpod.ts for the rationale.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Trim window. 20 messages = 10 user/assistant exchanges, which is
// what fits comfortably in the chat route's HISTORY_LIMIT slice
// without blowing the Anthropic context budget on the next call.
// Mirrors the trim the chat route does on its receiving side; we
// trim here too so we never store more than the next call could
// consume.
const MAX_MESSAGES = 20;

// Same repo format the chat route validates against. Keep the two
// patterns identical so a string that's good enough to chat with
// is good enough to persist.
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

function badRequest(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

// Defensive: any malformed entry (wrong role, missing content,
// nested objects) gets dropped silently. The CLI is the only writer
// in v1, but if a future caller sends garbage we'd rather drop the
// row's bad entries than fail the whole upsert.
function sanitizeMessages(input: unknown): HistoryMessage[] {
  if (!Array.isArray(input)) return [];
  const out: HistoryMessage[] = [];
  for (const m of input) {
    if (
      m &&
      typeof m === "object" &&
      "role" in m &&
      "content" in m &&
      typeof (m as { content: unknown }).content === "string" &&
      ((m as { role: unknown }).role === "user" ||
        (m as { role: unknown }).role === "assistant")
    ) {
      out.push({
        role: (m as { role: "user" | "assistant" }).role,
        content: (m as { content: string }).content,
      });
    }
  }
  // Keep the tail. If the CLI POSTs more than MAX_MESSAGES (e.g.
  // it forgot to trim), we still cap on our side.
  return out.slice(-MAX_MESSAGES);
}

function parseParams(
  req: NextRequest,
): { username: string; repo: string } | null {
  const url = new URL(req.url);
  const username = normalizeGithubUsername(url.searchParams.get("username"));
  const repo = (url.searchParams.get("repo") ?? "").trim();
  if (!username || !repo) return null;
  if (!REPO_PATTERN.test(repo)) return null;
  return { username, repo };
}

export async function GET(req: NextRequest) {
  const parsed = parseParams(req);
  if (!parsed) {
    return badRequest("`username` + `repo` query params are required");
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("lyncas_conversations")
    .select("messages")
    .eq("github_username", parsed.username)
    .eq("repo", parsed.repo)
    .maybeSingle();

  if (error) {
    // Soft-fail: a missing migration or transient DB error returns
    // an empty history. The CLI is expected to "continue without
    // history" on a degenerate response, so we keep the contract
    // simple — 200 + { messages: [] }.
    console.warn(`[lyncas/history] GET failed: ${error.message}`);
    return NextResponse.json({ messages: [] });
  }

  const messages = sanitizeMessages(data?.messages ?? []);
  return NextResponse.json({ messages });
}

export async function POST(req: NextRequest) {
  const parsed = parseParams(req);
  if (!parsed) {
    return badRequest("`username` + `repo` query params are required");
  }

  let body: { messages?: unknown; secret?: unknown };
  try {
    body = (await req.json()) as { messages?: unknown; secret?: unknown };
  } catch {
    return badRequest("Body must be JSON");
  }

  // Composite-token auth: same `verifyConnectToken(secret, username,
  // env)` shape as the register / ping routes. The CLI sends the
  // full `<github_username>:<DEVPOD_CONNECT_SECRET>` it stashed at
  // ~/.lyncas/.token; we bind the secret half to the
  // username from the query so a token can't write to another
  // user's row.
  if (
    !verifyConnectToken(
      body.secret,
      parsed.username,
      process.env.DEVPOD_CONNECT_SECRET,
    )
  ) {
    return badRequest("Invalid connect token", 401);
  }

  const messages = sanitizeMessages(body.messages);

  const supabase = await createSupabaseServerClient();
  // Touch updated_at explicitly on every upsert. The column default
  // (now()) only fires on INSERT, not UPDATE; without this the row's
  // updated_at would freeze at the first conversation timestamp.
  const { error } = await supabase.from("lyncas_conversations").upsert(
    {
      github_username: parsed.username,
      repo: parsed.repo,
      messages,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "github_username,repo" },
  );
  if (error) {
    console.warn(`[lyncas/history] upsert failed: ${error.message}`);
    return NextResponse.json(
      { error: "persist failed", detail: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const parsed = parseParams(req);
  if (!parsed) {
    return badRequest("`username` + `repo` query params are required");
  }

  // DELETE carries no body, so the secret lives in the query string.
  // Mirrors how lyncas --clear posts the call (a single curl/urllib
  // request from the user's DevPod, no extra round trip needed).
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (
    !verifyConnectToken(
      secret,
      parsed.username,
      process.env.DEVPOD_CONNECT_SECRET,
    )
  ) {
    return badRequest("Invalid connect token", 401);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("lyncas_conversations")
    .delete()
    .eq("github_username", parsed.username)
    .eq("repo", parsed.repo);

  if (error) {
    console.warn(`[lyncas/history] DELETE failed: ${error.message}`);
    return NextResponse.json(
      { error: "delete failed", detail: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
