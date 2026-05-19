"use client";

import { motion, type HTMLMotionProps, type Variants } from "framer-motion";
import { clsx } from "clsx";

// Motion primitives. Restraint > razzle-dazzle: the entrance is a soft
// 8px translate + opacity over ~0.45s with the same easing curve used
// in the rest of the app. Anything flashier is overkill on a black
// dashboard.

const EASE = [0.16, 1, 0.3, 1] as const;

const FADE_UP_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: EASE },
  },
};

const STAGGER_VARIANTS: Variants = {
  hidden: { opacity: 1 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.05,
    },
  },
};

interface FadeInProps extends Omit<HTMLMotionProps<"div">, "ref"> {
  delay?: number;
  /** Trigger on scroll into view instead of mount. */
  whenInView?: boolean;
  /** y translate distance in px. Default 8. */
  distance?: number;
}

export function FadeIn({
  delay = 0,
  whenInView = false,
  distance = 8,
  className,
  children,
  ...rest
}: FadeInProps) {
  const initial = { opacity: 0, y: distance };
  const animate = { opacity: 1, y: 0 };
  const transition = { duration: 0.45, ease: EASE, delay };
  const common = { className, ...rest };

  if (whenInView) {
    return (
      <motion.div
        initial={initial}
        whileInView={animate}
        viewport={{ once: true, amount: 0.2 }}
        transition={transition}
        {...common}
      >
        {children}
      </motion.div>
    );
  }
  return (
    <motion.div initial={initial} animate={animate} transition={transition} {...common}>
      {children}
    </motion.div>
  );
}

interface StaggerProps extends Omit<HTMLMotionProps<"div">, "ref" | "variants"> {
  /** Trigger on scroll into view instead of mount. */
  whenInView?: boolean;
}

export function Stagger({
  whenInView = false,
  className,
  children,
  ...rest
}: StaggerProps) {
  const base = {
    variants: STAGGER_VARIANTS,
    initial: "hidden" as const,
    className,
    ...rest,
  };
  if (whenInView) {
    return (
      <motion.div whileInView="show" viewport={{ once: true, amount: 0.2 }} {...base}>
        {children}
      </motion.div>
    );
  }
  return (
    <motion.div animate="show" {...base}>
      {children}
    </motion.div>
  );
}

type StaggerItemProps = Omit<HTMLMotionProps<"div">, "ref" | "variants">;

export function StaggerItem({ className, children, ...rest }: StaggerItemProps) {
  return (
    <motion.div variants={FADE_UP_VARIANTS} className={className} {...rest}>
      {children}
    </motion.div>
  );
}

// MotionCard — Card body wrapped in motion.div with a subtle hover
// lift. Use when a card is interactive / clickable; static cards keep
// using the regular <Card>.
interface MotionCardProps extends Omit<HTMLMotionProps<"div">, "ref"> {
  href?: never; // Use <Link> wrapper instead — keeps a11y simple.
}

export function MotionCard({ className, children, ...rest }: MotionCardProps) {
  return (
    <motion.div
      whileHover={{ y: -2, borderColor: "#3a3a3a" }}
      transition={{ duration: 0.18, ease: EASE }}
      className={clsx(
        "bg-card border border-border rounded-md transition-colors",
        className,
      )}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

// Reveal — split a string into words so each word fades up with a
// subtle stagger. Used for hero h1's. Whitespace is preserved so the
// browser still knows where word breaks are.
export function RevealText({
  text,
  className,
  delay = 0,
}: {
  text: string;
  className?: string;
  delay?: number;
}) {
  const words = text.split(/(\s+)/);
  return (
    <motion.span
      className={clsx("inline-block", className)}
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: {
          transition: { staggerChildren: 0.04, delayChildren: delay },
        },
      }}
    >
      {words.map((w, i) =>
        /^\s+$/.test(w) ? (
          <span key={i}>{w}</span>
        ) : (
          <motion.span
            key={i}
            className="inline-block"
            variants={{
              hidden: { opacity: 0, y: 12 },
              show: {
                opacity: 1,
                y: 0,
                transition: { duration: 0.5, ease: EASE },
              },
            }}
          >
            {w}
          </motion.span>
        ),
      )}
    </motion.span>
  );
}
