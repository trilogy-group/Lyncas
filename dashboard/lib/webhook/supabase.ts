import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

// Service-role client used only on the server inside the webhook route.
// It must never leak to the browser. Pings the standard `SUPABASE_URL` and
// `SUPABASE_SERVICE_KEY` envs (the dashboard's read-only client uses the
// public NEXT_PUBLIC_ pair).
export function getServiceSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_KEY must be set",
    );
  }
  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
