import Link from "next/link";
import { Footer } from "@/components/footer";
import { MarketingNav } from "@/components/marketing-nav";
import { TrustedBy } from "@/components/trusted-by";
import { LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { TerminalWindow } from "@/components/ui/terminal-window";
import { Pricing } from "@/components/pricing";

// Public landing page — pure server component, no client JS beyond
// what next/link bundles. The layout structure mirrors the E2B
// reference: hero with two stacked button rows, trusted-by marquee,
// three decorative "terminal windows", a feature grid, a pricing
// table, a CTA section, then the footer.
//
// Aesthetic: pure-black bg, white text, monospace headers, square
// hairline borders. Buttons follow the inverted contract (primary =
// white-on-black, default = transparent w/ white border).

export const metadata = {
  title: "Night PR Reviewer — AI code review that works while you sleep",
  description:
    "Autonomous PR reviews delivered to GitHub in seconds. Self-learning, per-repo rules, free to start.",
};

export default function LandingPage() {
  return (
    <main className="min-h-screen flex flex-col bg-bg text-text">
      <MarketingNav />

      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                              */}
      {/* ---------------------------------------------------------------- */}
      <section
        id="product"
        className="relative overflow-hidden border-b border-border dot-grid"
      >
        <Container className="relative py-20 sm:py-28">
          <div className="space-y-7 text-center max-w-4xl mx-auto">
            <div className="inline-flex items-center gap-3 animate-fade-up">
              <span className="bg-[#ff8a3d] text-black px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em]">
                NEW
              </span>
              <Link
                href="#pricing"
                className="text-[11px] font-mono uppercase tracking-[0.18em] underline underline-offset-[6px] decoration-text/40 hover:decoration-text"
              >
                Join Startups Program
              </Link>
            </div>

            <h1 className="font-mono font-bold leading-[0.95] tracking-tight text-[42px] sm:text-[72px] lg:text-[88px] animate-fade-up-1">
              <span className="block uppercase">AI CODE REVIEW</span>
              <span className="block bg-white text-black inline-block px-3 uppercase mt-2">
                THAT WORKS WHILE YOU SLEEP
              </span>
            </h1>

            <p className="text-base sm:text-lg text-muted-strong leading-relaxed max-w-2xl mx-auto animate-fade-up-2">
              Open-source autonomous reviewer that reads every pull request,
              <br className="hidden sm:inline" />
              posts a structured review in seconds, and auto-closes the
              obvious bad ones.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-4 animate-fade-up-3">
              <LinkButton href="/login" size="lg" variant="primary">
                Start for free
              </LinkButton>
              <LinkButton href="/" size="lg" variant="default">
                View live demo
              </LinkButton>
            </div>
          </div>

          <div className="mt-16 animate-fade-up-4">
            <TrustedBy />
          </div>

          {/* Decorative terminal-window trio echoing the reference. */}
          <div className="mt-16 grid gap-4 md:grid-cols-3">
            <TerminalWindow
              title="LLM"
              className="animate-fade-up-2 hidden md:block"
            >
              <pre className="font-mono text-[11px] leading-relaxed text-muted whitespace-pre">
{`[.500] [.211] [.817] [.829]
       [.013] [.070] [.195]
[.542] [.510] [.353] [.245]
[.704] [.718]   ✦   [.891]
[.285] [.621]   ✧   [.454]
[.717] [.223] [.145] [.459]
[.598] [.124] [.984] [.597]`}
              </pre>
            </TerminalWindow>

            <TerminalWindow
              title="Night-PR Sandbox"
              hint="RUNNING REVIEW…"
              className="animate-fade-up-3"
              bodyClassName="min-h-[160px] flex items-center justify-center"
            >
              <pre className="font-mono text-[11px] leading-relaxed text-severity-clean whitespace-pre text-center">
{`        ✦
      ✦ ✦ ✦
        ✦
    ✦ ✦   ✦ ✦
        ✦
      ✦ ✦ ✦
        ✦`}
              </pre>
            </TerminalWindow>

            <TerminalWindow
              title="Output"
              className="animate-fade-up-4 hidden md:block"
            >
              <pre className="font-mono text-[11px] leading-relaxed whitespace-pre">
                <span className="text-muted">8 │ </span>
                <span className="text-text">verdict: approve</span>
                {"\n"}
                <span className="text-muted">7 │ </span>
                <span className="text-text">severity: 2/10</span>
                {"\n"}
                <span className="text-muted">6 │ </span>
                <span className="text-text">bugs: 0</span>
                {"\n"}
                <span className="text-muted">5 │ </span>
                <span className="text-[#ff8a3d]">@@@@@@</span>
                {"\n"}
                <span className="text-muted">4 │ </span>
                <span className="text-[#ff8a3d]">@@@@</span>
                {"\n"}
                <span className="text-muted">3 │ </span>
                <span className="text-[#ff8a3d]">@@@</span>
                {"\n"}
                <span className="text-muted">2 │ </span>
                <span className="text-[#ff8a3d]">@@</span>
                {"\n"}
                <span className="text-muted">1 │ </span>
                <span className="text-[#ff8a3d]">@</span>
              </pre>
            </TerminalWindow>
          </div>
        </Container>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Feature grid                                                     */}
      {/* ---------------------------------------------------------------- */}
      <section id="features" className="border-b border-border">
        <Container className="py-16 sm:py-20">
          <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-muted mb-8">
            &gt; Hover (↓↓)
          </p>
          <div className="grid gap-px bg-border border border-border md:grid-cols-3">
            <FeatureTile
              icon={<TileIconBox />}
              title="Instant reviews"
              body="PR opens, review lands in ~30 seconds. Webhook-triggered straight from GitHub to a Claude-Opus-powered reviewer."
            />
            <FeatureTile
              icon={<TileIconAt />}
              title="Repo-aware context"
              body="The agent fingerprints your repo: directory tree, recent diffs, style. Reviews quote your own conventions back at you."
            />
            <FeatureTile
              icon={<TileIconCode />}
              title="Per-repo rules"
              body="Path filters, severity thresholds, custom instructions. Upload your style guide and the reviewer reads it."
            />
            <FeatureTile
              icon={<TileIconWindow />}
              title="Self-learning"
              body="The agent watches what you keep, revert, and close — then proposes prompt updates as PRs you can review."
            />
            <FeatureTile
              icon={<TileIconChart />}
              title="Three-gate auto-close"
              body="Closes a PR only on high-confidence, high-severity, request-changes verdicts. Defaults are conservative and explicit."
            />
            <FeatureTile
              icon={<TileIconCursor />}
              title="Open source"
              body="Python + LangGraph agent, Next.js dashboard, Postgres on Supabase. Self-host, fork, or pay nothing and run the demo."
            />
          </div>

          <div className="mt-12 text-center space-y-4">
            <h3 className="text-base font-semibold">
              Read about how teams ship Night PR Reviewer
            </h3>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <LinkButton href="/login" size="md" variant="primary">
                Try it on your repo
              </LinkButton>
              <Link
                href="https://github.com/HarshBti1805/night-pr-reviewer"
                className="text-[11px] font-mono uppercase tracking-[0.18em] underline underline-offset-[6px] hover:text-text"
              >
                Read the source →
              </Link>
            </div>
          </div>
        </Container>
      </section>

      <Pricing />

      {/* ---------------------------------------------------------------- */}
      {/* Stats / CTA                                                      */}
      {/* ---------------------------------------------------------------- */}
      <section id="book-call" className="border-b border-border dot-grid">
        <Container className="py-20 text-center">
          <Link
            href="/login"
            className="text-[11px] font-mono uppercase tracking-[0.22em] underline underline-offset-[6px] hover:text-text"
          >
            Book a 30-min call today
          </Link>
          <h2 className="mt-6 font-mono font-bold uppercase tracking-tight text-[36px] sm:text-[60px] leading-[0.95]">
            Build secure AI agents
            <br />
            at scale with Night PR
          </h2>
          <p className="mt-6 text-base text-muted-strong max-w-2xl mx-auto leading-relaxed">
            Open-source autonomous reviewer purpose-built for shipping teams.
            Rapidly deploy, securely manage, and seamlessly scale every PR
            review — just like top engineering orgs.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 items-center justify-center">
            <LinkButton href="/login" size="lg" variant="primary">
              Get started
            </LinkButton>
            <LinkButton href="/" size="lg" variant="default">
              View live demo
            </LinkButton>
          </div>

          <div className="mt-14">
            <TrustedBy label="Trusted by" />
          </div>

          <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-px bg-border border border-border">
            <StatTile
              value="<30s"
              label="Median review latency"
            />
            <StatTile
              value="1M+"
              label="LOC reviewed monthly"
            />
            <StatTile value="3 gates" label="Before any auto-close" />
          </div>
        </Container>
      </section>

      <Footer />
    </main>
  );
}

/* -------------------------------------------------------------------- */
/* Internal building blocks                                              */
/* -------------------------------------------------------------------- */

interface FeatureTileProps {
  icon: React.ReactNode;
  title: string;
  body: string;
}

function FeatureTile({ icon, title, body }: FeatureTileProps) {
  return (
    <Card flush hover className="border-0 bg-bg p-8 text-center group">
      <div className="flex justify-center mb-6 text-text">{icon}</div>
      <h3 className="text-base font-semibold mb-2">{title}</h3>
      <p className="text-sm text-muted leading-relaxed max-w-[260px] mx-auto">
        {body}
      </p>
      <div className="mt-5">
        <span className="inline-block px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.18em] text-muted border border-border group-hover:text-text group-hover:border-border-strong transition-colors">
          Learn more
        </span>
      </div>
    </Card>
  );
}


function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-bg py-10 px-6 text-center">
      <div className="font-mono text-4xl font-bold tabular-nums">{value}</div>
      <div className="mt-2 text-[11px] font-mono uppercase tracking-[0.18em] text-muted">
        {label}
      </div>
    </div>
  );
}

/* Small icon set — all decorative, all currentColor SVGs. */

function TileIconBox() {
  return (
    <svg viewBox="0 0 40 40" width={56} height={56} fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="4" y="6" width="32" height="28" />
      <line x1="4" y1="10" x2="36" y2="10" />
      <line x1="6" y1="8" x2="8" y2="8" />
    </svg>
  );
}
function TileIconAt() {
  return (
    <svg viewBox="0 0 40 40" width={56} height={56} fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="4" y="6" width="32" height="28" />
      <text x="11" y="24" fontFamily="monospace" fontSize="9" fill="currentColor" stroke="none">@@@</text>
      <text x="11" y="32" fontFamily="monospace" fontSize="9" fill="currentColor" stroke="none">@@</text>
    </svg>
  );
}
function TileIconCode() {
  return (
    <svg viewBox="0 0 40 40" width={56} height={56} fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="4" y="6" width="32" height="28" />
      <polyline points="12,18 8,22 12,26" />
      <polyline points="20,18 24,22 20,26" />
      <line x1="16" y1="28" x2="22" y2="14" />
    </svg>
  );
}
function TileIconWindow() {
  return (
    <svg viewBox="0 0 40 40" width={56} height={56} fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="4" y="6" width="32" height="28" />
      <rect x="10" y="14" width="20" height="14" />
    </svg>
  );
}
function TileIconChart() {
  return (
    <svg viewBox="0 0 40 40" width={56} height={56} fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="4" y="6" width="32" height="28" />
      <rect x="10" y="22" width="3" height="6" fill="currentColor" />
      <rect x="16" y="18" width="3" height="10" fill="currentColor" />
      <rect x="22" y="14" width="3" height="14" fill="currentColor" />
      <rect x="28" y="20" width="3" height="8" fill="currentColor" />
    </svg>
  );
}
function TileIconCursor() {
  return (
    <svg viewBox="0 0 40 40" width={56} height={56} fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="4" y="6" width="32" height="28" />
      <polyline points="14,14 14,26 17,23 19,28 21,27 19,22 23,22" />
    </svg>
  );
}
