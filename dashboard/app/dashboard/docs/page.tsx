"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { TerminalWindow } from "@/components/ui/terminal-window";
import { severityColors, verdictColors } from "@/lib/design";

// /dashboard/docs — the in-app documentation surface.
//
// A self-contained, scroll-spy'd reference for the whole product:
// what Lyncas is, the review pipeline, a tour of every dashboard
// screen, how to read a verdict, the three-gate auto-close, per-repo
// config, and the self-learning loop. Pure client component so the
// sticky TOC can highlight the section in view; no data fetching.
//
// Aesthetic mirrors the landing page: mono eyebrows, hairline-divided
// grids, the terminal-window motif, dotted-grid hero, and the verdict /
// severity semantic accents as the only color.

const EASE = [0.16, 1, 0.3, 1] as const;

interface SectionSpec {
  id: string;
  label: string;
}

const SECTIONS: SectionSpec[] = [
  { id: "introduction", label: "Introduction" },
  { id: "how-it-works", label: "How it works" },
  { id: "quickstart", label: "Quickstart" },
  { id: "chat", label: "Chat workspace" },
  { id: "overview", label: "Overview & analytics" },
  { id: "repos", label: "Repositories" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
  { id: "reviews", label: "Reading a review" },
  { id: "auto-close", label: "Three-gate auto-close" },
  { id: "configuration", label: "Per-repo config" },
  { id: "self-learning", label: "Self-learning" },
  { id: "faq", label: "FAQ" },
];

export default function DocsPage() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  // Scroll-spy: highlight the TOC entry whose section is nearest the
  // top of the viewport. rootMargin biases the "active" line toward the
  // upper third so a section lights up as it scrolls into reading range.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -65% 0px", threshold: 0 },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div className="bg-noise">
      {/* ----------------------------------------------------------- */}
      {/* Hero                                                         */}
      {/* ----------------------------------------------------------- */}
      <section className="relative overflow-hidden border-b border-border dot-grid">
        <Container size="wide" className="relative py-14 sm:py-20">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="max-w-3xl space-y-5"
          >
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-strong">
              [ Documentation ]
            </p>
            <h1 className="font-mono font-bold tracking-tight leading-[0.98] text-[40px] sm:text-[58px]">
              <span className="block uppercase">How to use</span>
              <span className="mt-2 inline-block bg-white px-3 uppercase text-black">
                Lyncas
              </span>
            </h1>
            <p className="text-sm sm:text-base text-muted-strong leading-relaxed">
              Lyncas is an autonomous GitHub PR-reviewing agent. Connect a
              repository, open a pull request, and a Claude-Opus-powered
              reviewer posts a structured verdict in seconds — then learns
              from what you keep, revert, and close. This guide walks through
              every surface of the product and how to drive it.
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <LinkButton href="/dashboard/repos" variant="primary" size="md">
                Connect a repo
              </LinkButton>
              <LinkButton href="/dashboard/chat" variant="default" size="md">
                Open the chat
              </LinkButton>
            </div>
          </motion.div>
        </Container>
      </section>

      {/* ----------------------------------------------------------- */}
      {/* Body — sticky TOC + content                                  */}
      {/* ----------------------------------------------------------- */}
      <Container size="wide" className="py-12">
        <div className="grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)]">
          {/* TOC ---------------------------------------------------- */}
          <aside className="hidden lg:block">
            <nav className="sticky top-20 space-y-1">
              <p className="px-3 pb-3 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
                On this page
              </p>
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className={
                    "block rounded-sm border-l-2 px-3 py-1.5 text-[12px] font-mono uppercase tracking-[0.1em] transition-colors " +
                    (active === s.id
                      ? "border-white bg-bg-elev text-white"
                      : "border-transparent text-muted hover:text-white")
                  }
                >
                  {s.label}
                </a>
              ))}
            </nav>
          </aside>

          {/* Content ------------------------------------------------ */}
          <article className="min-w-0 max-w-3xl space-y-20">
            <Introduction />
            <HowItWorks />
            <Quickstart />
            <ChatSection />
            <OverviewSection />
            <ReposSection />
            <ReportsSection />
            <SettingsSection />
            <ReviewsSection />
            <AutoCloseSection />
            <ConfigurationSection />
            <SelfLearningSection />
            <FaqSection />
          </article>
        </div>
      </Container>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section primitives                                                  */
/* ------------------------------------------------------------------ */

function DocSection({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 space-y-5">
      <header className="space-y-2">
        <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted">
          &gt; {eyebrow}
        </p>
        <h2 className="text-2xl sm:text-[28px] font-semibold tracking-[-0.02em] text-white">
          {title}
        </h2>
      </header>
      <div className="space-y-4 text-sm leading-relaxed text-muted-strong">
        {children}
      </div>
    </section>
  );
}

function Lead({ children }: { children: React.ReactNode }) {
  return <p className="text-base text-text-soft leading-relaxed">{children}</p>;
}

function FeatureGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
      {children}
    </div>
  );
}

function FeatureCell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg p-5">
      <h4 className="mb-1.5 text-sm font-semibold text-white">{title}</h4>
      <p className="text-[13px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border bg-card font-mono text-sm font-bold tabular-nums text-white">
        {n}
      </div>
      <div className="space-y-1 pt-0.5">
        <h4 className="text-sm font-semibold text-white">{title}</h4>
        <p className="text-[13px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}

function ScreenLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted underline underline-offset-[5px] decoration-white/30 transition-colors hover:text-white hover:decoration-white"
    >
      {label} →
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

function Introduction() {
  return (
    <DocSection id="introduction" eyebrow="Introduction" title="What is Lyncas?">
      <Lead>
        Lyncas reads every pull request on the repositories you connect and
        posts a structured, opinionated review straight to GitHub — usually in
        under 30 seconds. It catches bugs, flags risky changes, scores
        severity, and (only when you opt in) auto-closes the clearly bad ones.
      </Lead>
      <p>
        Unlike a static linter, Lyncas fingerprints your repository — its
        directory tree, recent diffs, and coding conventions — so its reviews
        quote your own patterns back at you. It also closes the loop: it watches
        which of its calls you accept and which you override, then proposes
        updates to its own review prompt as pull requests you approve.
      </p>
      <FeatureGrid>
        <FeatureCell title="Instant reviews">
          A PR opens, a webhook fires, and a structured review lands on the PR
          in seconds. No queue, no manual trigger.
        </FeatureCell>
        <FeatureCell title="Repo-aware context">
          The agent reads the shape of your codebase before it judges a diff, so
          feedback is grounded in your conventions.
        </FeatureCell>
        <FeatureCell title="Conservative by default">
          Auto-close is off until you enable it, and even then sits behind three
          independent gates. Nothing destructive happens silently.
        </FeatureCell>
        <FeatureCell title="Self-improving">
          Ground-truth from your follow-up actions feeds a weekly tuner that
          opens PRs proposing prompt edits — which you review like any other.
        </FeatureCell>
      </FeatureGrid>
    </DocSection>
  );
}

function HowItWorks() {
  return (
    <DocSection
      id="how-it-works"
      eyebrow="Architecture"
      title="How a review happens"
    >
      <Lead>
        Every review runs in the same place — a GitHub Actions job — so there is
        only ever one prompt, one parser, and one set of rules. The dashboard
        reads the results; it never runs a review itself.
      </Lead>

      <TerminalWindow title="Review pipeline" hint="EVENT → VERDICT">
        <pre className="overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed text-muted-strong">
{`PR opened / synchronized
        │
        ▼
GitHub webhook ──► Vercel function (verify HMAC, dispatch only)
        │
        ▼
GitHub Actions job  ──►  Python agent (pr_reviewer.py)
        │
        ▼
LangGraph pipeline:
   repo-context ─► reviewer ─► critic ─► [arbiter] ─► final
        │
        ▼
Structured review comment posted to the PR
        │
        ├─► (optional) auto-close behind 3 gates
        └─► row written to Postgres ──► this dashboard`}
        </pre>
      </TerminalWindow>

      <div className="space-y-5">
        <Step n={1} title="Trigger">
          A push or pull-request event hits a lightweight webhook. It verifies
          the signature and dispatches the workflow — nothing more. The webhook
          never fetches a diff or calls a model.
        </Step>
        <Step n={2} title="Context">
          The agent clones and fingerprints the repo: directory tree, recent
          changes, and style signals become a context block the reviewer reads
          before the diff.
        </Step>
        <Step n={3} title="Review & critique">
          A multi-node pipeline runs the reviewer, then a critic challenges it.
          On disagreement an arbiter breaks the tie, producing a single verdict,
          severity score, and bug list.
        </Step>
        <Step n={4} title="Deliver">
          The verdict is posted as a structured comment on the PR, the result is
          stored, and — only if all gates pass — the PR may be auto-closed.
        </Step>
      </div>
    </DocSection>
  );
}

function Quickstart() {
  return (
    <DocSection id="quickstart" eyebrow="Get started" title="Quickstart">
      <Lead>Three steps from zero to your first automated review.</Lead>
      <div className="space-y-5">
        <Step n={1} title="Connect a repository">
          Head to{" "}
          <ScreenLink href="/dashboard/repos" label="Repos" /> and install the
          GitHub App on the repositories you want reviewed. Each connected repo
          shows up with an active / paused status pill.
        </Step>
        <Step n={2} title="Open a pull request">
          Push a branch and open a PR as you normally would. The webhook fires
          automatically — there is nothing to run by hand. Within seconds a
          review comment appears on the PR.
        </Step>
        <Step n={3} title="Watch it land in the dashboard">
          The same review shows up under{" "}
          <ScreenLink href="/dashboard/overview" label="Overview" /> and{" "}
          <ScreenLink href="/dashboard/reports" label="Reports" />. From there
          you can tune per-repo behavior, set notification preferences, and chat
          with the agent about any repo.
        </Step>
      </div>
      <Card className="p-5">
        <p className="text-[13px] leading-relaxed text-muted">
          <span className="font-mono uppercase tracking-[0.12em] text-white">
            Tip ·{" "}
          </span>
          Auto-close stays off until you explicitly enable it per repository.
          Until then, Lyncas only ever comments — it never closes a PR. See{" "}
          <a
            href="#auto-close"
            className="text-white underline underline-offset-[4px] decoration-white/40 hover:decoration-white"
          >
            Three-gate auto-close
          </a>
          .
        </p>
      </Card>
    </DocSection>
  );
}

function ChatSection() {
  return (
    <DocSection
      id="chat"
      eyebrow="Workspace"
      title="Chat — your repo-aware copilot"
    >
      <Lead>
        The flagship screen and your post-login home. A three-column workspace
        for asking the agent anything about a connected repository — its open
        PRs, its structure, a specific file, or a proposed change.
      </Lead>
      <FeatureGrid>
        <FeatureCell title="Left rail — context">
          Pick the active repository, fire quick actions (review a PR, summarize
          changes, run a check), watch agent / sandbox connection status, and
          browse the project file tree.
        </FeatureCell>
        <FeatureCell title="Center — conversation">
          A markdown-rich chat feed with code blocks, tables, and verdict
          badges, plus a composer. Sandbox test results render as their own
          cards inline.
        </FeatureCell>
        <FeatureCell title="Right rail — insights">
          Repository research and live stats: open PRs, stars, last commit,
          contributors, and language breakdown for the selected repo.
        </FeatureCell>
        <FeatureCell title="Responsive">
          On tablet the right rail collapses to a drawer; on mobile the chat is
          primary and both rails slide in on demand.
        </FeatureCell>
      </FeatureGrid>
      <p>
        <ScreenLink href="/dashboard/chat" label="Open the chat workspace" />
      </p>
    </DocSection>
  );
}

function OverviewSection() {
  return (
    <DocSection
      id="overview"
      eyebrow="Analytics"
      title="Overview — everything the agent has seen"
    >
      <Lead>
        A live analytics dashboard across every connected repository: KPI cards,
        trend charts, a per-repo summary, and a filterable, sortable, paginated
        table of recent reviews.
      </Lead>
      <FeatureGrid>
        <FeatureCell title="KPI cards">
          Total reviews, auto-closed count, average severity (30d), estimated
          model cost (30d), and the agent&apos;s accuracy against your follow-up
          actions.
        </FeatureCell>
        <FeatureCell title="Trend charts">
          Reviews-per-day activity over the last 30 days alongside a severity
          distribution histogram (1–3 / 4–6 / 7–8 / 9–10).
        </FeatureCell>
        <FeatureCell title="By repo">
          A compact table of reviews, closes, and average severity per
          repository — click a repo to filter the whole view to it.
        </FeatureCell>
        <FeatureCell title="Recent reviews">
          Filter by repo, verdict, action, and severity range; sort by date or
          severity; page through the full history.
        </FeatureCell>
      </FeatureGrid>
      <p>
        <ScreenLink href="/dashboard/overview" label="Open the overview" />
      </p>
    </DocSection>
  );
}

function ReposSection() {
  return (
    <DocSection
      id="repos"
      eyebrow="Connections"
      title="Repos — what the agent watches"
    >
      <Lead>
        Your connected GitHub repositories, each with a status pill, a connected
        date, and a configure affordance. This is where you add repositories and
        jump into per-repo settings.
      </Lead>
      <ul className="space-y-2">
        <Bullet>
          <strong className="text-white">Add repos via GitHub</strong> installs
          the GitHub App and grants Lyncas read access to the diff and write
          access to post a comment.
        </Bullet>
        <Bullet>
          <strong className="text-white">Active / paused</strong> controls
          whether new PRs on a repo are reviewed without disconnecting it.
        </Bullet>
        <Bullet>
          <strong className="text-white">Configure</strong> opens that
          repository&apos;s dedicated settings — see{" "}
          <a
            href="#configuration"
            className="text-white underline underline-offset-[4px] decoration-white/40 hover:decoration-white"
          >
            Per-repo config
          </a>
          .
        </Bullet>
      </ul>
      <p>
        <ScreenLink href="/dashboard/repos" label="Open repos" />
      </p>
    </DocSection>
  );
}

function ReportsSection() {
  return (
    <DocSection
      id="reports"
      eyebrow="Synthesis"
      title="Reports — per-PR analysis"
    >
      <Lead>
        A higher-level synthesis on top of the raw reviews: each pull request
        rolled up into an expandable report, grouped by merge recommendation.
      </Lead>
      <FeatureGrid>
        <FeatureCell title="Grouped by recommendation">
          Reports are bucketed into merge, request-changes, reject, and
          needs-review — each group header carries its verdict accent.
        </FeatureCell>
        <FeatureCell title="Expandable cards">
          Every card shows PR metadata, an analysis summary, and status counts
          (e.g. bugs vs. nits). Expand for the full write-up.
        </FeatureCell>
        <FeatureCell title="Copy & download">
          Lift a report out of the dashboard to paste into a ticket, a Slack
          thread, or a release note.
        </FeatureCell>
        <FeatureCell title="Empty state">
          Before any PRs have been analyzed the screen prompts you to install
          the GitHub App and open your first PR.
        </FeatureCell>
      </FeatureGrid>
      <p>
        <ScreenLink href="/dashboard/reports" label="Open reports" />
      </p>
    </DocSection>
  );
}

function SettingsSection() {
  return (
    <DocSection id="settings" eyebrow="Account" title="Settings">
      <Lead>
        Account-level preferences that apply across all your repositories.
      </Lead>
      <ul className="space-y-2">
        <Bullet>
          <strong className="text-white">Digest email</strong> — set the address
          for the daily review digest, then verify it with a 6-digit code. A
          status indicator shows verified / unverified at a glance.
        </Bullet>
        <Bullet>
          <strong className="text-white">Sandbox / dev environment</strong> —
          connection status and configuration for the environment the agent uses
          to run checks.
        </Bullet>
        <Bullet>
          <strong className="text-white">Per-repo behavior</strong> lives on each
          repository, not here — Settings links you out to the relevant repo.
        </Bullet>
      </ul>
      <p>
        <ScreenLink href="/dashboard/settings" label="Open settings" />
      </p>
    </DocSection>
  );
}

function ReviewsSection() {
  return (
    <DocSection
      id="reviews"
      eyebrow="Reference"
      title="Reading a review"
    >
      <Lead>
        Every review resolves to one verdict and a severity score from 1 to 10.
        Those two values drive the badges, the colors, and the auto-close gate.
      </Lead>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-white">Verdicts</h4>
        <div className="flex flex-wrap gap-2">
          <Badge color={verdictColors.approve} variant="subtle">
            ✓ approve
          </Badge>
          <Badge color={verdictColors.request_changes} variant="subtle">
            ✕ request changes
          </Badge>
          <Badge color={verdictColors.comment} variant="subtle">
            💬 comment
          </Badge>
        </div>
        <ul className="space-y-2">
          <Bullet>
            <strong className="text-white">approve</strong> — the change is safe
            to merge; no blocking issues found.
          </Bullet>
          <Bullet>
            <strong className="text-white">request changes</strong> — there are
            issues that should be addressed before merging.
          </Bullet>
          <Bullet>
            <strong className="text-white">comment</strong> — observations or
            nits, but nothing the agent considers blocking.
          </Bullet>
        </ul>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-white">Severity scale</h4>
        <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
          <SeverityCell range="1–3" label="Clean" color={severityColors.clean} />
          <SeverityCell
            range="4–6"
            label="Moderate"
            color={severityColors.moderate}
          />
          <SeverityCell
            range="7–8"
            label="Serious"
            color={severityColors.serious}
          />
          <SeverityCell
            range="9–10"
            label="Critical"
            color={severityColors.critical}
          />
        </div>
        <p className="text-[13px] text-muted">
          Severity is independent of the verdict: a low-severity{" "}
          <em className="text-white not-italic">request changes</em> is a nit
          worth fixing, while a 9–10 is the kind of issue the auto-close gate is
          built around.
        </p>
      </div>
    </DocSection>
  );
}

function AutoCloseSection() {
  return (
    <DocSection
      id="auto-close"
      eyebrow="Safety"
      title="The three-gate auto-close"
    >
      <Lead>
        Lyncas can close a pull request automatically — but only when all three
        of the following are true at once, and only after you have explicitly
        enabled auto-close for that repository.
      </Lead>

      <div className="grid gap-px border border-border bg-border sm:grid-cols-3">
        <GateCell
          gate="Verdict"
          value="request changes"
          color={verdictColors.request_changes}
        />
        <GateCell gate="Confidence" value="high" color={verdictColors.comment} />
        <GateCell
          gate="Severity"
          value="≥ 9 / 10"
          color={severityColors.critical}
        />
      </div>

      <p>
        The gates are combined with <strong className="text-white">AND</strong>:
        miss any one and the agent comments instead of closing. Each gate exists
        to defuse a specific failure mode — severity inflation, confident
        low-quality guesses on tiny diffs, and treating every{" "}
        <em className="text-white not-italic">request changes</em> as a close.
      </p>

      <Card className="p-5">
        <p className="text-[13px] leading-relaxed text-muted">
          <span className="font-mono uppercase tracking-[0.12em] text-white">
            Default ·{" "}
          </span>
          Auto-close is <strong className="text-white">off</strong> for every
          repository until you turn it on. Even enabled, the three gates are
          fixed safety rails — you tune the severity threshold within them, not
          around them.
        </p>
      </Card>
    </DocSection>
  );
}

function ConfigurationSection() {
  return (
    <DocSection
      id="configuration"
      eyebrow="Tuning"
      title="Per-repo configuration"
    >
      <Lead>
        Each repository has its own settings page, reached from the configure
        action on the Repos screen. This is where you shape how the agent
        behaves on that codebase.
      </Lead>
      <FeatureGrid>
        <FeatureCell title="Enable / disable">
          Turn reviews on or off for the repo without disconnecting it.
        </FeatureCell>
        <FeatureCell title="Auto-close + threshold">
          Opt into auto-close and set the severity threshold (within the
          three-gate rails) using a slider.
        </FeatureCell>
        <FeatureCell title="Watch & skip paths">
          Pattern lists that scope reviews to the paths that matter and ignore
          generated or vendored code.
        </FeatureCell>
        <FeatureCell title="Custom instructions">
          Free-text guidance and a rules-file editor — upload your style guide
          and the reviewer reads it before every review.
        </FeatureCell>
      </FeatureGrid>
      <p>
        <ScreenLink href="/dashboard/repos" label="Pick a repo to configure" />
      </p>
    </DocSection>
  );
}

function SelfLearningSection() {
  return (
    <DocSection
      id="self-learning"
      eyebrow="Feedback loop"
      title="How Lyncas learns"
    >
      <Lead>
        Lyncas treats your follow-up actions as ground truth. When you merge a
        PR it wanted closed, or close one it approved, that disagreement is
        recorded.
      </Lead>
      <div className="space-y-5">
        <Step n={1} title="Observe">
          A poller tracks what happened to each reviewed PR — merged, closed,
          reverted — and settles it into a labeled outcome.
        </Step>
        <Step n={2} title="Measure">
          Those labels power the accuracy KPI on the Overview screen and surface
          drift before it becomes a pattern.
        </Step>
        <Step n={3} title="Propose">
          On a weekly cadence, once enough disagreements accumulate, a tuner
          drafts edits to the reviewer&apos;s own prompt and opens them as a pull
          request.
        </Step>
        <Step n={4} title="You decide">
          The agent never changes its own behavior unilaterally — a human
          reviews and merges the tuner&apos;s PR, exactly like any other change.
        </Step>
      </div>
    </DocSection>
  );
}

function FaqSection() {
  return (
    <DocSection id="faq" eyebrow="Questions" title="FAQ">
      <div className="space-y-4">
        <Faq q="Will Lyncas close my PR without warning?">
          No. Auto-close is off by default and, once enabled, requires a
          high-confidence request-changes verdict at severity 9 or above. Until
          you opt in, Lyncas only comments.
        </Faq>
        <Faq q="How fast is a review?">
          Typically under 30 seconds from the PR event. Reviews are triggered by
          a webhook, not a schedule, so there is no waiting for a cron tick.
        </Faq>
        <Faq q="Why didn't a PR get reviewed?">
          Check that the repo is connected and active on the Repos screen, that
          the changed files fall within its watch paths, and that the PR action
          was an open or synchronize. Idempotency also means a PR already
          carrying a Lyncas comment is not re-reviewed on later ticks.
        </Faq>
        <Faq q="Does the agent change its own prompt?">
          Only by opening a pull request a human must merge. It never edits its
          review prompt directly.
        </Faq>
        <Faq q="Where do reviews actually run?">
          In a GitHub Actions job — the single source of truth. The webhook only
          dispatches, and this dashboard only reads results. Nothing is reviewed
          in two places.
        </Faq>
      </div>
      <Card className="mt-6 p-6" tone="elev">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-base font-semibold text-white">
              Ready to try it on your repo?
            </h4>
            <p className="mt-1 text-[13px] text-muted">
              Connect a repository and open a PR — the first review is seconds
              away.
            </p>
          </div>
          <LinkButton href="/dashboard/repos" variant="primary" size="md">
            Connect a repo
          </LinkButton>
        </div>
      </Card>
    </DocSection>
  );
}

/* ------------------------------------------------------------------ */
/* Small shared bits                                                   */
/* ------------------------------------------------------------------ */

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-white" aria-hidden />
      <span className="text-[13px] leading-relaxed text-muted">{children}</span>
    </li>
  );
}

function SeverityCell({
  range,
  label,
  color,
}: {
  range: string;
  label: string;
  color: string;
}) {
  return (
    <div className="bg-bg p-4 text-center">
      <div
        className="font-mono text-xl font-bold tabular-nums"
        style={{ color }}
      >
        {range}
      </div>
      <div className="mt-1 text-[10px] font-mono uppercase tracking-[0.16em] text-muted">
        {label}
      </div>
    </div>
  );
}

function GateCell({
  gate,
  value,
  color,
}: {
  gate: string;
  value: string;
  color: string;
}) {
  return (
    <div className="bg-bg p-5 text-center">
      <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
        {gate}
      </div>
      <div className="mt-2 font-mono text-base font-bold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group border border-border bg-card rounded-md">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-white">
        {q}
        <span
          className="font-mono text-muted transition-transform group-open:rotate-45"
          aria-hidden
        >
          +
        </span>
      </summary>
      <p className="px-5 pb-4 text-[13px] leading-relaxed text-muted">
        {children}
      </p>
    </details>
  );
}
