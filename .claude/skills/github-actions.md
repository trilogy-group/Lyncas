# Skill: GitHub Actions workflow reference

Single workflow at `.github/workflows/pr-review.yml`. Contains 3 jobs
+ 4 cron schedules + `workflow_dispatch`. This is the only CI
configuration in the repo.

## File location

`.github/workflows/pr-review.yml` is at the **repo root**, not inside
`agent/`. GitHub Actions requires workflows live under `.github/`
relative to the repo root regardless of where the code they run
lives. The Python scripts under `agent/` are invoked from the
workflow as `python agent/<script>.py`.

## Trigger surface

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'   # PR review scan
    - cron: '0 7 * * *'      # Daily digest (7am UTC)
    - cron: '0 */6 * * *'    # Human-action poll + drift
    - cron: '0 8 * * 1'      # Weekly prompt-tuner (Mondays 8am UTC)
  workflow_dispatch:          # Manual button + Vercel webhook dispatcher
```

Concurrency:

```yaml
concurrency:
  group: pr-reviewer
  cancel-in-progress: false
```

Single concurrency group prevents overlapping runs (a slow review
shouldn't get cancelled by a fresh cron tick). `cancel-in-progress:
false` queues the new run rather than killing the running one.

## Jobs

Three jobs, each gated by `if:` to fire only on the schedules they
care about (or any `workflow_dispatch`).

### `review` (always runs)

`runs-on: ubuntu-latest`, `timeout-minutes: 15`, `permissions: contents: read`.

Steps:

1. `actions/checkout@v4`.
2. **`Verify git is available`** — `git --version`. Phase 2's
   fingerprint generator shallow-clones target repos and would fail
   silently if a future ubuntu-latest image dropped git. The verify
   step makes any image change obvious in the log.
3. `actions/setup-python@v5` with `python-version: '3.11'`,
   `cache: 'pip'`, `cache-dependency-path: 'agent/requirements.txt'`.
4. `pip install -r agent/requirements.txt`.
5. **`Run PR reviewer`** with env block:
   - `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`
   - `GITHUB_TOKEN_PAT: ${{ secrets.PR_REVIEWER_PAT }}`
   - `REPOS: ${{ secrets.REPOS }}`
   - `ALLOW_AUTO_CLOSE: ${{ vars.ALLOW_AUTO_CLOSE || 'false' }}`
     (note: `vars.`, not `secrets.` — repository Variable not Secret)
   - `SUPABASE_URL: ${{ secrets.SUPABASE_URL }}`
   - `SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}`
   - `GITHUB_EVENT_NAME: ${{ github.event_name }}`
   - Runs `python agent/pr_reviewer.py`.
6. **`Send daily digest`** with
   `if: github.event.schedule == '0 7 * * *' || github.event_name == 'workflow_dispatch'`
   env block: `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `DIGEST_RECIPIENT`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GITHUB_EVENT_SCHEDULE`.
   Runs `python agent/send_digest.py`.

The digest step is a STEP inside the `review` job, not a separate
job. That guarantees the reviewer finishes before the digest fires
on the same trigger.

### `poll-human-actions`

```yaml
if: github.event.schedule == '0 */6 * * *' || github.event_name == 'workflow_dispatch'
```

`runs-on: ubuntu-latest`, `timeout-minutes: 10`, `permissions:
contents: read`.

Steps: checkout → setup-python → install deps → run
`python agent/track_human_actions.py` with env
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GITHUB_TOKEN_PAT` (the same
PR_REVIEWER_PAT — it needs PR read + commit list).

### `prompt-tuner`

```yaml
if: github.event.schedule == '0 8 * * 1' || github.event_name == 'workflow_dispatch'
```

`runs-on: ubuntu-latest`, `timeout-minutes: 15`. **Different
permissions:**

```yaml
permissions:
  contents: read
  pull-requests: write
```

The `pull-requests: write` permission is required because this job
opens a PR against the agent repo via the GitHub REST API. The
script uses `PR_REVIEWER_PAT` as the PAT (not the default
`GITHUB_TOKEN`) so the PR is attributed to a real user account and
branch protection / required-reviewers fire correctly.

Steps: checkout → setup-python → install deps → run
`python agent/prompt_tuner.py` with env:

- `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `GITHUB_TOKEN_PAT: ${{ secrets.PR_REVIEWER_PAT }}`
- `PROMPT_TUNER_BASE_BRANCH: ${{ vars.PROMPT_TUNER_BASE_BRANCH || 'main' }}`

`GITHUB_REPOSITORY` is set automatically by Actions — the script
uses it to know which repo to open the PR against.

## Cron schedules — at a glance

| Cron | What it fires | Why this cadence |
|---|---|---|
| `*/15 * * * *` | `review` job | Faster than the human's 1-hour reaction time; slower than rate limits |
| `0 7 * * *` | `review` + the `Send daily digest` step | Morning digest in IST / EST overlap window |
| `0 */6 * * *` | `poll-human-actions` | Drift signal updates fast enough; lighter cadence than the review scan |
| `0 8 * * 1` | `prompt-tuner` | Weekly is plenty — `human_actions` accrues slowly; daily would spam the agent repo |

`workflow_dispatch` always fires all three jobs (each `if:` includes
the `workflow_dispatch` disjunct). This makes manual runs from the
Actions tab a clean way to flush every pipeline.

## Job dependency graph

There are NO `needs:` chains. All three jobs are independent and may
run in parallel. The only cross-job ordering is implicit:

- The 15-min `review` cron writes to `reviews`.
- 6 hours later, `poll-human-actions` reads those `reviews` rows
  and writes `human_actions`.
- Weekly, `prompt-tuner` reads `human_actions` and opens a PR.

If you add a job that depends on another job's output (e.g. "send
Slack notification after digest"), use `needs:` rather than relying
on cron coincidence.

## Secret names — what's where

| Name | Type | Used by step |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | `review` (reviewer), `prompt-tuner` |
| `PR_REVIEWER_PAT` | secret | `review` (as `GITHUB_TOKEN_PAT`), `poll-human-actions`, `prompt-tuner` |
| `REPOS` | secret | `review` |
| `SUPABASE_URL` | secret | All three jobs |
| `SUPABASE_SERVICE_KEY` | secret | All three jobs |
| `GMAIL_USER` | secret | `review` (digest step) |
| `GMAIL_APP_PASSWORD` | secret | `review` (digest step) |
| `DIGEST_RECIPIENT` | secret | `review` (digest step) |
| `ALLOW_AUTO_CLOSE` | **variable** (not secret) | `review` |
| `PROMPT_TUNER_BASE_BRANCH` | **variable** (not secret) | `prompt-tuner` |

Variables vs secrets: `secrets.NAME` is encrypted, never visible in
logs even on echo. `vars.NAME` is plaintext, visible in logs. Use
variables for non-sensitive config (branch names, feature flags),
secrets for credentials.

## How to add a new job

Template:

```yaml
my-new-job:
  runs-on: ubuntu-latest
  if: github.event.schedule == '<cron>' || github.event_name == 'workflow_dispatch'
  timeout-minutes: <N>
  permissions:
    contents: read
    # add 'pull-requests: write' or 'issues: write' if you call those APIs
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with:
        python-version: '3.11'
        cache: 'pip'
        cache-dependency-path: 'agent/requirements.txt'
    - name: Install deps
      run: pip install -r agent/requirements.txt
    - name: Run my new thing
      env:
        SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
        SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        # ... whatever secrets/vars you need
      run: python agent/my_new_script.py
```

Then add the matching cron to the `on.schedule` list at the top.

Checklist when adding a job:

1. Pick a cron that doesn't collide with the others' wake-ups in a
   way that maxes pip-cache misses. Existing crons fire on
   `:00 / :15 / :30 / :45`, `:00` on the 7th hour, etc.
2. Always include `workflow_dispatch` in the `if:` so you can fire
   it manually.
3. Always include `cache: 'pip'` + `cache-dependency-path:
   'agent/requirements.txt'` so cold-start time stays around 30s
   instead of 90s.
4. Set explicit `permissions:` — default `read-all` is the GitHub
   default but explicit is better. Bump to write only what you need.
5. Set `timeout-minutes:` to a real number (current jobs use 10–15).
   Default is 360 min which is dangerous on a billing accident.

## Things to NOT do

- **Do not add a step that runs `python pr_reviewer.py` from a
  webhook-triggered path other than `pr-review.yml`.** Single
  source of truth — see `CLAUDE.md` § "Critical constraints" rule 3.
- **Do not bake secrets into the workflow file.** Always use
  `${{ secrets.X }}` or `${{ vars.X }}` indirection.
- **Do not use the default `GITHUB_TOKEN` for cross-repo writes.**
  It's scoped to the agent repo only. The agent's actual writes
  target external repos, so `PR_REVIEWER_PAT` is mandatory.
- **Do not lower `permissions:` below what the job needs.** That
  silently breaks the job at runtime, not at workflow-parse time.
- **Do not delete the `Verify git is available` step.** It's a
  cheap canary for image changes that would break the fingerprint
  generator.
