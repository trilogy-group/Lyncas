import { createServerClient } from "@supabase/ssr";

export function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set",
    );
  }
  // v1: public dashboard, no auth. The cookies adapter is required by the
  // createServerClient signature but we never read or write anything.
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: () => {},
    },
  });
}
