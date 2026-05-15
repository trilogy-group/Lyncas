# Agent: Prompt Tuner (`agent/prompt_tuner.py`)

Out-of-band Phase 8 agent. NOT a LangGraph node — runs as its own
scheduled script. Triggered weekly on Mondays 8am UTC by
`.github/workflows/pr-review.yml`'s `prompt-tuner` job (and on any
manual `workflow_dispatch`).

## Role as currently implemented

Once a week, read every settled `false_close` and `missed_issue` row
from `human_actions` (last 30 days), bundle each with the original
review JSON and a fresh copy of the PR diff, ask Claude to propose a
revised `agent/prompt.md` that would have produced the *correct* call
on those failure cases, and **open a PR** against the agent repo with
the proposed new prompt.

The script also flips the `status` field on previously-open
`prompt_tuner_runs` rows by polling each PR's current state on GitHub,
so the dashboard's "open" filter stays accurate without anyone
touching it (`refresh_open_run_statuses()`).

## The human-approval requirement

**The agent NEVER edits `agent/prompt.md` directly. The agent NEVER
merges its own PR. A human must review every prompt change.**

This is implemented by:

1. The script creates a new branch
   `prompt-tuner/<YYYYMMDD-HHMMSS>` from `PROMPT_TUNER_BASE_BRANCH`
   (default `main`). It refuses to reuse an existing branch
   (422 from `github_create_branch` is treated as fatal).
2. The script commits the new `agent/prompt.md` to that branch only,
   via `github_put_file(..., branch=branch, ...)`.
3. The script calls `github_open_pr(...)` to open a PR.
4. The script EXITS. It does not poll, approve, or merge.

The PR body (`build_pr_body(...)`) includes a banner:

> **The agent never merges its own PR.** Review the diff and the
> rationale below before merging.

If you find this file because you're modifying the prompt-tuner,
preserve that invariant. Any change that lets the script merge its
own PR — or write directly to the default branch — is a regression.

## What constitutes a valid prompt change

The meta system prompt (`_META_SYSTEM_PROMPT`) defines the contract.
Claude is told:

- **Output strict JSON only.** No prose, no fences. Schema:
  `{new_prompt, rationale, accuracy_after_pct_estimate}`.
- **Preserve the prompt's structure.** Same headings, same order.
  Edit content, not skeleton.
- **Do NOT remove existing rules** unless directly contradicted by
  an evidence case. If you remove anything, justify it in the
  rationale.
- **The "Hard rules — these are non-negotiable" section is sacrosanct
  on intent.** Wording may sharpen; intent must not relax.
- **`accuracy_after_pct_estimate` is a rough guess (0..100).** Be
  conservative. When you can't credibly estimate an improvement,
  set it equal to the baseline.

Then `compute_unified_diff(current_prompt, new_prompt, "agent/prompt.md")`
runs. **If the diff is empty, the script exits cleanly without
opening a PR.** This is the normal path when the failure cases don't
actually point to a prompt change.

## Failure-bundling pipeline

The bundling steps in order, all in `main()`:

1. `refresh_open_run_statuses()` — poll GitHub for every
   `prompt_tuner_runs` row where `status == 'open'` and flip to
   merged/closed/unknown as appropriate. Non-fatal on error.
2. `list_recent_failures()` — query `human_actions` for
   `action_type IN ('false_close', 'missed_issue')` AND
   `observed_at >= now() - PROMPT_TUNER_LOOKBACK_DAYS (30)`,
   newest first.
3. Bail if `len(failures) < PROMPT_TUNER_MIN_FAILURES (3)`. Below
   this, the meta-prompt produces noisy or over-fitted output.
4. `bundle_cases(failures)` — for each failure (capped at
   `PROMPT_TUNER_MAX_CASES = 12`, oldest dropped first):
   - `fetch_review(review_id)` — pull the review row's verdict,
     confidence, severity, summary, bugs, action, critic_output,
     arbiter_output, escalated.
   - `fetch_pr_diff(repo, pr_number)` — refetch the diff from GitHub,
     truncated at `PER_DIFF_TRUNCATE_CHARS = 4_000` per case.
     Failures here are non-fatal; the case ships with an empty diff.
5. Bail again if `len(cases) < MIN_FAILURES` after the review-row
   join (some review rows may have been cascade-deleted).
6. `compute_baseline_accuracy()` — `agreements / non-pending` over
   the same 30-day window. This is the "before" number shown on
   the PR description.
7. `call_meta_prompt(current_prompt, cases, baseline_pct)` — one
   Claude call with `META_PROMPT_MAX_TOKENS = 4_000`. Strips
   outer fence, parses JSON, validates `new_prompt` is present.

## PR construction

If the diff is non-empty:

- Branch name: `prompt-tuner/<YYYYMMDD-HHMMSS>` (timestamp prevents
  collisions; if a collision occurs, `github_create_branch` raises
  rather than overwriting).
- Commit message:
  `prompt-tuner: propose prompt.md update from <N> failure cases`.
- PR title: same pattern with the timestamp appended.
- PR body: `build_pr_body(...)` renders rationale, baseline vs
  estimated-after, and a markdown table of failure cases with links
  to each PR.
- After `github_open_pr(...)` returns the PR dict:
  `insert_run(...)` upserts a `prompt_tuner_runs` row on
  `(agent_repo, pr_number)`. The heavy `diff` field is stripped from
  each case before persisting (the dashboard only renders pointers).

If the Supabase upsert fails after the PR was opened, the script
exits with code 1 (the PR exists but the dashboard won't show it
until the next run picks it up via `refresh_open_run_statuses`).
Log loudly to make this visible.

## Idempotency

The script can be re-run on the same evidence. Three safeguards
prevent duplicate noise:

1. `refresh_open_run_statuses` runs first, so a previously-open
   `prompt_tuner_runs` row that's been merged or closed flips
   status, allowing a fresh proposal in the next branch slot.
2. The timestamped branch name prevents accidental overwrites of a
   prior open PR.
3. If Claude's `new_prompt` matches the current `prompt.md` byte-for-byte
   after unified-diff computation, no PR is opened.

The `(agent_repo, pr_number)` unique index on `prompt_tuner_runs`
backstops case 1 — `upsert` re-uses the existing row if the
prompt-tuner somehow tries to open against the same PR number twice
(which shouldn't happen because branch names are timestamped).

## What it does NOT do

- Does NOT push to `BASE_BRANCH`. Only feature branches.
- Does NOT merge any PR. Only `github_open_pr`.
- Does NOT touch other files. Only `agent/prompt.md`.
- Does NOT call the reviewer/critic/arbiter graph nodes. The script
  is independent of the inline review pipeline.
- Does NOT lower `PROMPT_TUNER_MIN_FAILURES` below 3 silently. It's
  an env-overridable knob (`PROMPT_TUNER_MIN_FAILURES`) but the
  default is hardcoded.
