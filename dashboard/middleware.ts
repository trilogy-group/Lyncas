import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Next.js middleware. Two jobs:
//   1. Refresh the Supabase Auth session cookie on every protected
//      request. Without this, a user's JWT silently expires mid-session
//      and a SSR page render mysteriously returns null for getUser().
//   2. Guard /dashboard/* — if no session, bounce to /login with a
//      `next` query so we can return them to where they were headed.
//
// Everything else (the public landing, login, callback, the v1 demo
// routes /, /repos, /runs, /benchmark, /settings, /learning, /pr/[id],
// /api/webhook/*) is left untouched. Those pages either don't need
// auth or handle it themselves.
//
// IMPORTANT: matching is done via the `config.matcher` export at the
// bottom so this function isn't even invoked for static asset URLs.

const PROTECTED_PREFIX = "/dashboard";

export async function middleware(request: NextRequest) {
  // Start with a passthrough response. The Supabase SSR cookie adapter
  // needs both `request` and `response` so it can read the incoming
  // cookies AND write refreshed cookies back to the browser.
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // If Supabase env isn't configured we can't do anything useful in
  // middleware — let the request through so the page can throw with a
  // helpful error rather than the middleware swallowing it.
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Mirror Supabase's recommended pattern: write to both the
        // request (so downstream handlers in this same middleware see
        // the updated values) and a fresh response we hand back.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Calling getUser() here serves two purposes: it validates the JWT
  // against Supabase Auth (any invalid token gets refreshed via the
  // cookie callback above) and it gives us the user identity we need
  // for the /dashboard/* guard. Per Supabase SSR docs, NEVER replace
  // this with getSession() in middleware — getSession reads cached
  // cookie state without re-validating, which can let stale tokens
  // through.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  const wantsDashboard = pathname.startsWith(PROTECTED_PREFIX);

  if (wantsDashboard && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    // Preserve the destination so /auth/callback can route back after
    // the user successfully signs in.
    loginUrl.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // Match everything except Next internals + static assets. The
  // protection itself is conditional inside the function; we only need
  // the middleware to RUN broadly so the auth cookie gets refreshed on
  // any page that might read it.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
