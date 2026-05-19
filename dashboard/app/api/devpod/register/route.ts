import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  DEFAULT_CAPABILITIES,
  isValidTunnelUrl,
  newExpiresAt,
  normalizeGithubUsername,
  notifyOpenclaw,
  resolveUserIdByUsername,
  verifyConnectToken,
} from "@/lib/devpod";

// POST /api/devpod/register
//
// Called by the devpod-connect CLI (mcp_server.py) once it has
// established a Cloudflare tunnel and is ready to accept commands.
// Body shape (validated below):
//
//   {
//     github_username: string,
//     tunnel_url:      string,        // must start with https://
//     workspace_id?:   string,
//     secret:          string,        // <github_username>:<DEVPOD_CONNECT_SECRET>
//     capabilities?:   { run_command, run_tests, start_app, expose_port }
//   }
//
// Auth model: shared-secret. The `secret` field MUST equal the
// composite token the dashboard hands the user (mintable via
// /api/devpod/token). Binding the token half to the username
// prevents one user's token from registering a session for a
// different username; see lib/devpod.ts for the residual-risk note.
//
// Side effects (all best-effort, ordered for fail-open behaviour):
//   1. Upsert devpod_sessions on github_username — refreshes TTL,
//      stores the tunnel URL, capabilities, workspace_id.
//   2. Notify Openclaw gateway at localhost:18789 (fire-and-forget;
//      most deploys don't run Openclaw).
//
// Response on success:
//   { ok: true, expires_at, session_id }

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RegisterBody {
  github_username?: unknown;
  tunnel_url?: unknown;
  workspace_id?: unknown;
  secret?: unknown;
  capabilities?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return jsonError("Body must be JSON", 400);
  }

  const github_username = normalizeGithubUsername(body.github_username);
  if (!github_username) {
    return jsonError("`github_username` is required", 400);
  }
  if (!isValidTunnelUrl(body.tunnel_url)) {
    return jsonError(
      "`tunnel_url` must be a valid https:// URL",
      400,
    );
  }
  const tunnel_url = body.tunnel_url as string;

  const serverSecret = process.env.DEVPOD_CONNECT_SECRET;
  if (!verifyConnectToken(body.secret, github_username, serverSecret)) {
    // Don't leak which half of the credential was wrong — single
    // 401 for any auth failure.
    return jsonError("Invalid connect token", 401);
  }

  const workspace_id =
    typeof body.workspace_id === "string" && body.workspace_id.trim()
      ? body.workspace_id.trim()
      : null;

  // Capabilities: accept the four documented booleans, default any
  // missing field to true. Anything else in the object is ignored —
  // we don't want a future malicious CLI to pollute our column with
  // unbounded JSON.
  const capObj =
    body.capabilities && typeof body.capabilities === "object"
      ? (body.capabilities as Record<string, unknown>)
      : {};
  // Default everything to the v1 capability set; the body can flip
  // any of the four keys to false but cannot add new keys (we strip
  // anything outside the documented schema by ignoring capObj after
  // the four pulls below).
  const capabilities = {
    ...DEFAULT_CAPABILITIES,
    run_command: capObj.run_command !== false,
    run_tests: capObj.run_tests !== false,
    start_app: capObj.start_app !== false,
    expose_port: capObj.expose_port !== false,
  };

  const supabase = await createSupabaseServerClient();
  const user_id = await resolveUserIdByUsername(github_username);

  // Upsert by github_username. The unique index on
  // devpod_sessions(github_username) is what makes this work. status
  // is forced back to "active" on every register so a CLI restart
  // after a /disconnect call still re-arms the session.
  const expires_at = newExpiresAt();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("devpod_sessions")
    .upsert(
      {
        user_id,
        github_username,
        tunnel_url,
        workspace_id,
        status: "active",
        last_ping: now,
        expires_at,
        capabilities,
      },
      { onConflict: "github_username" },
    )
    .select("id, expires_at")
    .single();

  if (error || !data) {
    console.warn(
      `[devpod/register] upsert failed for ${github_username}: ${error?.message ?? "unknown"}`,
    );
    return jsonError(
      "Failed to register session. Check server logs.",
      500,
    );
  }

  // Best-effort Openclaw notification. Awaiting this means the CLI
  // sees a slightly slower /register on hosts that DO run Openclaw,
  // but the lib/devpod helper already caps it at 1.5s and
  // swallows errors — so the worst case is a 1.5s tax.
  await notifyOpenclaw({ github_username, tunnel_url, workspace_id });

  return NextResponse.json({
    ok: true,
    expires_at: data.expires_at,
    session_id: data.id,
  });
}
