import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getTerminalSecret,
  houseTerminalExpiresAt,
  verifyTerminalSecret,
} from "@/lib/terminal";

// POST /api/terminal/ping
//
// Heartbeat from agent/terminal_server.py. Refreshes last_ping and
// pushes expires_at forward by the 8h window so a healthy runner never
// ages out. Body: { workspace_id, secret }.
//
// Auth: shared secret (DEVPOD_CONNECT_SECRET), same as /register.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PingBody {
  workspace_id?: unknown;
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

  if (!verifyTerminalSecret(body.secret, getTerminalSecret())) {
    return jsonError("Invalid connect secret", 401);
  }

  const workspace_id =
    typeof body.workspace_id === "string" && body.workspace_id.trim()
      ? body.workspace_id.trim()
      : "";
  if (!workspace_id) {
    return jsonError("`workspace_id` is required", 400);
  }

  const supabase = await createSupabaseServerClient();
  const now = new Date().toISOString();
  const expires_at = houseTerminalExpiresAt();

  const { error } = await supabase
    .from("house_terminal")
    .update({ last_ping: now, expires_at, status: "active" })
    .eq("workspace_id", workspace_id);

  if (error) {
    console.warn(
      `[terminal/ping] update failed for ${workspace_id}: ${error.message}`,
    );
    return jsonError("Ping failed. Check server logs.", 500);
  }

  return NextResponse.json({ ok: true, expires_at });
}
