# night-pr-reviewer

An autonomous agent that reviews open PRs on your GitHub repos every hour and emails you a digest each morning. Runs entirely in GitHub Actions — your laptop can be off.

## What it does

1. **Every hour:** scans configured repos for open PRs that haven't been reviewed yet
2. **For each new PR:** fetches the diff, sends it to Claude with a strict review prompt, posts the structured review as a PR comment
3. **Each morning (7am UTC):** emails you a digest of everything reviewed in the last 24h

The review marker (`<!-- night-pr-reviewer:v1 -->`) makes the agent idempotent — it won't re-review a PR it's already touched.

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
- Create one named "night-pr-reviewer"
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

Go to the Actions tab → night-pr-reviewer → Run workflow. This triggers the hourly job immediately *and* sends a digest at the end (because of `workflow_dispatch` in the condition). Use this for your video demo.

## Why these decisions (the things that matter)

These are the answers to "why did you build it this way":

| Decision | Why |
|---|---|
| **GitHub Actions cron**, not local cron | Runs even when laptop is closed. Free for public repos, generous free tier for private. Auditable run history. |
| **Hourly scan**, not webhook | Webhooks need a public endpoint; cron does not. Hourly is fast enough for human-scale review. Single moving part. |
| **Comment marker for idempotency** | Means I can run as often as I want without spamming PRs. The marker is invisible HTML. |
| **Claude Sonnet, not Opus** | Per Arleif's cost guidance. Sonnet is more than capable for review tasks. ~$0.005-0.02 per PR review. |
| **Truncate huge diffs at 60k chars** | Caps cost per PR. The note in the comment tells the human reviewer when this happened. |
| **JSON output schema** | Forces Claude into structured thinking and lets me format the comment consistently. The prompt explicitly warns against hallucinating code. |
| **Demo on a personal repo** | Won't touch shared/team repos without consent. Config-driven, so the same agent runs on any repo I own. |
| **Never auto-merges anything** | The agent can close clearly-broken PRs (gated, opt-in) but never merges. Closing is reversible; merging into main is not. |
| **Logs persist between runs via Actions cache** | So the daily digest can summarize a full 24h of work. |

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

Sonnet pricing × 60k char diffs × hourly runs × N repos.
Real-world: typically **under $1/day** for a handful of repos. The digest shows token counts per review so you can see exactly what each one cost.

## Failure modes to watch

- Anthropic rate limits → caught and logged, digest will show the error
- GitHub rate limits → unlikely at this scale (5000 req/hr authenticated)
- Claude returning non-JSON → caught and logged per PR, other PRs still get reviewed
- PR diff > 60k chars → truncated, noted in the comment
