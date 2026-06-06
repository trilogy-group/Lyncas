# CLAUDE.md — instructions for AI assistants

You (Claude Code, Cursor, or any AI assistant) are picking up an
ongoing project. Read this before doing anything. Then read
[ARCHITECTURE.md](ARCHITECTURE.md) and [PROJECT_PLAN.md](PROJECT_PLAN.md)
in that order.

---

## Project summary

Lyncas is an autonomous GitHub PR-reviewing agent. A
push or PR event triggers a Vercel webhook, which dispatches a
GitHub Actions workflow, which runs a Python agent. The agent
executes a LangGraph multi-node pipeline (repo-context → reviewer
→ critic → optional arbiter → final) using Claude Opus 4.5,
posts a structured review comment to the PR, optionally
auto-closes the PR behind a three-gate opt-in, mails a daily
digest, polls human follow-up actions for ground-truth labels,
and runs a weekly prompt-tuner that opens PRs proposing edits to
its own `agent/prompt.md`.

**Stack.**
- Python 3.11 agent (`agent/`): `anthropic`, `langgraph`,
  `supabase-py`, `requests`. Entry: `pr_reviewer.py`.
- Next.js 16 dashboard (`dashboard/`): App Router, React 19, TS 5,
  Tailwind v4, `@supabase/ssr`, Recharts. Deployed on Vercel with
  Root Directory = `dashboard/`.
- Postgres state in Supabase. 8 tables. RLS-enabled on Phase 2+
  tables; service_role writes from Actions, anon reads from Vercel.
- Orchestration via GitHub Actions cron (15-minute review,
  daily digest, 6-hourly poll, weekly prompt-tuner) + a Vercel
  webhook function that immediately dispatches the same workflow.

Phase 8 is the last completed phase. v3 starts from
[PROJECT_PLAN.md](PROJECT_PLAN.md) § "v3 roadmap".

---

## How to orient yourself

**Read in this order. Don't skip.**

1. **CLAUDE.md** (this file) — the constraints.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — system diagram, every
   component, every env var, the data flow.
3. **[PROJECT_PLAN.md](PROJECT_PLAN.md)** — what's done, what's
   next, what we deliberately deferred.
4. **`agent/pr_reviewer.py`** — `main()` and the helpers around it.
   This is the source of truth for "what the agent does in
   production." Pay attention to `should_auto_close`,
   `upsert_review`, and the run/finalize flow.
5. **`agent/review_graph.py`** — `ReviewState` typed dict at the
   top, then `_route_after_critic`, then `run_review_graph`. The
   graph composition is at the bottom in `_build_graph`.
6. **`agent/prompt.md`** — the reviewer's system prompt. Has 7
   numbered hard rules + severity / verdict / output sections.
7. **`agent/prompt_tuner.py`** — `_META_SYSTEM_PROMPT` near the
   top tells you what the tuner is allowed to change.
8. **`agent/migrations/008_prompt_tuner_runs.sql`** — most recent
   migration. Glance at 001 → 008 in order to internalize the
   schema before writing any queries.
9. **`.github/workflows/pr-review.yml`** — three crons, four jobs.
10. **`dashboard/lib/queries.ts`** — every Supabase read in the
    dashboard. Mirror the field shapes here when adding queries.

If you're touching the dashboard, also read
`dashboard/AGENTS.md` (and the `node_modules/next/dist/docs/`
guide it references). Next.js 16 differs from older versions and
the project deliberately follows the current docs.

---

## Critical constraints — never violate

These are the rules the production system depends on. Every one
of them maps to actual code in this repo. Don't loosen any of
them without an explicit human decision.

### 1. The agent NEVER edits `agent/prompt.md` directly

Only `agent/prompt_tuner.py` writes to `prompt.md`, and only by
**opening a PR**. The agent commits the new prompt to a branch
named `prompt-tuner/<YYYYMMDD-HHMMSS>` and immediately opens a
PR against `BASE_BRANCH` (`main` by default). A human must merge.

Enforcement: the prompt-tuner script does not push to the base
branch. It uses `github_create_branch(...)` then
`github_put_file(...)` on that branch then `github_open_pr(...)`.
The auto-close gate is a separate concern; `prompt.md` is never
auto-closed against the agent.

If you find yourself wanting to programmatically change
`prompt.md` from anywhere other than the prompt-tuner's PR flow,
stop. Open a manual PR yourself instead.

### 2. The three-gate auto-close is sacrosanct

The agent only closes a PR when **all three** of these are true,
**plus** the `ALLOW_AUTO_CLOSE` env var is `"true"`:

```python
verdict     == "request_changes"
confidence  == "high"
severity_score >= 9
```

These constants are at the top of `agent/pr_reviewer.py`:
- `AUTO_CLOSE_MIN_SEVERITY = 9`
- `AUTO_CLOSE_REQUIRED_VERDICT = "request_changes"`
- `AUTO_CLOSE_REQUIRED_CONFIDENCE = "high"`

The composition is AND in `should_auto_close(review)`. Each gate
exists because removing it has a known failure mode (severity
inflation, low-confidence high-severity guesses on tiny diffs,
every `request_changes` would close). **Never loosen any of
these without an explicit human decision** recorded in
PROJECT_PLAN.md.

The default `ALLOW_AUTO_CLOSE = false` means the agent is opt-in
to closing anything at all. If you're tempted to flip the default
to `true`, see PROJECT_PLAN.md § "Known limitations" — there's
no production-validated false-close rate yet.

### 3. The webhook MUST NOT contain review logic

`dashboard/app/api/webhook/pull-request/route.ts` does exactly:

1. Verify HMAC-SHA256 signature.
2. Filter to `pull_request` event with `action ∈ {opened, synchronize}`.
3. Call `workflow_dispatch` on the agent repo's `pr-review.yml`.
4. Return 200.

It does NOT fetch the diff. It does NOT call Anthropic. It does
NOT touch Supabase. It does NOT format a review comment. **The
review runs in the GitHub Actions job, period.** This is the
single source of truth — if reviews ran in two places we'd get
prompt drift, parsing drift, auto-close drift.

If you're tempted to "save a step" by reviewing in the function,
read the comment block at the top of `route.ts`: Vercel has no
git binary, no Python, and a 10s default execution budget.

### 4. `benchmark.py` must call `review_pr_with_claude`, not `run_review_graph`

`agent/benchmark.py` imports `review_pr_with_claude, MODEL as
SONNET_MODEL` from `pr_reviewer` and calls it with
`model=OPUS_MODEL`. That function is the **single-pass baseline**.

Forcing the Opus re-run through `run_review_graph` would compare
"graph-Opus" vs "single-pass-Sonnet", which would mix two
independent variables (model choice + orchestration choice) and
make the bench unfit for purpose.

`review_pr_with_claude` is kept in `pr_reviewer.py` even though
production uses `run_review_graph`. The module comment at the top
of `pr_reviewer.py` (~line 21–23) explicitly says so. Don't
delete it. Don't migrate the bench to the graph "for consistency."

### 5. Supabase service_role key never goes client-side or to Vercel

`SUPABASE_SERVICE_KEY` is in GitHub Actions secrets only.
Consumers: `pr_reviewer.py`, `send_digest.py`,
`track_human_actions.py`, `prompt_tuner.py`, `benchmark.py`.

Vercel uses `NEXT_PUBLIC_SUPABASE_URL` +
`NEXT_PUBLIC_SUPABASE_ANON_KEY` only. Both are public — they ship
to the browser. RLS policies on `repo_fingerprints`,
`benchmark_runs`, `human_actions`, `agent_alerts`, and
`prompt_tuner_runs` make anon reads safe; `reviews`, `runs`, and
`digests` have RLS disabled (Phase 1 decision — anon can read
them freely).

If you find yourself writing a `dashboard/.../route.ts` that
needs server-side writes, add a separate `SUPABASE_SERVICE_KEY`
Vercel env var **only after** confirming with a human that the
write path actually needs it. Most "write" features should go
through a new Python script in `agent/` and a new workflow job
instead.

### 6. Idempotency depends on the GitHub PR comment marker

`already_reviewed(repo, pr_number)` checks for
`<!-- night-pr-reviewer:v1 -->` (REVIEW_MARKER) or
`<!-- night-pr-reviewer:closed:v1 -->` (CLOSE_MARKER) in PR
comments. Don't change the marker strings without bumping the
version suffix AND understanding that you'll re-review every
historical PR on the first run after.

The marker is the **only** thing preventing a re-review on every
15-min cron tick. Supabase-side idempotency on
`(repo, pr_number)` exists too (unique index + upsert), but the
GitHub-side check is what stops us from spamming the PR with
duplicate comments.

### 7. Order of operations in `send_digest.py` is load-bearing

The digest pipeline writes the `digests` row FIRST, then stamps
`digested_at` on the included `reviews`. The reverse order would
leave reviews silently digested with no audit record on a partial
failure. If you refactor `send_digest.main()`, preserve this
order.

### 8. `upsert_review` is "soft-fail on DB error"

In `pr_reviewer.py` main loop, the GitHub-side action (post
comment / close) happens **before** the Supabase upsert. If
Supabase is down, we still want the review on the PR. Don't add
"abort the comment if DB write fails" — that's a regression to
Phase 1 behavior. The corresponding pattern: `finalize_run` and
`insert_run` both soft-fail to `None`.

---

## Migration numbering

Next migration is **`009_*.sql`**. Existing migrations:

```
agent/migrations/
├── 001_initial_schema.sql      (reviews, runs, digests)
├── 002_benchmark_runs.sql      (benchmark_runs)
├── 003_repo_fingerprints.sql   (repo_fingerprints)
├── 004_review_metadata.sql     (reviews.repo_context_used, reviews.model)
├── 005_langgraph_outputs.sql   (reviews.critic_output, arbiter_output, escalated)
├── 006_human_actions.sql       (human_actions)
├── 007_agent_alerts.sql        (agent_alerts)
└── 008_prompt_tuner_runs.sql   (prompt_tuner_runs)
```

Conventions when writing `009_*.sql`:

- Use `if not exists` on every `create table`, `create index`,
  `alter table ... add column`. Existing migrations are inconsistent
  about this; new ones should be safely re-runnable.
- Use `drop policy if exists ... ; create policy ...` for RLS
  changes (see 006/007/008 for the pattern).
- Enable RLS and add an explicit `anon read` policy on any new
  table the dashboard will read.
- Add a header comment explaining what the migration adds and why,
  matching the style of 008.
- Migrations are applied **manually** via the Supabase SQL Editor.
  There's no migration runner. Don't write a runner without
  asking — adding one would be a v3 decision.

---

## Running the system locally

The agent needs network access to Anthropic, GitHub, and Supabase,
plus `git`. No local containers required.

```bash
# 1. Python deps
cd agent
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Env vars (.env file at agent/.env)
#    Required:
#      ANTHROPIC_API_KEY    sk-ant-...
#      GITHUB_TOKEN_PAT     github_pat_...   (PR_REVIEWER_PAT in Actions)
#      REPOS                "owner/repo1,owner/repo2"
#      SUPABASE_URL         https://....supabase.co
#      SUPABASE_SERVICE_KEY eyJ...
#    Optional:
#      ALLOW_AUTO_CLOSE     "false" (default) | "true"
#
# Load these into your shell, e.g. with `set -a; source .env; set +a`.

# 3. Run the reviewer once
python pr_reviewer.py

# 4. Run the digest (will email; needs Gmail vars too)
GMAIL_USER=... GMAIL_APP_PASSWORD=... DIGEST_RECIPIENT=... \
  python send_digest.py

# 5. Poll human actions
python track_human_actions.py

# 6. Run the prompt-tuner (will open a PR if there are ≥3 failures)
GITHUB_REPOSITORY=owner/night-pr-reviewer python prompt_tuner.py

# 7. Run the benchmark (manual, one-off — costs Opus tokens)
python benchmark.py --latest 5
```

Dashboard locally:

```bash
cd dashboard
npm install
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev   # http://localhost:3000
```

---

## How to validate the system is healthy

Run these in order before building anything. If any fail, fix
the system before adding features.

**5 SQL checks** (in the Supabase SQL Editor):

```sql
-- 1. Recent reviews are landing
select id, repo, pr_number, verdict, severity_score, created_at
from reviews
where created_at > now() - interval '7 days'
order by created_at desc
limit 10;

-- 2. Digests are stamping
select count(*) filter (where digested_at is null) as undigested,
       count(*) filter (where digested_at is not null) as digested,
       max(created_at) as latest_review
from reviews;

-- 3. Human-actions poller is alive
select action_type, count(*)
from human_actions
where observed_at > now() - interval '7 days'
group by action_type;

-- 4. No unresolved drift alerts
select alert_type, metric_value, threshold, raised_at
from agent_alerts
where resolved_at is null;

-- 5. Prompt-tuner runs have accurate status
select pr_number, status, status_observed_at
from prompt_tuner_runs
order by created_at desc
limit 5;
```

**Workflow trigger** (manual, in the GitHub Actions tab):

- Run `lyncas` via workflow_dispatch on `main`.
- Tail logs. Look for `[startup] Using model: claude-opus-4-5`
  followed by `[fingerprint:...]` and `[graph:...]` lines.
- A new row should appear in `runs` with `finished_at` set.

**Benchmark run**:

```bash
cd agent
python benchmark.py --latest 1
```

Confirms the Anthropic key works, the diff fetch works, and the
benchmark pipeline still writes to `benchmark_runs`.

If all 5 SQL checks return sensible data, the manual
workflow_dispatch run succeeds, and the benchmark writes a row,
the system is healthy.

---

## Common failure modes and how to diagnose them

Failure messages here are from real runs — search for the exact
string in stderr to find your case.

### `KeyError: 'ANTHROPIC_API_KEY'` (or `GITHUB_TOKEN_PAT`, `SUPABASE_URL`)

A required env var is unset. `pr_reviewer.py` uses
`os.environ["..."]` (raises on miss) for required vars and
`.get(...)` for optional. Diagnose: re-check the GitHub Actions
secrets, and confirm the workflow `env:` block actually passes
them through (see `.github/workflows/pr-review.yml` lines
50–60). Vercel-side: confirm in the project's Environment
Variables panel and re-deploy.

### `[ERROR] Could not list PRs for <repo>: 404 ...`

The `PR_REVIEWER_PAT` doesn't have access to that repo. Fine-grained
PATs are scoped per-account — make sure the PAT was minted by the
account that owns the target repo (`HarshBti1805` in production),
not the account that owns the agent repo (`harshsingla-ti`).

### `workflow_dispatch failed: 422 — Unprocessable Entity`

Webhook dispatch is hitting an invalid `ref`. Set
`AGENT_WORKFLOW_REF=main` in Vercel (or whatever your default
branch is). If the workflow file itself was just added on a
non-main branch, dispatch won't find it until that branch is
merged or `AGENT_WORKFLOW_REF` points at it.

### `workflow_dispatch failed: 403 — ...`

`AGENT_WORKFLOW_PAT` is missing the `actions: write` permission
on the agent repo. Re-issue the PAT with that scope. Remember
this PAT is from `harshsingla-ti`, not `HarshBti1805`.

### `[fingerprint:<repo>] clone failed (exit 128): ...`

`git clone` failed. Common causes: PAT lacks `Contents: Read-only`
on the target repo; target repo is empty or archived; clone URL
constructed wrongly. Fingerprint failures are non-fatal — the
review still runs with no `REPOSITORY CONTEXT` block, and the
PR comment shows `Repo context: unavailable`.

### `reviewer_node returned invalid JSON: ...`

Claude wrapped its response in something `_strip_outer_fence`
couldn't peel, or hallucinated unparseable JSON. Check the first
200 chars in the error message. The review fails for that PR,
the run continues. If this becomes frequent, it's a prompt
regression — check whether `agent/prompt.md` was recently
modified (look at recent merged PRs from the prompt-tuner).

### Reviews appear in dashboard but `digested_at` never sets

`send_digest.py` is failing partway. Check the GitHub Actions
log for the 7am UTC run (or any `workflow_dispatch`). Common
cause: `GMAIL_APP_PASSWORD` expired (Google revokes app passwords
when 2FA settings change). The pipeline aborts after the
`digests` row insert but before the stamp; reconcile manually with
`UPDATE reviews SET digested_at = now() WHERE id IN (...)` using
the IDs from the `digests.review_ids` array.

### `[prompt-tuner] under threshold (3); skipping`

Normal — there aren't enough settled `false_close` +
`missed_issue` cases in the last 30 days yet. Not a failure.
You can lower `PROMPT_TUNER_MIN_FAILURES` in the workflow env
for testing, but don't ship it below 3 — the meta-prompt
produces noisy output on fewer cases.

### Dashboard renders empty for every chart

`NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` is
wrong. Check the network tab — failed Supabase calls return 401
or 404. Confirm both env vars are set in Vercel for the
"Production" environment, not just "Preview" or "Development",
and redeploy.

### Vercel build fails with `Module not found: Can't resolve '@/lib/...'`

Root Directory isn't set to `dashboard`. Project Settings →
General → Root Directory → `dashboard` → Save → re-deploy.

### `psycopg2`-style errors when running migrations

You're using something other than the Supabase web SQL Editor.
Use the web editor — it handles auth and connection pooling for
you. The migrations are designed to be pasted into a "New query"
window and run.

### Reviewer comment renders with bare backticks instead of a code block

A `suggestion` field in the bug JSON contained ` ``` ` that wasn't
properly fenced. The renderer in `format_review_comment` /
`_render_bug_section` passes suggestions through as-is when they
already contain a fence. If the model produces malformed
fencing, the rendered comment looks broken. Not a code bug, a
prompt-output issue — track it and consider tightening the
schema description in `prompt.md` if it recurs.
