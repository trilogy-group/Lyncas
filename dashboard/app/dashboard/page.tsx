import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// /dashboard is a stub — always bounces to /dashboard/overview which
// is the real landing page for an authenticated session. Lives as a
// page rather than as a config redirect so we can swap the target in
// the future without touching next.config.
export default function DashboardIndex() {
  redirect("/dashboard/overview");
}
