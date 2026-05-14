import { notFound } from "next/navigation";
import Link from "next/link";
import { PrDetail } from "@/components/pr-detail";
import { getReviewById } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function PrPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const review = await getReviewById(id);
  if (!review) notFound();

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
      <PrDetail review={review} />
    </main>
  );
}
