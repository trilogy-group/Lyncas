import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  newExpiresAt,
  normalizeGithubUsername,
  verifyConnectToken,
} from "@/lib/devpod";

// POST /api/devpod/ping
//
// Keepalive from the running CLI's `ping_loop`. Body:
//   { github_username: string, secret: string }
//
// Same shared-secret auth as /register. The CLI calls this every
// 30 minutes; we extend expires_at by 8h on each call so the row
// stays "live" indefinitely while the CLI is running but ages out
// within 8h after a crash / Ctrl-C.
//
// We also force status='active' here, in case a previous
// /disconnect call from the dashboard flipped it off — pinging from
// the CLI re-arms the session.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PingBody {
  github_username?: unknown;
  secret?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  let body: PingBody;
  try {
    body = (await request.json()) as PingBody;
  } catch {
    return jsonError("Body must be JSON", 400);
  }

  const github_username = normalizeGithubUsername(body.github_username);
  if (!github_username) {
    return jsonError("`github_username` is required", 400);
  }

  const serverSecret = process.env.DEVPOD_CONNECT_SECRET;
  if (!verifyConnectToken(body.secret, github_username, serverSecret)) {
    return jsonError("Invalid connect token", 401);
  }

  const supabase = await createSupabaseServerClient();
  const expires_at = newExpiresAt();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("devpod_sessions")
    .update({
      last_ping: now,
      expires_at,
      status: "active",
    })
    .eq("github_username", github_username)
    .select("id, expires_at")
    .maybeSingle();

  if (error) {
    console.warn(
      `[devpod/ping] update failed for ${github_username}: ${error.message}`,
    );
    return jsonError("Failed to refresh session", 500);
  }
  if (!data) {
    // Common at startup: ping arrives before /register completed,
    // or after the row was wiped. The CLI handles this by issuing
    // /register on the next loop, so a 404 here is recoverable.
    return jsonError("No session for this username; re-register", 404);
  }

  return NextResponse.json({
    ok: true,
    expires_at: data.expires_at,
  });
}
