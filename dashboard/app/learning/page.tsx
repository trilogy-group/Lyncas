import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

// Legacy v1 demo route — disabled.
//
// The Learning page surfaced global accuracy stats and prompt-tuner
// activity drawn from tables that have no per-user scope. On a
// multi-tenant deployment that means anyone with the URL could read
// every account's correction history, so the route is 404'd. The
// directory is kept so a future re-enable is a one-file change.
export default function LearningPage(): never {
  notFound();
}
