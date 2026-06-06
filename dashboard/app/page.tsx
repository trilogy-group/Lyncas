import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";

// Root entry point.
//
// Logged-in  → /dashboard/chat     (the v3 post-login default)
// Logged-out → /landing            (public marketing page)
//
// The v1 demo overview lived here pre-SaaS. On main that still renders,
// so the live demo at lyncas.vercel.app keeps working
// unchanged. On this branch the same content lives at /dashboard/overview
// behind the auth gate; the public demo routes (/repos, /runs, /benchmark,
// /settings, /learning, /pr/[id]) remain accessible without auth so the
// existing demo links still resolve.

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const user = await getUser().catch(() => null);
  redirect(user ? "/dashboard/chat" : "/landing");
}
