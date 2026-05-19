import { NextResponse, type NextRequest } from "next/server";
import { createInstallationToken } from "@/lib/github-app";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";

// POST /api/github-app/installation-token
//
// Mints a short-lived (~1 hour) installation access token for a
// GitHub App installation that belongs to the calling user. The token
// is what the agent uses to read diffs, post comments, and close PRs;
// it does NOT carry the user's identity or any other permissions.
//
// Request shape (JSON body):
//   { installation_id: <number> }
// Response (200):
//   { token: "ghs_…", expires_at: "2026-…Z" }
// Response (401/403/404):
//   { error: "…" }
//
// Security model:
//   1. The caller must be an authenticated dashboard user (Supabase
//      Auth session). middleware.ts does NOT protect /api/* so we
//      enforce it explicitly here via getUser().
//   2. We then confirm the installation row's user_id matches the
//      caller. RLS on github_app_installations already restricts
//      SELECT to auth.uid()=user_id, so a query that returns NO row
//      means "not yours" (or non-existent) — either way: 404.
//   3. Only after both checks do we hit GitHub. A leaked token would
//      be limited to the caller's own installation anyway, but
//      checking ownership up-front avoids spending an API quota slot
//      on unauthorized callers.
//
// Why not GET: tokens are side-effecting (GitHub records the
// creation, increments rate limits, and ties it to subsequent audit
// log entries). POST is the right verb and also prevents browsers /
// proxies from accidentally caching a credential.

export const dynamic = "force-dynamic";

interface RequestBody {
  installation_id?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  // 1. AuthN — must be a logged-in dashboard user.
  const user = await getUser().catch(() => null);
  if (!user) return jsonError("Not authenticated", 401);

  // Body parse — accept JSON only. Anything else is almost certainly a
  // misconfigured client; respond with a clear error rather than 500.
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Body must be JSON", 400);
  }

  const installationId = Number(body.installation_id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return jsonError("installation_id must be a positive integer", 400);
  }

  // 2. AuthZ — confirm the installation belongs to this user. RLS on
  // github_app_installations restricts SELECT to auth.uid()=user_id,
  // so a missing row is indistinguishable from "not yours" — both
  // map to 404 from the client's perspective. That's intentional:
  // we don't want to leak "this installation exists, just not yours"
  // to a probing caller.
  const supabase = await createSupabaseServerClient();
  const { data: row, error } = await supabase
    .from("github_app_installations")
    .select("installation_id, suspended_at")
    .eq("installation_id", installationId)
    .maybeSingle();

  if (error || !row) {
    return jsonError("Installation not found", 404);
  }
  if (row.suspended_at) {
    return jsonError("Installation is suspended on GitHub", 403);
  }

  // 3. Mint. createInstallationToken throws with a useful message on
  // any GitHub error (App private-key misconfig, installation revoked,
  // rate limit, etc.) — surface that verbatim so operators have
  // something to act on.
  try {
    const token = await createInstallationToken(installationId);
    return NextResponse.json(token, { status: 200 });
  } catch (e) {
    return jsonError((e as Error).message, 502);
  }
}
