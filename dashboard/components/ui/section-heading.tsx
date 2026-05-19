"use client";

import { clsx } from "clsx";
import { motion } from "framer-motion";

// SectionHeading — the H1/subtitle pair at the top of each page.
//
// Typography:
//   * eyebrow: tiny all-caps mono, brackets the page in a section name
//   * title:   large, tight-tracked, hard white
//   * subtitle: muted-strong (not full grey) so it stays readable
//
// Motion:
//   * each row fades up with a small stagger so the page entrance has
//     rhythm without being theatrical.

interface SectionHeadingProps {
  eyebrow?: string;
  title: React.ReactNode;
  /** Optional inline highlight phrase rendered with the inverted mark. */
  highlight?: string;
  subtitle?: React.ReactNode;
  align?: "left" | "center";
  className?: string;
}

const EASE = [0.16, 1, 0.3, 1] as const;

export function SectionHeading({
  eyebrow,
  title,
  highlight,
  subtitle,
  align = "left",
  className,
}: SectionHeadingProps) {
  return (
    <header
      className={clsx(
        "space-y-3",
        align === "center" && "text-center",
        className,
      )}
    >
      {eyebrow && (
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-strong"
        >
          [ {eyebrow} ]
        </motion.p>
      )}
      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.05, ease: EASE }}
        className="text-[28px] sm:text-[34px] font-semibold tracking-[-0.02em] leading-[1.05] text-white"
      >
        {title}
        {highlight && (
          <>
            {" "}
            <span className="headline-mark">{highlight}</span>
          </>
        )}
      </motion.h1>
      {subtitle && (
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.12, ease: EASE }}
          className="text-sm sm:text-base text-muted-strong leading-relaxed max-w-2xl"
        >
          {subtitle}
        </motion.p>
      )}
    </header>
  );
}
