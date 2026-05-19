import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

// Legacy v1 demo route — disabled.
//
// The Runs page used to read the global `runs` table, which logs every
// agent invocation across all users with no per-user scope. Exposing
// that on a multi-tenant deployment leaked activity across accounts,
// so the route is 404'd until `runs` gets a `user_id` column + RLS.
// The directory is kept so a future re-enable is a one-file change.
export default function RunsPage(): never {
  notFound();
}
