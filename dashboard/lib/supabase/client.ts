"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// Browser-side Supabase client. Reused for both v1 anonymous reads
// (e.g. the /repos/[owner]/[name]/settings page upserts repo_rules
// through the anon RLS policy) and v2 authenticated flows like the
// /login OAuth + magic-link redirects.
//
// We cache the client in a module-level variable because
// createBrowserClient() spins up an internal cookie listener and a
// background token-refresh timer — instantiating a fresh client per
// component would leak both.
let cached: SupabaseClient | null = null;

export function createSupabaseBrowserClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set",
    );
  }
  cached = createBrowserClient(url, anonKey);
  return cached;
}

// One-liner for the "Sign out" button. Clears the local session +
// hard-reloads to the public root so server components re-read the
// (now empty) cookie jar. We use window.location instead of
// router.refresh() because Supabase's signOut clears cookies via the
// document, not the Next router state.
export async function signOut(): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  await supabase.auth.signOut();
  if (typeof window !== "undefined") {
    window.location.href = "/";
  }
}
