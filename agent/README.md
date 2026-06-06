# agent

Python agent that runs in GitHub Actions, reviews open PRs on configured repos, and emails a daily digest.

## What it does

1. **Every 15 min:** scans configured repos for open PRs that haven't been reviewed yet
2. **For each new PR:** fetches the diff, sends it to Claude with a strict review prompt, posts the structured review as a PR comment
3. **Each morning (7am UTC):** emails a digest of everything reviewed in the last 24h

The review marker (`<!-- lyncas:v1 -->`) makes the agent idempotent — it won't re-review a PR it's already touched.

## Setup (one-time, ~10 minutes)

### 1. Fork or create a new repo to host this agent

This repo is the *agent itself*, separate from the repo(s) you want reviewed. Push these files to a new private repo on your personal GitHub account.

### 2. Generate an Anthropic API key

From the [Anthropic console](https://console.anthropic.com/). You should have received an invitation per Arleif's instructions.

### 3. Generate a GitHub PAT (fine-grained)

The default `GITHUB_TOKEN` only has access to the agent's own repo. You need a PAT that can read PRs and write comments on your *target* repos.

- Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
- Select only the repos you want reviewed
- Permissions: `Pull requests: Read and write`, `Contents: Read-only`, `Metadata: Read-only`
- Expiration: 90 days (set a calendar reminder to rotate)

### 4. Generate a Gmail app password

Regular Gmail passwords don't work over SMTP. You need an app password.

- Enable 2FA on your Google account if you haven't
- Go to [Google account → Security → App passwords](https://myaccount.google.com/apppasswords)
- Create one named "lyncas"
- Copy the 16-character password

### 5. Add secrets to the agent repo

In the agent repo on GitHub: Settings → Secrets and variables → Actions → New repository secret. Add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` from step 2 |
| `PR_REVIEWER_PAT` | the PAT from step 3 |
| `REPOS` | comma-separated, e.g. `youruser/repo1,youruser/repo2` |
| `GMAIL_USER` | your Gmail address |
| `GMAIL_APP_PASSWORD` | the app password from step 4 |
| `DIGEST_RECIPIENT` | where the digest goes (can be the same Gmail) |

### 6. Test it manually

Go to the Actions tab → lyncas → Run workflow. This triggers the scan immediately *and* sends a digest at the end (because of `workflow_dispatch` in the condition). Use this for your video demo.

## Database setup

> Required for v2 (Supabase-backed state). The agent code is being migrated to
> read/write state from Supabase instead of GitHub Actions cache. See
> [IMPROVEMENTS.md](../IMPROVEMENTS.md) for the full migration plan.

### 1. Create a Supabase project

Sign in at [supabase.com](https://supabase.com/), create a new project, pick a region close to where the GitHub runners are (US East is fine for `ubuntu-latest`), and wait for it to finish provisioning.

### 2. Run the initial schema migration

In the Supabase web UI:

1. Open **SQL Editor** → **New query**.
2. Paste the entire contents of [`migrations/001_initial_schema.sql`](migrations/001_initial_schema.sql).
3. Click **Run**.
4. Open **Table Editor** and confirm three new tables exist: `reviews`, `runs`, `digests`.

The migration creates the schema with `check` constraints on enum-like fields (`verdict`, `confidence`, `action`), a unique index on `(repo, pr_number)` so re-reviews upsert cleanly, and partial/ordered indexes for the hot query paths the digest and dashboard rely on.

### 3. Grab the API credentials

In Supabase project settings → **API**:

- `Project URL` → this is your `SUPABASE_URL`
- `service_role` key (under "Project API keys", click **Reveal**) → this is your `SUPABASE_SERVICE_KEY` — **server-side only, never commit this**
- `anon` / public key → save this as `SUPABASE_ANON_KEY` for the dashboard (Phase 4); the agent doesn't need it

### 4. Add them as GitHub Actions secrets

In this repo on GitHub: Settings → Secrets and variables → Actions → New repository secret. Add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | from step 3 |
| `SUPABASE_SERVICE_KEY` | the `service_role` key from step 3 |

These will be wired into the workflow in Phase 2, when `pr_reviewer.py` starts writing to the `reviews` and `runs` tables.

### Notes on RLS

The migration does **not** enable Row Level Security. The agent talks to the database with the `service_role` key (which bypasses RLS anyway), and v1 of the dashboard is read-only with the `anon` key. RLS will be added in a later iteration.

## Why these decisions (the things that matter)

These are the answers to "why did you build it this way":

| Decision | Why |
|---|---|
| **GitHub Actions cron**, not local cron | Runs even when laptop is closed. Free for public repos, generous free tier for private. Auditable run history. |
| **15-min scan**, not webhook | Webhooks need a public endpoint; cron does not. 15-min cadence is fast enough for human-scale review. Single moving part. |
| **Comment marker for idempotency** | Means I can run as often as I want without spamming PRs. The marker is invisible HTML. |
| **Claude Opus 4.5, not Sonnet** | Started on Sonnet for cost reasons, but the n=5 benchmark (see `agent/benchmark.py` + the dashboard `/benchmark` page) showed 100% verdict agreement with low bug-list overlap on complex PRs — i.e. Opus finds *different* and more issues. Since the bug list IS the deliverable that goes into the daily digest email, quality wins over cost here. Opus runs ~5x the per-token cost; we'll revisit if monthly spend crosses the budget threshold. |
| **Truncate huge diffs at 60k chars** | Caps cost per PR. The note in the comment tells the human reviewer when this happened. |
| **JSON output schema** | Forces Claude into structured thinking and lets me format the comment consistently. The prompt explicitly warns against hallucinating code. |
| **Demo on a personal repo** | Won't touch shared/team repos without consent. Config-driven, so the same agent runs on any repo I own. |
| **Never auto-merges anything** | The agent can close clearly-broken PRs (gated, opt-in) but never merges. Closing is reversible; merging into main is not. |
| **Logs persist between runs via Actions cache** | So the daily digest can summarize a full 24h of work. (Note: being migrated to Supabase — see [IMPROVEMENTS.md](../IMPROVEMENTS.md).) |

## Auto-close — why severity_score is separate from verdict

The verdict says *what* should happen. The severity_score (1–10) says *how broken* the PR is. They're not the same: many PRs deserve `request_changes` but aren't candidates for closure (an off-by-one bug → `request_changes`, severity ~6; "hardcoded production AWS keys" → `request_changes`, severity 10). The prompt explicitly tells Claude: *"A bug — even a serious one — is NOT a 9 or 10. A 9–10 means the PR's existence is a problem, not just its content."*

## Auto-close (opt-in, gated)

The agent can close PRs autonomously when all three gates pass:

| Gate | Required value |
|---|---|
| `verdict` | `request_changes` |
| `confidence` | `high` |
| `severity_score` | `>= 9` (out of 10) |

**To enable**: in the agent repo on GitHub → Settings → Secrets and variables → Actions → Variables tab → New repository variable → `ALLOW_AUTO_CLOSE` = `true`.

**To disable**: delete the variable, or set it to `false`. The default behavior (no variable set) is to never close anything — only comment.

When the agent closes a PR:
1. It posts a detailed reason comment with the bugs, the severity, and reopen instructions for the author
2. It closes the PR via the GitHub API
3. The PR is flagged in the morning digest under a **🚫 AUTO-CLOSED — REVIEW THESE FIRST** section so you can audit every close decision

If you ever disagree with a close, anyone with PR write access can reopen it. The agent's marker prevents it from re-closing the same PR.

## What it does NOT do

- Doesn't auto-merge PRs (intentional — closing is a reversible action, merging is not)
- Doesn't push commits (intentional — read-only on code)
- Doesn't review PRs from forks unless `pull_request_target` is added (intentional — security)
- Doesn't re-review a PR if more commits are pushed (TODO if useful — bump marker version)
- Doesn't close PRs unless you opt in via `ALLOW_AUTO_CLOSE=true` AND all three gates pass

## Cost ceiling

Opus 4.5 pricing × 60k char diffs × 15-min runs × N repos. Opus is roughly 5x the per-token cost of Sonnet, so budget accordingly — expect a few cents per review instead of fractions of a cent. The benchmark (`/benchmark` page) showed Opus catches issues Sonnet misses on complex PRs, which is why the bug list goes through Opus now. The digest shows token counts per review so you can see exactly what each one cost; if monthly spend exceeds the budget threshold, flip `MODEL` back to `claude-sonnet-4-5` in `pr_reviewer.py`.

## Failure modes to watch

- Anthropic rate limits → caught and logged, digest will show the error
- GitHub rate limits → unlikely at this scale (5000 req/hr authenticated)
- Claude returning non-JSON → caught and logged per PR, other PRs still get reviewed
- PR diff > 60k chars → truncated, noted in the comment
