// "Trusted by" marquee — purely decorative on the landing page,
// matches the same row in the E2B reference. We render text-only
// wordmarks (no third-party SVGs) so we don't have to ship logos for
// brands we don't have permission to display. The two arrays are
// duplicated so the CSS marquee can loop seamlessly.

interface TrustedByProps {
  label?: string;
}

const NAMES = [
  "Hugging Face",
  "PGA of America",
  "Gumloop",
  "Manus",
  "Groq",
  "Lindy",
  "Anthropic",
  "Supabase",
  "Vercel",
];

export function TrustedBy({ label = "Trusted by" }: TrustedByProps) {
  return (
    <div className="space-y-4">
      <p className="text-center text-[10px] font-mono uppercase tracking-[0.22em] text-muted">
        {label}
      </p>
      <div className="overflow-hidden">
        <div className="marquee-row animate-marquee">
          {[...NAMES, ...NAMES].map((name, i) => (
            <span
              key={`${name}-${i}`}
              className="font-semibold text-base text-white/70 hover:text-white transition-colors whitespace-nowrap"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
