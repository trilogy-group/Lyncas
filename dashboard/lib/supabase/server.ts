import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";

// Server-side Supabase client. v2 wires the Next.js `cookies()` jar
// through @supabase/ssr so server components, route handlers, and
// middleware can all share one auth session.
//
// The v1 dashboard had no auth — every page was anonymous. v2 keeps
// that path working (anonymous reads still resolve through the same
// client because the anon key is the fallback identity), while also
// enabling getSession() / getUser() in newer /dashboard/* pages.
//
// Note: `cookies()` returns a Promise in Next 15+ — the @supabase/ssr
// cookie adapter handles that internally as long as we await the jar
// before constructing the client.
export async function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set",
    );
  }

  const cookieStore = await cookies();

  // Server Components cannot mutate cookies — only Route Handlers and
  // Server Actions can. We try to set cookies (so route handlers
  // refresh the session correctly) and swallow the error when a Server
  // Component is the caller. @supabase/ssr documents this pattern.
  const cookieAdapter: CookieMethodsServer = {
    getAll: () => cookieStore.getAll(),
    setAll: (cookiesToSet) => {
      try {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      } catch {
        // Called from a Server Component — the middleware will refresh
        // the cookie on the next request, which is what we want.
      }
    },
  };

  return createServerClient(url, anonKey, { cookies: cookieAdapter });
}

// Convenience for routes/pages that only need "who is logged in?" —
// returns null when there's no session rather than throwing, so guards
// at the top of a page read as one line instead of three.
export async function getSession() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session;
}

// Same shape as getSession() but returns the verified User object via
// `getUser()` (which round-trips to the Supabase Auth server to check
// the JWT) — use this when downstream code is going to use auth.uid()
// in RLS rather than trusting cookie-side state.
//
// Wrapped in React `cache()` so the auth round-trip is deduped within a
// single server render: the /dashboard layout and the page underneath it
// both call getUser(), and without this they'd each hit Supabase Auth,
// adding a needless round-trip to every full page load.
export const getUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});
