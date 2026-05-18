import Link from "next/link";
import { Card } from "@/components/ui/card";

// Public landing page. No auth, no Supabase reads — this renders the
// same on a logged-out user's first visit and on a search-engine
// crawler. Server component so the HTML is static; the only
// interaction is the "Get started free" link.
//
// Aesthetic: matches the rest of the dashboard (same palette, same
// type system, same Card chrome) so the transition from landing → app
// feels like one product, not two.

export const metadata = {
  title: "Night PR Reviewer — AI code review that works while you sleep",
  description:
    "Autonomous PR reviews delivered to GitHub in seconds. Self-learning, per-repo rules, free to start.",
};

interface FeatureProps {
  title: string;
  body: string;
}

function Feature({ title, body }: FeatureProps) {
  return (
    <Card className="p-6 space-y-2 h-full">
      <h3 className="text-base font-semibold text-text">{title}</h3>
      <p className="text-sm text-muted leading-relaxed">{body}</p>
    </Card>
  );
}

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-bg text-text">
      {/* Top bar — minimal: brand on the left, single CTA on the
          right. Mirrors the dashboard nav height so the layout
          shift on transition to /login is zero. */}
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="font-semibold text-sm tracking-tight">
            Night PR Reviewer
          </span>
          <div className="flex items-center gap-4 text-sm">
            <Link
              href="/login"
              className="text-muted hover:text-text transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className="px-3 py-1.5 rounded-md text-white font-medium"
              style={{ backgroundColor: "#4338ca" }}
            >
              Get started free
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-3xl mx-auto px-6 pt-20 pb-12 text-center space-y-5">
        <p className="text-xs font-mono text-muted uppercase tracking-wider">
          Built on Claude Opus
        </p>
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-tight">
          Your AI code reviewer that works while you sleep
        </h1>
        <p className="text-base text-muted max-w-xl mx-auto leading-relaxed">
          Night PR Reviewer reads every open pull request, posts a
          structured review in seconds, and auto-closes the obvious
          bad ones — so your team wakes up to a clean inbox.
        </p>
        <div className="flex items-center justify-center gap-3 pt-2">
          <Link
            href="/login"
            className="px-5 py-2.5 rounded-md text-white font-medium text-sm"
            style={{ backgroundColor: "#4338ca" }}
          >
            Get started free
          </Link>
          <Link
            href="/"
            className="px-5 py-2.5 rounded-md border border-border text-sm font-medium text-text hover:bg-card transition-colors"
          >
            See a live demo
          </Link>
        </div>
        <p className="text-xs text-muted pt-1">
          Free plan includes 2 repositories — no credit card required.
        </p>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-6 py-10">
        <div className="grid md:grid-cols-3 gap-4">
          <Feature
            title="Instant reviews"
            body="PR opens, review lands in ~30 seconds. Webhook-triggered straight from GitHub to a Claude-Opus-powered reviewer."
          />
          <Feature
            title="Self-learning"
            body="The agent watches what you keep, revert, and close — and proposes prompt updates as PRs you can review."
          />
          <Feature
            title="Your rules"
            body="Per-repo path filters, severity thresholds, and custom instructions. Upload your style guide; the reviewer reads it."
          />
        </div>
      </section>

      {/* Secondary CTA */}
      <section className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h2 className="text-2xl font-semibold mb-3">
          Stop reviewing dependabot PRs at 11 PM.
        </h2>
        <p className="text-sm text-muted mb-6">
          Two minutes to set up. Free forever for two repos.
        </p>
        <Link
          href="/login"
          className="inline-block px-5 py-2.5 rounded-md text-white font-medium text-sm"
          style={{ backgroundColor: "#4338ca" }}
        >
          Get started free
        </Link>
      </section>

      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between text-xs text-muted">
          <span>Built on Claude Opus by Harsh Singla at Trilogy</span>
          <Link href="/" className="hover:text-text">
            v1 demo
          </Link>
        </div>
      </footer>
    </main>
  );
}
