import type { ReactNode } from "react";
import { LinkButton } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { PricingCheckoutButton } from "@/components/pricing-checkout-button";

export function Pricing() {
  return (
    <section id="pricing" className="border-b border-border">
      <Container className="py-16 sm:py-20">
        <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted mb-8">
          &gt; Hover (↓↓)
        </p>
        <div className="grid gap-px bg-border border border-border md:grid-cols-3">
          <PriceColumn
            tier="Hobby"
            price="Free"
            perks={[
              "Up to 2 connected repositories",
              "Community support",
              "30-day review history",
              "Daily digest email",
            ]}
            cta={{ label: "Start for free", href: "/login" }}
            footnote="(✓) No CC required"
          />
          <PriceColumn
            tier="Pro"
            price="$29"
            priceSuffix="/MO"
            highlight
            perks={[
              "Everything in Hobby",
              "Up to 10 connected repositories",
              "Custom auto-close thresholds",
              "Per-repo style guide upload",
              "Priority webhook queue",
            ]}
            ctaSlot={<PricingCheckoutButton label="Choose Pro" />}
            footnote="($) Payment by Razorpay"
          />
          <PriceColumn
            tier="Enterprise"
            price="Custom"
            perks={[
              "Unlimited repositories",
              "SOC2 / VPC self-host",
              "Custom prompt tuner cadence",
              "SSO / SAML",
              "Dedicated support",
            ]}
            cta={{ label: "Contact us", href: "/landing#book-call" }}
            footnote="($) Custom pricing"
          />
        </div>
      </Container>
    </section>
  );
}

interface PriceColumnProps {
  tier: string;
  price: string;
  priceSuffix?: string;
  perks: string[];
  cta?: { label: string; href: string };
  ctaSlot?: ReactNode;
  footnote: string;
  highlight?: boolean;
}

function PriceColumn({
  tier,
  price,
  priceSuffix,
  perks,
  cta,
  ctaSlot,
  footnote,
  highlight = false,
}: PriceColumnProps) {
  return (
    <div
      className={
        "p-8 flex flex-col gap-5 " +
        (highlight ? "bg-white text-black" : "bg-bg text-text")
      }
    >
      <div>
        <div
          className={
            "text-[10px] font-mono uppercase tracking-[0.18em] " +
            (highlight ? "text-black/60" : "text-muted")
          }
        >
          {tier}
        </div>
        <div className="mt-1 font-mono font-bold text-4xl">
          {price}
          {priceSuffix && (
            <span className="text-base align-top">{priceSuffix}</span>
          )}
        </div>
        <span
          className={
            "inline-block mt-3 text-[10px] font-mono uppercase tracking-[0.18em] px-2 py-0.5 " +
            (highlight
              ? "bg-black/10 text-black"
              : "bg-card border border-border text-muted")
          }
        >
          + Usage costs
        </span>
      </div>
      <ul className="space-y-2 text-sm leading-relaxed flex-1">
        {perks.map((p) => (
          <li key={p} className="flex items-start gap-2">
            <span
              className={
                "shrink-0 mt-[3px] " +
                (highlight ? "text-[#ff8a3d]" : "text-[#ff8a3d]")
              }
              aria-hidden
            >
              ✓
            </span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
      <div>
        {ctaSlot ??
          (cta ? (
            <LinkButton
              href={cta.href}
              size="lg"
              variant={highlight ? "default" : "primary"}
              className={
                highlight
                  ? "w-full !bg-black !text-white !border-black hover:!bg-black/90"
                  : "w-full"
              }
            >
              {cta.label}
            </LinkButton>
          ) : null)}
        <p
          className={
            "mt-3 text-[10px] font-mono uppercase tracking-[0.18em] text-center " +
            (highlight ? "text-black/60" : "text-muted")
          }
        >
          {footnote}
        </p>
      </div>
    </div>
  );
}
