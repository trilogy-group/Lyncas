import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";

// GET /api/devpod/token
//
// Mints (well, just composes) the connect token the CLI needs.
// Token shape: `<github_username>:<DEVPOD_CONNECT_SECRET>`.
//
// This is the ONLY route that ever sends DEVPOD_CONNECT_SECRET to a
// browser, and it always sends it server-prefixed by the user's
// GitHub login so the recipient can't forge a token for someone
// else's username (the /register and /ping endpoints both verify
// the prefix matches the claimed username).
//
// Caveat: a malicious user can split their own token to extract
// the bare DEVPOD_CONNECT_SECRET and forge a token for any other
// username on the same deploy. This is the v1 design; per-user
// random secrets is a v2 hardening tracked separately.
//
// Response:
//   { token: "<github_username>:<DEVPOD_CONNECT_SECRET>" }
// or { error } on missing OAuth metadata / missing secret env.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const user = await getUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Prefer the OAuth metadata (`user_name` is GitHub's login per
  // Supabase Auth's GitHub provider), fall back to user_metadata
  // shapes other identity providers might use.
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const ghUsername =
    typeof meta.user_name === "string" && meta.user_name.trim()
      ? meta.user_name.trim()
      : typeof meta.preferred_username === "string" &&
          meta.preferred_username.trim()
        ? meta.preferred_username.trim()
        : null;

  if (!ghUsername) {
    return NextResponse.json(
      {
        error:
          "GitHub username is missing from your Supabase session. Sign in again with GitHub.",
      },
      { status: 400 },
    );
  }

  const secret = process.env.DEVPOD_CONNECT_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "DEVPOD_CONNECT_SECRET is not configured on this deploy. Ask your admin to set it.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    token: `${ghUsername}:${secret}`,
  });
}
