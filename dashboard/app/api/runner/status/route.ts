import { NextResponse } from "next/server";
import { createSupabaseServerClient, getUser } from "@/lib/supabase/server";

// GET /api/runner/status
//
// Unified "what can I run a PR deploy on right now?" check. Used by the
// DeployPrCard to decide the launch path:
//   * house terminal (EC2) online  -> run live in the Terminal tab
//   * else DevPod online           -> fall back to the sandbox card
//   * else                         -> nothing connected
//
// Auth: Supabase JWT. The house terminal is org-wide (keyed by most
// recent ping); the DevPod session is per-user (keyed by user_id), the
// same way /api/devpod/run-pr-tests resolves its target.
//
// Response:
//   {
//     house:   { connected: boolean, label: string | null },
//     devpod:  { connected: boolean },
//     preferred: "house" | "devpod" | null
//   }

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isLive(row: { status?: string | null; expires_at?: string | null } | null): boolean {
  if (!row) return false;
  const ms = Date.parse(row.expires_at ?? "");
  return row.status === "active" && Number.isFinite(ms) && ms > Date.now();
}

export async function GET() {
  const user = await getUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();

  const [houseRes, devpodRes] = await Promise.all([
    supabase
      .from("house_terminal")
      .select("label, status, expires_at")
      .order("last_ping", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("devpod_sessions")
      .select("status, expires_at")
      .eq("user_id", user.id)
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const houseLive = isLive(houseRes.data);
  const devpodLive = isLive(devpodRes.data);

  return NextResponse.json({
    house: {
      connected: houseLive,
      label: houseLive ? (houseRes.data?.label ?? null) : null,
    },
    devpod: { connected: devpodLive },
    preferred: houseLive ? "house" : devpodLive ? "devpod" : null,
  });
}
