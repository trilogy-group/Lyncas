import { clsx } from "clsx";

// GridBackdrop — decorative blueprint grid + warm glow pinned to the top
// of a page. Render it as the first child of a `position: relative`
// wrapper so it sits behind the content (z-index: -10) and scrolls away
// as the user moves down, fading into the black background.
//
// All visuals live in the `.grid-backdrop` CSS (globals.css). Each
// surface picks a distinct `tone`; `warm` is the default (no modifier
// class), the rest map to `.grid-backdrop--<tone>` glow variants.

type GridTone =
  | "warm"
  | "cool"
  | "cyan"
  | "violet"
  | "emerald"
  | "amber"
  | "fuchsia";

interface GridBackdropProps {
  tone?: GridTone;
  className?: string;
}

export function GridBackdrop({ tone = "warm", className }: GridBackdropProps) {
  return (
    <div
      aria-hidden
      className={clsx(
        "grid-backdrop",
        tone !== "warm" && `grid-backdrop--${tone}`,
        className,
      )}
    />
  );
}
