import { Container } from "@/components/ui/container";
import { Skeleton, SkeletonHeading } from "@/components/ui/skeleton";

export default function DocsLoading() {
  return (
    <Container className="py-10 space-y-8">
      <SkeletonHeading />
      <div className="space-y-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton
            key={i}
            className={i % 3 === 0 ? "h-5 w-1/3" : "h-4 w-full"}
          />
        ))}
      </div>
    </Container>
  );
}
