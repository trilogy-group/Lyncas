import { Container } from "@/components/ui/container";
import { Skeleton, SkeletonHeading } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <Container className="py-10 space-y-8">
      <SkeletonHeading />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-md border border-border p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full max-w-md" />
          <Skeleton className="h-8 w-36" />
        </div>
      ))}
    </Container>
  );
}
