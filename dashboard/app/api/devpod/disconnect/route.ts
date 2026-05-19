import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";

// POST /api/devpod/disconnect
//
// Requires Supabase JWT auth. Marks the calling user's session
// row inactive. The CLI may re-register at any time and re-arm the
// row; this endpoint exists so the dashboard's "Disconnect" button
// has somewhere to send a deliberate teardown signal.
//
// Idempotent: always returns 200 even when there's no row to
// update (the user was never connected, or already disconnected).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const user = await getUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("devpod_sessions")
    .update({ status: "inactive" })
    .eq("user_id", user.id);

  if (error) {
    console.warn(
      `[devpod/disconnect] update failed for user_id=${user.id}: ${error.message}`,
    );
    return NextResponse.json(
      { error: "Failed to disconnect session" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
