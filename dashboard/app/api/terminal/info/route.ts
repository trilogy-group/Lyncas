import { NextResponse } from "next/server";
import { createSupabaseServerClient, getUser } from "@/lib/supabase/server";
import {
  getTerminalSecret,
  mintTerminalToken,
  toWebSocketUrl,
} from "@/lib/terminal";

// GET /api/terminal/info
//
// The browser terminal (/dashboard/terminal) calls this to learn:
//   * whether a house terminal is online, and
//   * a ready-to-use wss:// endpoint + a short-lived signed token to
//     authenticate the WebSocket handshake.
//
// Auth: Supabase JWT. Only signed-in users get a token; the PTY server
// verifies it (HS256, shared DEVPOD_CONNECT_SECRET) before forking a
// shell.
//
// Response:
//   { connected: false }
//   { connected: true, ws_url, token, label, workspace_id, expires_at }

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const user = await getUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const secret = getTerminalSecret();
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "DEVPOD_CONNECT_SECRET is not configured on this deploy. Ask your admin to set it.",
      },
      { status: 503 },
    );
  }

  const supabase = await createSupabaseServerClient();
  // Most-recently-pinged runner wins. In the testing phase there's just
  // one box; ordering by last_ping keeps us on the freshest if several
  // ever register.
  const { data, error } = await supabase
    .from("house_terminal")
    .select("ws_url, label, workspace_id, status, expires_at")
    .order("last_ping", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(`[terminal/info] read failed: ${error.message}`);
    return NextResponse.json({ connected: false });
  }
  if (!data) {
    return NextResponse.json({ connected: false });
  }

  const expiresMs = Date.parse(data.expires_at);
  const live =
    data.status === "active" &&
    Number.isFinite(expiresMs) &&
    expiresMs > Date.now();
  if (!live) {
    return NextResponse.json({ connected: false });
  }

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const githubUsername =
    typeof meta.user_name === "string" && meta.user_name.trim()
      ? meta.user_name.trim()
      : typeof meta.preferred_username === "string" &&
          meta.preferred_username.trim()
        ? meta.preferred_username.trim()
        : null;

  const token = mintTerminalToken({
    secret,
    userId: user.id,
    githubUsername,
  });

  return NextResponse.json({
    connected: true,
    ws_url: toWebSocketUrl(data.ws_url),
    token,
    label: data.label ?? data.workspace_id,
    workspace_id: data.workspace_id,
    expires_at: data.expires_at,
  });
}
