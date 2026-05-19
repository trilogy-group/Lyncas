import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { PrDetail } from "@/components/pr-detail";
import { Container } from "@/components/ui/container";
import {
  getHumanAction,
  getReviewById,
  getWatchedRepos,
} from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// /pr/[id] — single-review detail page.
//
// Three things have changed since the v1 demo:
//
//   1. Auth boundary. The page used to be anon-readable, so a friend
//      handed the deployed URL could open any review with a guessable
//      UUID. We now bounce unauthenticated requests to /login with a
//      `next` so they end up here after signing in.
//
//   2. Ownership check. After load, we verify the review's repo is in
//      the caller's watched_repos. A miss returns notFound() instead of
//      a 403 so we don't leak the existence of someone else's review.
//
//   3. Resilient fetches. The Supabase calls used to throw on any
//      transient error (network blip, RLS quirk) which Vercel rendered
//      as a "page couldn't load" Chrome error. Each call is now wrapped
//      in try/catch so the worst case is a clean 404.
export default async function PrPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await getUser().catch(() => null);
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/pr/${id}`)}`);
  }

  const review = await getReviewById(id).catch(() => null);
  if (!review) notFound();

  // Ownership: only the user who connected the repo (via the GitHub
  // App or the legacy PAT flow) should be able to view its reviews.
  // A miss is rendered as 404 — same response a logged-in user gets
  // for a UUID that doesn't exist — so we don't fingerprint other
  // users' review IDs.
  const watched = await getWatchedRepos(user.id).catch(() => []);
  if (!watched.some((w) => w.repo === review.repo)) notFound();

  const humanAction = await getHumanAction(id).catch(() => null);

  return (
    <Container size="narrow" className="py-10">
      <div className="mb-6">
        <Link
          href="/dashboard/overview"
          className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted hover:text-text"
        >
          ← back to dashboard
        </Link>
      </div>
      <PrDetail review={review} humanAction={humanAction} />
    </Container>
  );
}
