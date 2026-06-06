import { Container } from "@/components/ui/container";
import { Skeleton, SkeletonHeading } from "@/components/ui/skeleton";

export default function OverviewLoading() {
  return (
    <Container className="py-10 space-y-12">
      <SkeletonHeading />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px]" />
        ))}
      </div>

      {/* By-repo table */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-28" />
        <div className="space-y-2 rounded-md border border-border p-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>

      {/* Recent reviews */}
      <div className="space-y-4">
        <Skeleton className="h-5 w-40" />
        <div className="space-y-2 rounded-md border border-border p-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>

      {/* Charts */}
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    </Container>
  );
}
