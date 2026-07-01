import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getTerminalSecret,
  houseTerminalExpiresAt,
  isValidWsUrl,
  verifyTerminalSecret,
} from "@/lib/terminal";

// POST /api/terminal/register
//
// Called by agent/terminal_server.py (the "house terminal" running on
// the EC2 box) once it has a Cloudflare tunnel up and its PTY WebSocket
// server is ready. Body:
//
//   {
//     workspace_id: string,   // hostname / LYNCAS_TERMINAL_WORKSPACE_ID
//     label?:       string,   // display label for the dashboard header
//     ws_url:       string,   // https:// tunnel URL (swapped to wss client-side)
//     secret:       string,   // must equal DEVPOD_CONNECT_SECRET
//   }
//
// Auth: shared secret. The runner is trusted org infra (not an end
// user), so a straight equality check against DEVPOD_CONNECT_SECRET is
// the authorization boundary; RLS on house_terminal is permissive so
// the upsert-on-conflict works (see migration 023).
//
// Response: { ok: true, expires_at }

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RegisterBody {
  workspace_id?: unknown;
  label?: unknown;
  ws_url?: unknown;
  secret?: unknown;
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
  if (!isValidWsUrl(body.ws_url)) {
    return jsonError("`ws_url` must be a valid https:// URL", 400);
  }
  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.trim().slice(0, 120)
      : workspace_id;

  const supabase = await createSupabaseServerClient();
  const now = new Date().toISOString();
  const expires_at = houseTerminalExpiresAt();

  const { data, error } = await supabase
    .from("house_terminal")
    .upsert(
      {
        workspace_id,
        label,
        ws_url: body.ws_url as string,
        status: "active",
        last_ping: now,
        expires_at,
      },
      { onConflict: "workspace_id" },
    )
    .select("expires_at")
    .single();

  if (error || !data) {
    console.warn(
      `[terminal/register] upsert failed for ${workspace_id}: ${error?.message ?? "unknown"}`,
    );
    return jsonError("Failed to register terminal. Check server logs.", 500);
  }

  return NextResponse.json({ ok: true, expires_at: data.expires_at });
}
