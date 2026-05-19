import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  DevpodCapabilities,
  DevpodStatusResponse,
} from "@/lib/types";
import { normalizeGithubUsername } from "@/lib/devpod";

// GET /api/devpod/status?username=<github_username>
//
// Public-read endpoint. The chat sidebar polls it every 30s; the
// settings page may also poll it on display. We deliberately don't
// require auth so a tab where the Supabase session has lapsed but
// the user is still in front of the screen still shows the live/
// offline indicator correctly.
//
// Response:
//   {
//     connected: boolean,
//     tunnel_url?: string,
//     workspace_id?: string | null,
//     last_ping?: string,
//     capabilities?: { run_command, run_tests, start_app, expose_port },
//     expires_at?: string
//   }
//
// `connected` is true ONLY if status='active' AND expires_at > now().
// On miss / expired we still return 200 with `connected: false` so
// the client doesn't have to interpret HTTP status codes.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const usernameParam = request.nextUrl.searchParams.get("username") ?? "";
  const github_username = normalizeGithubUsername(usernameParam);
  if (!github_username) {
    return NextResponse.json(
      { error: "`username` query parameter is required" },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("devpod_sessions")
    .select(
      "tunnel_url, workspace_id, status, last_ping, expires_at, capabilities",
    )
    .eq("github_username", github_username)
    .maybeSingle();

  if (error) {
    // RLS / network failures: degrade to "not connected" so the
    // dashboard never displays a misleading green dot.
    console.warn(
      `[devpod/status] read failed for ${github_username}: ${error.message}`,
    );
    const body: DevpodStatusResponse = { connected: false };
    return NextResponse.json(body);
  }

  if (!data) {
    const body: DevpodStatusResponse = { connected: false };
    return NextResponse.json(body);
  }

  // Liveness check. The CLI pings every 30 min and refreshes
  // expires_at by 8h on each ping; a row that's status='active' but
  // past expires_at is a CLI that crashed without unregistering.
  const expiresMs = Date.parse(data.expires_at);
  const live =
    data.status === "active" &&
    Number.isFinite(expiresMs) &&
    expiresMs > Date.now();

  if (!live) {
    const body: DevpodStatusResponse = { connected: false };
    return NextResponse.json(body);
  }

  const body: DevpodStatusResponse = {
    connected: true,
    tunnel_url: data.tunnel_url,
    workspace_id: data.workspace_id ?? null,
    last_ping: data.last_ping,
    capabilities: data.capabilities as DevpodCapabilities,
    expires_at: data.expires_at,
  };
  return NextResponse.json(body);
}
