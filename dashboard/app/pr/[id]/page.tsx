import { notFound } from "next/navigation";
import Link from "next/link";
import { PrDetail } from "@/components/pr-detail";
import { getHumanAction, getReviewById } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function PrPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const review = await getReviewById(id);
  if (!review) notFound();

  // Phase 7: pull the human-verdict row (if any) and pass it into PrDetail.
  // The poller may not have run yet for very recent reviews, which is why
  // humanAction is null-safe everywhere downstream.
  const humanAction = await getHumanAction(id);

  return (
    <main className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-6">
        <Link
          href="/"
          className="text-xs font-mono text-muted hover:text-text"
        >
          ← back to overview
        </Link>
      </div>
      <PrDetail review={review} humanAction={humanAction} />
    </main>
  );
}
