# Night PR Reviewer

> An autonomous AI agent that reviews every pull request on your GitHub repositories,
> posts a structured review in seconds, and escalates the obvious-bad ones for you.
> Open source. Multi-tenant. Powered by Claude Opus.

[Live demo](https://night-pr-reviewer-v2.vercel.app) ·
[Dashboard docs](dashboard/README.md) ·
[Agent docs](agent/README.md) ·
[Architecture](ARCHITECTURE.md) ·
[Roadmap](PROJECT_PLAN.md)

---

## The problem

Code review is the single most expensive synchronous bottleneck in a shipping
engineering org. The reality on most teams:

- **Reviewers are slow.** A two-line typo fix sits in the queue for hours
  alongside a 4,000-line schema migration. The author moves on; context
  evaporates.
- **Reviewers are inconsistent.** The same Dependabot bump gets a 👍 from one
  engineer and a list of nits from another. Severity drifts. New hires can't
  tell what "good" looks like.
- **Some PRs should never have been opened.** Hardcoded credentials,
  rm-rf-the-database migrations, copy-pasted secrets. Catching them on
  Monday morning instead of Friday night is a category of incident, not a
  delay.
- **Existing tools fall short.** Linters don't reason about *intent*.
  Dependabot doesn't read your style guide. A coding agent that can chat
  about your repo doesn't know what your last 200 PR comments said.

The cost is measurable: median review latency, missed regressions, weekend
oncall. The fix that ships today is "we need to hire more senior
engineers," which is neither fast nor scalable.

## What Night PR Reviewer does

Night PR Reviewer sits between GitHub and your team. The moment a PR opens or
gets new commits, the agent:

1. **Pulls the diff** with a per-repo install of the Night PR Reviewer GitHub
   App (no shared PATs, no shared secrets).
2. **Runs a multi-node LangGraph pipeline** (`repo-context → reviewer →
   critic → optional arbiter → final`) on **Claude Opus 4.5**, with your
   per-repo style guide, path filters, and custom instructions injected
   into the prompt.
3. **Posts a structured review comment** on the PR within ~30 seconds —
   verdict, severity 1–10, confidence, bug list with file + line + fix
   suggestion, plus open questions and praise.
4. **Optionally auto-closes** PRs that pass three independent gates
   (`verdict=request_changes` ∧ `confidence=high` ∧ `severity_score ≥ 9`)
   — and only if you opt in. Closing is reversible; merging is not.
5. **Emails you a daily digest** at 7am UTC summarising everything reviewed
   in the last 24h, with a 🚫 section for any auto-close so you can audit
   every decision.
6. **Watches what you do next.** Did you keep the comment or dismiss it?
   Reopen the closed PR or merge it anyway? The `human_actions` poller
   labels every review with the eventual ground-truth outcome.
7. **Improves its own prompt.** A weekly job feeds the misses
   (`false_close`, `missed_issue`) into a meta-prompt and opens a PR
   against the agent repo proposing an edit to `agent/prompt.md`. The agent
   never merges its own changes — you review the diff like any other PR.

The user-facing surface is a **Next.js dashboard** with:

- a multi-tenant **chat workspace** keyed by repo room (research briefings
  auto-generate on entry, live GitHub project tree + repo stats populate
  the side rails)
- an **overview** with stat cards, severity / activity charts, a
  filterable + sortable reviews table, and per-PR drill-downs
- per-repo **rules** — path filters, custom instructions, style-guide
  file upload (`.md`/`.txt`, up to 200KB), severity threshold overrides
- **per-PR detail** (`/pr/[id]`) — auth-gated, only visible to the user
  who connected the repo, with the full bug list and the human-action
  outcome label once it's resolved

A few legacy v1 surfaces (`/runs`, `/learning`, `/benchmark`) exist on disk
but are 404'd on multi-tenant deployments because their tables don't yet
carry a `user_id` column — turning them back on is a one-file change once
that scoping lands. The agent still runs the work (digest, human-action
poll, prompt-tuner, benchmark harness) headlessly; the underlying rows are
just not exposed in the UI yet.

The whole thing is open-source. You can self-host it, fork it, or run the
demo at [`night-pr-reviewer-v2.vercel.app`](https://night-pr-reviewer-v2.vercel.app).

## How it's different

| | Night PR Reviewer | GitHub Copilot Reviews | A bare LLM call in CI |
|---|---|---|---|
| Reads your style guide | ✅ per-repo upload | ❌ | needs glue |
| Reasons about repo history | ✅ weekly fingerprint cached | partial | ❌ |
| Structured output (verdict + severity + bugs[]) | ✅ JSON schema enforced | partial | ❌ |
| Opt-in auto-close behind 3 gates | ✅ | ❌ | unsafe |
| Self-learning from human follow-up | ✅ prompt-tuner PRs | ❌ | ❌ |
| Daily digest + drift alerts | ✅ | ❌ | ❌ |
| Per-PR cost transparency | ✅ tokens in/out logged | ❌ | up to you |
| Self-hostable | ✅ | ❌ | ✅ |
| Multi-tenant SaaS-ready | ✅ Supabase RLS + GitHub App | n/a | ❌ |

## Architecture at a glance

```
                    ┌──────────────────────┐
                    │  GitHub repo (yours) │
                    └──────────┬───────────┘
                               │ webhook (PR opened / sync)
                               ▼
       ┌──────────────────────────────────────────────┐
       │  Vercel route: /api/webhook/pull-request     │
       │  – verifies HMAC                             │
       │  – dispatches GitHub Actions workflow        │
       └──────────────────────────────────────────────┘
                               │ workflow_dispatch
                               ▼
       ┌──────────────────────────────────────────────┐
       │  GitHub Actions: pr-review.yml               │
       │  Python 3.11 agent                           │
       │   ↳ pr_reviewer.py                           │
       │      ↳ run_review_graph (LangGraph)          │
       │         ↳ Claude Opus 4.5                    │
       │   ↳ posts comment / closes PR                │
       │   ↳ writes reviews + runs to Supabase        │
       └──────────────────────────────────────────────┘
                               │
                               ▼
       ┌──────────────────────────────────────────────┐
       │  Supabase Postgres (RLS-enabled)             │
       │  – reviews · runs · digests · human_actions  │
       │  – repo_rules · watched_repos · user_profiles│
       │  – prompt_tuner_runs · agent_alerts          │
       │  – benchmark_runs · repo_fingerprints        │
       └──────────────────────────────────────────────┘
                               │ anon reads
                               ▼
       ┌──────────────────────────────────────────────┐
       │  Next.js dashboard (Vercel)                  │
       │  – /dashboard/chat       repo chat workspace │
       │  – /dashboard/overview   stats + reviews     │
       │  – /dashboard/repos      manage connections  │
       │  – /dashboard/settings   digest email        │
       │  – /pr/[id]              per-PR detail       │
       └──────────────────────────────────────────────┘
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the long version (every component,
every env var, the full data flow).

## Stack

- **Agent** — Python 3.11 · `anthropic` · `langgraph` · `supabase-py` ·
  `requests`. Entry: [`agent/pr_reviewer.py`](agent/pr_reviewer.py).
- **Dashboard** — Next.js 16 (App Router) · React 19 · TypeScript 5 ·
  Tailwind CSS v4 · `@supabase/ssr` · `framer-motion` · Recharts.
- **State** — Supabase Postgres. 13 migrations, RLS-enabled on every table
  exposed to the browser. `service_role` writes from the agent only.
- **Orchestration** — GitHub Actions cron (15-min review, daily digest,
  6-hourly human-action poll, weekly prompt-tuner) + a Vercel webhook
  that immediately dispatches the same workflow for low-latency review.
- **Auth** — Supabase Auth (GitHub OAuth + email magic-link).
- **Hosting** — Vercel for the dashboard, GitHub Actions for the agent,
  Supabase for the database.

## Getting started

You have three paths:

1. **[Try the live demo](#1-try-the-live-demo)** — no setup, view-only data.
2. **[Self-host the SaaS](#2-self-host-the-saas-recommended-for-teams)** —
   you run the dashboard and the agent; your users sign up via GitHub OAuth
   and install the GitHub App on their repos.
3. **[Self-host the single-tenant agent](#3-self-host-single-tenant-original-mode)** —
   the original v1 mode: one set of credentials in GitHub Actions secrets,
   one `REPOS=` env var, no dashboard auth.

### 1. Try the live demo

Open [night-pr-reviewer-v2.vercel.app](https://night-pr-reviewer-v2.vercel.app).

- `/landing` is the marketing page.
- `/login` → sign in with GitHub or via email magic-link.
- After auth you land in your own workspace at `/dashboard/chat`. The
  agent only starts reviewing your PRs once you install the GitHub App
  from `/dashboard/repos`.

No credit card required.

### 2. Self-host the SaaS (recommended for teams)

This is the v3 multi-tenant flow. End-users sign up, install a GitHub App
you control, and the agent reviews PRs across every install.

#### Prerequisites

- A GitHub account (for the agent repo + the GitHub App)
- An [Anthropic API key](https://console.anthropic.com/) (Opus 4.5 access)
- A [Supabase](https://supabase.com/) project (free tier is fine to start)
- A [Vercel](https://vercel.com/) account (for the dashboard + webhook)
- A Gmail account with 2FA enabled (for the daily digest)

#### Step 1 — Fork the repo

```bash
gh repo fork HarshBti1805/Night-PR-Reviewer --clone
cd Night-PR-Reviewer
```

#### Step 2 — Provision Supabase

1. Create a new Supabase project. Pick a region close to where the GitHub
   runners live (US East / `ubuntu-latest` is fine).
2. In the SQL Editor, paste **each migration in order** from
   [`agent/migrations/`](agent/migrations/) and run them one at a time:
   `001_initial_schema.sql` → `013_repo_research.sql`. The migrations are
   idempotent — re-running them is safe.
3. In **Settings → API**, copy:
   - `Project URL` → save as `SUPABASE_URL` (and `NEXT_PUBLIC_SUPABASE_URL`)
   - `anon public` key → save as `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → save as `SUPABASE_SERVICE_KEY` (**never ship this
     to the browser**)

#### Step 3 — Create the GitHub App

1. **Settings → Developer settings → GitHub Apps → New GitHub App** (on
   your personal account or org).
2. Name: anything (e.g. `night-pr-reviewer-myorg`).
3. Homepage URL: your eventual Vercel URL (you'll know it after step 5,
   can be edited).
4. Callback URL: `https://<your-vercel-url>/auth/github-app/callback`
5. Webhook URL: `https://<your-vercel-url>/api/webhook/pull-request`
6. Webhook secret: generate a random 32-byte string (`openssl rand -hex 32`)
   and save it as `WEBHOOK_SECRET`.
7. **Permissions** (Repository):
   - Contents: **Read**
   - Pull requests: **Read & write**
   - Metadata: **Read**
8. **Subscribe to events**: `Pull request`.
9. **Where can this GitHub App be installed**: Any account.
10. Create the app, then:
    - Copy the **App ID** → save as `GITHUB_APP_ID`.
    - Generate and download a **private key** (`.pem` file) → save its
      contents (including `-----BEGIN/END-----` lines) as
      `GITHUB_APP_PRIVATE_KEY`.
    - Copy the app's **slug** (the URL fragment in
      `github.com/apps/<slug>`) → save as `NEXT_PUBLIC_GITHUB_APP_SLUG`.

#### Step 4 — Anthropic & Gmail

- Anthropic console → API keys → create one → save as `ANTHROPIC_API_KEY`.
- Google account → 2FA → App passwords → create one named
  `night-pr-reviewer` → save as `GMAIL_APP_PASSWORD`. Save your address as
  `GMAIL_USER`.

#### Step 5 — Deploy the dashboard to Vercel

1. **Import Project** → pick the fork.
2. **Project Settings → General → Root Directory** → `dashboard`.
3. **Environment Variables** (Production + Preview):
   ```
   NEXT_PUBLIC_SUPABASE_URL          = …
   NEXT_PUBLIC_SUPABASE_ANON_KEY     = …
   NEXT_PUBLIC_SITE_URL              = https://<your-vercel-url>
   NEXT_PUBLIC_GITHUB_APP_SLUG       = <your-app-slug>
   GITHUB_APP_ID                     = …
   GITHUB_APP_PRIVATE_KEY            = <PEM with literal \n>
   WEBHOOK_SECRET                    = …
   AGENT_REPO                        = <your-fork-owner>/Night-PR-Reviewer
   AGENT_WORKFLOW_PAT                = <fine-grained PAT, actions:write on agent repo>
   AGENT_WORKFLOW                    = pr-review.yml   # optional override
   AGENT_WORKFLOW_REF                = main             # optional override
   ```
4. Deploy. Open the deployed URL and confirm you can hit `/login`.

#### Step 6 — Add GitHub Actions secrets on the agent repo

In **the fork** on GitHub → Settings → Secrets and variables → Actions →
add the following secrets:

| Name | From |
|---|---|
| `ANTHROPIC_API_KEY` | Step 4 |
| `SUPABASE_URL` | Step 2 |
| `SUPABASE_SERVICE_KEY` | Step 2 |
| `GITHUB_APP_ID` | Step 3 |
| `GITHUB_APP_PRIVATE_KEY` | Step 3 |
| `GMAIL_USER` | Step 4 |
| `GMAIL_APP_PASSWORD` | Step 4 |
| `DIGEST_RECIPIENT` | your email |

Add this **variable** (optional, defaults to `false`):

| Name | Value |
|---|---|
| `ALLOW_AUTO_CLOSE` | `false` *(opt-in to closing PRs when all 3 gates pass)* |

#### Step 7 — End-to-end smoke test

1. From your fork → **Actions tab → night-pr-reviewer → Run workflow**.
   The first run should finish in ~1 minute with no errors.
2. Sign in to your dashboard at `https://<your-vercel-url>/login`.
3. **Repos → Add repos via GitHub** → install the GitHub App on a test
   repository.
4. Open a draft PR on that repo. Within ~30 seconds you should see a
   structured review comment posted by the app, and a new row appear in
   the dashboard's `/dashboard/overview`.

That's the loop. Every PR from now on flows through it automatically.

### 3. Self-host single-tenant (original mode)

If you don't need multi-tenant chat / per-user installs, the original
single-tenant flow is simpler — see [`agent/README.md`](agent/README.md)
for the 6-step setup (Anthropic key, GitHub PAT, Gmail app password,
five Actions secrets, manual workflow trigger).

In that mode you don't need the GitHub App, the dashboard auth, or
the `AGENT_*` Vercel env vars. The dashboard still works as a public,
read-only view on the data the agent writes.

## Local development

```bash
# Agent (Python 3.11)
cd agent
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in: ANTHROPIC_API_KEY, GITHUB_TOKEN_PAT,
                       #          REPOS, SUPABASE_URL, SUPABASE_SERVICE_KEY
python pr_reviewer.py            # one-off review pass
python send_digest.py            # mail today's digest (needs Gmail creds)
python track_human_actions.py    # backfill outcome labels
python prompt_tuner.py           # open a prompt-improvement PR (≥3 misses)
python benchmark.py --latest 5   # Sonnet-vs-Opus, costs Opus tokens

# Dashboard (Node 20+)
cd dashboard
npm install
cp .env.example .env.local       # NEXT_PUBLIC_SUPABASE_URL,
                                 # NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev                       # http://localhost:3000
```

The agent uses `SUPABASE_SERVICE_KEY` (full DB access — never commit, never
expose to the browser). The dashboard uses `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(safe to ship — RLS does the work).

## Database

Migrations live in [`agent/migrations/`](agent/migrations/) and are
applied manually through the Supabase SQL Editor.

| # | File | Adds |
|---|---|---|
| 001 | `initial_schema.sql` | `reviews`, `runs`, `digests` |
| 002 | `benchmark_runs.sql` | `benchmark_runs` |
| 003 | `repo_fingerprints.sql` | `repo_fingerprints` |
| 004 | `review_metadata.sql` | `reviews.repo_context_used`, `reviews.model` |
| 005 | `langgraph_outputs.sql` | `reviews.critic_output`, `arbiter_output`, `escalated` |
| 006 | `human_actions.sql` | `human_actions` (ground-truth labels) |
| 007 | `agent_alerts.sql` | `agent_alerts` (drift alarms) |
| 008 | `prompt_tuner_runs.sql` | `prompt_tuner_runs` (open improvement PRs) |
| 009 | `repo_rules.sql` | `repo_rules` (path filters, custom instructions, style guide) |
| 010 | `saas_auth.sql` | `user_profiles`, `watched_repos` (multi-tenant) |
| 011 | `github_app.sql` | install tokens + per-user app installation IDs |
| 012 | `email_verification.sql` | OTP-verified digest email |
| 013 | `repo_research.sql` | cached repo research articles for chat |

RLS is enabled on every table the dashboard reads — see migration headers
for the exact policies.

## Project layout

```
night-pr-reviewer-v2/
├── agent/                          Python 3.11 agent (runs in CI)
│   ├── pr_reviewer.py              entry point: scan repos, review PRs
│   ├── review_graph.py             LangGraph multi-node pipeline
│   ├── prompt.md                   reviewer system prompt
│   ├── prompt_tuner.py             weekly self-improvement job
│   ├── send_digest.py              daily 7am UTC digest
│   ├── track_human_actions.py      6-hourly outcome poller
│   ├── benchmark.py                Sonnet-vs-Opus harness
│   └── migrations/                 SQL, applied manually via Supabase UI
│
├── dashboard/                      Next.js 16 dashboard (Vercel)
│   ├── app/
│   │   ├── landing/                public marketing
│   │   ├── login/                  GitHub OAuth + magic-link
│   │   ├── dashboard/              auth-gated workspace
│   │   │   ├── chat/               multi-tenant repo chat
│   │   │   ├── overview/           reviews + stats + charts
│   │   │   ├── repos/              manage GitHub App installs
│   │   │   └── settings/           digest email, account
│   │   ├── pr/[id]/                per-PR drill-down (auth-gated)
│   │   ├── benchmark/              v1 demo route (404'd in SaaS)
│   │   ├── learning/               v1 demo route (404'd in SaaS)
│   │   ├── runs/                   v1 demo route (404'd in SaaS)
│   │   └── api/
│   │       ├── chat/               streaming chat completions
│   │       ├── repo-tree/          live GitHub directory listing
│   │       ├── repo-stats/         languages, contributors, open PRs
│   │       ├── repo-research/      cached research articles
│   │       ├── webhook/            GitHub PR webhook → workflow dispatch
│   │       └── verify-email/       OTP verification
│   ├── components/                 reusable UI primitives + motion
│   └── lib/
│       ├── queries.ts              all Supabase reads
│       ├── design.ts               palette + formatters
│       └── supabase/               server / client / browser clients
│
├── .github/workflows/pr-review.yml four crons: review, digest, poll, tune
├── ARCHITECTURE.md                 long-form system reference
├── PROJECT_PLAN.md                 roadmap & technical debt
└── CLAUDE.md                       conventions for AI assistants
```

## Operations

A healthy production deployment satisfies all of:

| Check | How |
|---|---|
| Reviews are landing | `select count(*) from reviews where created_at > now() - interval '7 days'` returns > 0 |
| Digests are stamping | `select count(*) filter (where digested_at is null) from reviews` is small (recent only) |
| Human-action poller is alive | `select action_type, count(*) from human_actions where observed_at > now() - interval '7 days'` returns rows |
| No unresolved drift alerts | `select * from agent_alerts where resolved_at is null` returns empty |
| Workflow runs succeed | Actions tab on the agent repo shows green ticks at the 15-min cadence |
| Dashboard renders | `/landing` and `/dashboard/overview` load without 500s |

Common failure modes and their fixes are documented at the top of
[CLAUDE.md](CLAUDE.md) (search for "Common failure modes").

## Security & cost notes

- **Tokens never reach the browser.** All GitHub calls happen inside
  Vercel API routes or the Python agent. The dashboard only ever holds
  the Supabase `anon` key, which RLS scopes per-user.
- **`SUPABASE_SERVICE_KEY` is GitHub-Actions-only.** It bypasses RLS, so
  it lives only in the agent repo's Actions secrets and a few server-side
  Vercel routes that need to forge installation tokens.
- **Auto-close is opt-in.** Default is comment-only. Even with
  `ALLOW_AUTO_CLOSE=true`, all three gates must pass.
- **Cost ceiling.** Opus 4.5 + 60k-char diff cap + 15-min cron + N repos.
  Expect a few cents per review. The dashboard shows tokens-in/tokens-out
  per review so you can audit any single one. To halve cost, change
  `MODEL` in [`agent/pr_reviewer.py`](agent/pr_reviewer.py) back to
  `claude-sonnet-4-5` — the benchmark page shows the quality trade-off.

## Documentation

- **[agent/README.md](agent/README.md)** — single-tenant setup, prompt
  design rationale, auto-close gate explanation, failure modes.
- **[dashboard/README.md](dashboard/README.md)** — Next.js layout, env
  vars, Vercel deploy, webhook receiver.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — full system reference: every
  component, every env var, every table.
- **[PROJECT_PLAN.md](PROJECT_PLAN.md)** — completed phases, v3 roadmap,
  known limitations, technical debt.
- **[CLAUDE.md](CLAUDE.md)** — rules for AI assistants (Claude Code,
  Cursor) picking up the project.

## Contributing

This is a research-grade project — open issues and PRs welcome, but expect
opinionated reviews from the agent itself. Read [CLAUDE.md](CLAUDE.md)
before opening a non-trivial PR; it captures the constraints the agent
will measure your change against.

## License

MIT. See [LICENSE](LICENSE) if present, or treat this notice as the grant.
