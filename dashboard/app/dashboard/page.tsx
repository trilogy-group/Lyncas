import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// /dashboard is a stub — bounces to the v3 post-login default
// /dashboard/chat. Lives as a page rather than a config redirect so we
// can swap the target later without touching next.config.
export default function DashboardIndex() {
  redirect("/dashboard/chat");
}
