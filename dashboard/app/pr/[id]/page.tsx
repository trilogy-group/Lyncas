import { notFound } from "next/navigation";
import Link from "next/link";
import { PrDetail } from "@/components/pr-detail";
import { Container } from "@/components/ui/container";
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

  const humanAction = await getHumanAction(id);

  return (
    <Container size="narrow" className="py-10">
      <div className="mb-6">
        <Link
          href="/"
          className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted hover:text-text"
        >
          ← back to overview
        </Link>
      </div>
      <PrDetail review={review} humanAction={humanAction} />
    </Container>
  );
}
