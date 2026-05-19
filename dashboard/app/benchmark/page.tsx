import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

// Legacy v1 demo route — disabled.
//
// The Benchmark page exposed a synthetic eval harness aimed at the
// original single-tenant deployment. Multi-tenant doesn't need it on
// the public URL, so the route is 404'd. The directory is kept so a
// future re-enable is a one-file change.
export default function BenchmarkPage(): never {
  notFound();
}
