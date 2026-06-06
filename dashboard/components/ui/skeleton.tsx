import { clsx } from "clsx";

// Skeleton — a single pulsing placeholder block. Used by the per-route
// loading.tsx files so a tab switch paints an instant shell (via the
// route's Suspense boundary) instead of freezing on the previous page
// while the server resolves its dynamic data.
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx("animate-pulse rounded-sm bg-border/40", className)}
      aria-hidden
    />
  );
}

// SkeletonHeading — mirrors the eyebrow / title / subtitle stack of
// <SectionHeading> so the page header doesn't jump when real content
// swaps in.
export function SkeletonHeading() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-2.5 w-24" />
      <Skeleton className="h-8 w-72 max-w-full" />
      <Skeleton className="h-4 w-96 max-w-full" />
    </div>
  );
}
