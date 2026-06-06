import { Container } from "@/components/ui/container";
import { Skeleton, SkeletonHeading } from "@/components/ui/skeleton";

export default function ReposLoading() {
  return (
    <Container className="py-10 space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SkeletonHeading />
        <Skeleton className="h-9 w-44" />
      </div>
      <div className="space-y-2 rounded-md border border-border p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    </Container>
  );
}
