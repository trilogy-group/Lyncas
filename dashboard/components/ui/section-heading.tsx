import { clsx } from "clsx";

// SectionHeading — re-used across dashboard pages for the H1/subtitle
// pair at the top of each page. Keeps title + subtitle vertical rhythm
// consistent.

interface SectionHeadingProps {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  align?: "left" | "center";
  className?: string;
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "left",
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={clsx(
        "space-y-2",
        align === "center" && "text-center",
        className,
      )}
    >
      {eyebrow && (
        <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          {eyebrow}
        </p>
      )}
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight leading-tight">
        {title}
      </h1>
      {subtitle && (
        <p className="text-sm text-muted leading-relaxed">{subtitle}</p>
      )}
    </div>
  );
}
