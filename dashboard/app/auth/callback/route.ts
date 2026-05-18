import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// /auth/callback — final hop of every Supabase Auth flow on this app.
// Hit by:
//   * GitHub OAuth   -> ?code=<oauth_code>&next=<path>
//   * Magic-link OTP -> same shape; Supabase encodes both behind a
//                       single `code` exchange call.
//
// What we do:
//   1. Exchange the code for a session (sets cookies via our server
//      Supabase client + the @supabase/ssr cookie adapter).
//   2. Upsert a user_profiles row so downstream pages can look up plan
//      + repo_limit without a second auth call. Upsert is keyed on
//      `id` so re-logins don't blow away GitHub username / avatar.
//   3. Redirect to `next` (the path the user was originally heading
//      for, defaulted by middleware to /dashboard).
//
// On any failure we bounce back to /login with `?error=...` populated
// — the login page renders that string verbatim so the user sees what
// went wrong rather than a stack trace.

export const dynamic = "force-dynamic";

function loginError(request: NextRequest, message: string) {
  const u = request.nextUrl.clone();
  u.pathname = "/login";
  u.search = `?error=${encodeURIComponent(message)}`;
  return NextResponse.redirect(u);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  // Sanitize `next` — only accept same-origin paths, never an
  // attacker-controlled full URL. A leading "/" check is sufficient
  // because Next won't merge a no-host string with another origin.
  const rawNext = searchParams.get("next") || "/dashboard";
  const next = rawNext.startsWith("/") ? rawNext : "/dashboard";

  if (!code) {
    return loginError(request, "Missing auth code");
  }

  const supabase = await createSupabaseServerClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(
    code,
  );
  if (exchangeError) {
    return loginError(request, exchangeError.message);
  }

  // Pull the freshly authenticated user (server-verified via getUser)
  // so we can self-provision a profile row. getUser() round-trips to
  // Supabase Auth, which is the documented way to trust the identity
  // inside a route handler rather than reading cookie-cached state.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    // upsert with onConflict='id' so a repeat login refreshes email
    // / github_username / avatar_url (these change), but leaves
    // plan + repo_limit alone (those change via billing, not login).
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const profileRow = {
      id: user.id,
      email: user.email ?? null,
      github_username:
        (meta.user_name as string | undefined) ??
        (meta.preferred_username as string | undefined) ??
        null,
      display_name:
        (meta.full_name as string | undefined) ??
        (meta.name as string | undefined) ??
        null,
      avatar_url: (meta.avatar_url as string | undefined) ?? null,
    };
    const { error: upsertError } = await supabase
      .from("user_profiles")
      .upsert(profileRow, { onConflict: "id" });
    if (upsertError) {
      // Provisioning failure shouldn't strand the user — they're
      // authenticated, they just don't have a profile yet. The
      // /dashboard pages render with sensible fallbacks for missing
      // profile rows, and the next /auth/callback hit will retry.
      console.error("[auth/callback] profile upsert failed:", upsertError);
    }
  }

  const redirectTo = request.nextUrl.clone();
  redirectTo.pathname = next;
  redirectTo.search = "";
  return NextResponse.redirect(redirectTo);
}
