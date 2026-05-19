import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";

// POST /api/devpod/execute
//
// Bridges the dashboard / Openclaw to the user's DevPod MCP server.
// Body:
//   {
//     repo:    string,
//     command: string,
//     type:    'run_command' | 'run_tests' | 'start_app' | 'expose_port',
//     // Optional fields (passed through to the MCP server):
//     port?:   number,        // expose_port
//     cwd?:    string,        // run_tests / start_app
//     entrypoint?: string,    // start_app
//   }
//
// Auth: Supabase JWT. We look up the caller's *own* live session,
// forward the command to its tunnel, capture the response, log to
// devpod_executions, and return the response body to the caller.
//
// 120s timeout: matches the MCP server's per-command budget. A
// hung tunnel is killed by AbortController and surfaces as a clean
// 504 instead of dangling the Next.js function until Vercel's
// fallback timer fires.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EXECUTE_TIMEOUT_MS = 120_000;

const VALID_TYPES = new Set([
  "run_command",
  "run_tests",
  "start_app",
  "expose_port",
] as const);

interface ExecuteBody {
  repo?: unknown;
  command?: unknown;
  type?: unknown;
  port?: unknown;
  cwd?: unknown;
  entrypoint?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  const user = await getUser().catch(() => null);
  if (!user) return jsonError("Not authenticated", 401);

  let body: ExecuteBody;
  try {
    body = (await request.json()) as ExecuteBody;
  } catch {
    return jsonError("Body must be JSON", 400);
  }

  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const command = typeof body.command === "string" ? body.command : "";
  const type = typeof body.type === "string" ? body.type : "";
  if (!type || !VALID_TYPES.has(type as (typeof VALID_TYPES extends Set<infer T> ? T : never))) {
    return jsonError(
      "`type` must be one of: run_command, run_tests, start_app, expose_port",
      400,
    );
  }
  // run_command and start_app strictly need a command; run_tests and
  // expose_port can let the MCP server auto-detect.
  if ((type === "run_command" || type === "start_app") && !command) {
    return jsonError("`command` is required for this type", 400);
  }

  const supabase = await createSupabaseServerClient();

  // Look up the caller's session. user_id-scoped via RLS — no need
  // to .eq("user_id", user.id) since the policy already filters,
  // but doing it explicitly is defense-in-depth (and survives a
  // future RLS regression).
  const { data: session } = await supabase
    .from("devpod_sessions")
    .select("id, tunnel_url, status, expires_at")
    .eq("user_id", user.id)
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!session) {
    return jsonError("No active DevPod session", 404);
  }
  const expiresMs = Date.parse(session.expires_at);
  const live =
    session.status === "active" &&
    Number.isFinite(expiresMs) &&
    expiresMs > Date.now();
  if (!live) {
    return jsonError("No active DevPod session", 404);
  }

  // Forward to the user's tunnel. The MCP server expects /execute
  // with a JSON body. Anything in `body` that the MCP server
  // recognizes (`port`, `cwd`, `entrypoint`) we forward verbatim.
  const forwarded: Record<string, unknown> = {
    type,
    command,
    repo,
  };
  if (typeof body.port === "number") forwarded.port = body.port;
  if (typeof body.cwd === "string") forwarded.cwd = body.cwd;
  if (typeof body.entrypoint === "string") forwarded.entrypoint = body.entrypoint;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), EXECUTE_TIMEOUT_MS);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let mcpStatus = 0;
  let mcpBody: unknown = null;
  let mcpText = "";
  let timedOut = false;

  try {
    const res = await fetch(
      session.tunnel_url.replace(/\/$/, "") + "/execute",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwarded),
        signal: ac.signal,
        cache: "no-store",
      },
    );
    mcpStatus = res.status;
    mcpText = await res.text();
    try {
      mcpBody = JSON.parse(mcpText);
    } catch {
      // The MCP server always returns JSON, but a tunnel-side error
      // (Cloudflare 502 page, for instance) won't. Fall back to
      // wrapping the text so the caller sees something useful.
      mcpBody = { error: mcpText.slice(0, 1000) || "Non-JSON response" };
    }
  } catch (e) {
    timedOut = (e as Error).name === "AbortError";
    mcpBody = {
      error: timedOut
        ? `Command timed out after ${EXECUTE_TIMEOUT_MS / 1000}s`
        : (e as Error).message,
    };
    mcpStatus = timedOut ? 504 : 502;
  } finally {
    clearTimeout(timer);
  }

  const finishedAtMs = Date.now();

  // Audit-log the execution. Output is truncated to 16 KB so a
  // chatty test runner doesn't bloat the row. Best-effort: a DB
  // failure here must not eat the response we're about to return
  // to the caller.
  const outputForLog = (() => {
    try {
      return JSON.stringify(mcpBody).slice(0, 16_384);
    } catch {
      return mcpText.slice(0, 16_384);
    }
  })();
  const exit_code =
    mcpBody && typeof mcpBody === "object" && "exit_code" in mcpBody
      ? (mcpBody as { exit_code?: unknown }).exit_code
      : null;
  void supabase
    .from("devpod_executions")
    .insert({
      session_id: session.id,
      command: command.slice(0, 4000),
      type,
      output: outputForLog,
      exit_code: typeof exit_code === "number" ? exit_code : null,
      started_at: startedAt,
      finished_at: new Date(finishedAtMs).toISOString(),
      duration_ms: finishedAtMs - startedAtMs,
    })
    .then(({ error }) => {
      if (error) {
        console.warn(
          `[devpod/execute] audit-log insert failed: ${error.message}`,
        );
      }
    });

  // Status mapping: forward MCP success / error categories upward
  // verbatim so the caller can branch on HTTP status without
  // re-parsing the body.
  if (mcpStatus === 0) mcpStatus = 502;
  return NextResponse.json(mcpBody, { status: mcpStatus });
}
