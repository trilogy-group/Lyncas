# ARCHITECTURE.md — Night PR Reviewer

Technical reference for the v2 system as currently shipped. Companion docs:
[PROJECT_PLAN.md](PROJECT_PLAN.md) (v3 roadmap, tradeoffs, technical debt),
[CLAUDE.md](CLAUDE.md) (rules for AI assistants touching this code).

---

## System diagram

```
                                                ┌───────────────────────────────────┐
                                                │  Target GitHub repos              │
                                                │  (REPOS env var, comma-separated) │
                                                └────────────┬─────────┬────────────┘
                                                             │         │
                                          PR opened /        │         │  cron tick
                                          synchronize        │         │  (every 15m)
                                          (instant)          │         │
                                                             ▼         ▼
                                ┌────────────────────────────────────────────────────┐
                                │           GitHub webhook delivery                  │
                                │     POST  /api/webhook/pull-request                │
                                │     (HMAC-SHA256 verified, opened/synchronize)     │
                                └────────────────────────┬───────────────────────────┘
                                                         │
                                                         │ Vercel Function (Node 20)
                                                         │ dashboard/app/api/webhook/
                                                         │   pull-request/route.ts
                                                         │
                                                         │ workflow_dispatch
                                                         │ via AGENT_WORKFLOW_PAT
                                                         ▼
       ┌─────────────────────────────────────────────────────────────────────────────┐
       │              GitHub Actions  —  .github/workflows/pr-review.yml             │
       │   cron */15  ── review job ──→ python agent/pr_reviewer.py                  │
       │   cron 0 7   ── send-digest  ──→ python agent/send_digest.py                │
       │   cron 0 */6 ── poll-human-actions ─→ python agent/track_human_actions.py   │
       │   cron 0 8 mon ── prompt-tuner ──→ python agent/prompt_tuner.py             │
       └─────────────────────────────────────────────────────────────────────────────┘
                                                         │
                                                         │ Anthropic API
                                                         │ (claude-opus-4-5)
                                                         ▼
                          ┌──────────────────────────────────────────────────┐
                          │         LangGraph (agent/review_graph.py)        │
                          │                                                  │
                          │  repo_context → reviewer → critic → router       │
                          │                                       ↘ arbiter  │
                          │                                       ↓          │
                          │                                       final      │
                          └──────────────────────────────────────────────────┘
                                                         │
                                                         │ supabase-py service_role
                                                         ▼
       ┌─────────────────────────────────────────────────────────────────────────────┐
       │                                Supabase Postgres                            │
       │   reviews · runs · digests · repo_fingerprints · benchmark_runs ·           │
       │   human_actions · agent_alerts · prompt_tuner_runs                          │
       └─────────────────────────────────────────────────────────────────────────────┘
                                                         │
                                                         │ @supabase/ssr anon key
                                                         ▼
                          ┌──────────────────────────────────────────────────┐
                          │       Next.js 16 Dashboard (Vercel)              │
                          │       /  /repos  /pr/[id]  /runs  /learning      │
                          │       /benchmark  /settings                      │
                          └──────────────────────────────────────────────────┘
```

A push or PR-opened event hits the webhook in milliseconds; the Vercel
function dispatches the workflow; GitHub Actions cold-starts a runner
(~60–90s); `pr_reviewer.py` runs the graph, writes a row, posts the
comment. The 15-minute cron is the safety net for any missed delivery.

---

## Component breakdown

### `agent/review_graph.py` — the LangGraph

State schema is `ReviewState: TypedDict` (lines ~196–232 of the file).
Strictly matches what IMPROVEMENTS_V2 Phase 6 specified. PR metadata
(title, body, author, base ref) is **not** on the state — node
factories close over the `pr` dict so the state stays minimal.

**Nodes**, in execution order:

| Node | Builder | Output field | Purpose |
|---|---|---|---|
| `repo_context` | `_make_repo_context_node(pr)` | `diff_specific_context` | Reads the fingerprint, returns 4–8 bullet points scoped to the diff. Hard-truncates the diff to `_REPO_CONTEXT_DIFF_CHARS` (8000) before sending — the node's job is to summarize, not read every hunk. Non-fatal: any failure leaves `diff_specific_context = None` and the reviewer still runs. Returns `(no repo-specific context applies)` as a sentinel that maps to `None`. |
| `reviewer` | `_make_reviewer_node(pr, system_prompt)` | `reviewer_output` | Byte-identical to the pre-graph `review_pr_with_claude` user message so any change to `agent/prompt.md` flows through without code churn. Max tokens `_REVIEW_MAX_TOKENS = 2000`. |
| `critic` | `_make_critic_node(pr, system_prompt)` | `critic_output` | Adversarial pass. System prompt is `_CRITIC_FRAMING + base_system_prompt` so the critic shares the reviewer's rubric and JSON schema. User message wraps the reviewer's JSON inside a "challenge this" preamble. |
| `arbiter` (conditional) | `_make_arbiter_node(pr, system_prompt)` | `arbiter_output` | Only fires when `_route_after_critic` returns `"arbiter"`. Sees both prior JSON outputs and the original diff. Makes the binding final call. |
| `final` | `_final_node` | `final_verdict`, `final_severity`, `final_summary`, `final_bugs`, `escalated` | Picks the winner (arbiter if escalated, else reviewer), merges the bug union with `_merge_bug_lists` (Jaccard ≥ 0.6 on issue tokens for same-file pairs, exact `(file, line_hint)` for cross-file). |

**Routing logic** is `_route_after_critic(state) -> "arbiter" | "final"`:

```python
verdict_differs  = reviewer.verdict != critic.verdict
severity_differs = abs(reviewer.severity_score - critic.severity_score) >= 2  # ESCALATION_SEVERITY_DELTA
if verdict_differs or severity_differs:
    return "arbiter"
return "final"
```

The conditional edge is wired with
`graph.add_conditional_edges("critic", _route_after_critic, {"arbiter":"arbiter","final":"final"})`,
then `arbiter → final → END`.

**Public entry point** is `run_review_graph(pr, diff, repo_fingerprint=None)`.
The return shape is intentionally compatible with the pre-Phase-6
`review_pr_with_claude(...)` return so `format_review_comment`,
`should_auto_close`, and `upsert_review` in `pr_reviewer.py` work
unchanged. Adds three keys: `_critic_output`, `_arbiter_output`,
`_escalated`.

### `agent/pr_reviewer.py` — the main loop

`main()` is the entry point GitHub Actions invokes. Skeleton:

1. `insert_run()` — opens a `runs` row, captures `id`. Soft-fails to
   `None` on DB error so we still review even if Supabase is down.
2. For each `repo` in `REPOS`:
   - `list_open_prs(repo)` — fetches non-draft open PRs via GitHub API.
   - `get_or_refresh_fingerprint(repo)` — once per repo per run.
     Returns `(fingerprint, status)` where `status ∈ {"cached",
     "fresh", "unavailable"}`. Cache TTL is `FINGERPRINT_TTL_DAYS = 7`.
   - For each PR:
     - `already_reviewed(repo, num)` — looks for `REVIEW_MARKER` or
       `CLOSE_MARKER` in PR comments. **This is the idempotency
       boundary.** No marker → review; marker → skip.
     - `get_pr_diff(repo, num)` — raw unified diff via the
       `application/vnd.github.v3.diff` Accept header.
     - `run_review_graph(pr, diff, repo_fingerprint=...)` — the
       LangGraph.
     - `should_auto_close(review)` — applies the three-gate check
       (see below). Returns `(bool, reason_string)`.
     - If close: `format_close_comment(review)` → `close_pr(repo, num, comment)`.
       Comment is posted FIRST, then the PR is patched to `state=closed`.
     - Otherwise: `format_review_comment(review)` → `post_review_comment(repo, num, comment)`.
     - `upsert_review(...)` on `(repo, pr_number)` unique index. Soft-fails;
       the GitHub comment is already posted.
3. `finalize_run(run_id, reviews_created, skipped, errors)` — patches
   the `runs` row with `finished_at` + counters.

**The three-gate auto-close** lives in `should_auto_close(review)`:

```python
ALLOW_AUTO_CLOSE          = env == "true"        # opt-in, default false
AUTO_CLOSE_REQUIRED_VERDICT    = "request_changes"
AUTO_CLOSE_REQUIRED_CONFIDENCE = "high"
AUTO_CLOSE_MIN_SEVERITY        = 9
```

All three gates must pass AND the env var must be `true`. Each gate
has a known failure mode if removed:
- Without `verdict`, an `approve` with sky-high severity (model
  miscalibration) would close the PR.
- Without `confidence`, low-confidence high-severity guesses on tiny
  diffs would close the PR.
- Without `severity >= 9`, every `request_changes` would close the PR.

**Idempotency markers** (`REVIEW_MARKER`, `CLOSE_MARKER`) are
embedded HTML comments so they're invisible on GitHub but parsable
in the API response.

### `agent/send_digest.py` — daily digest

Triggered by either `github.event.schedule == "0 7 * * *"` or any
`workflow_dispatch`. Pipeline:

1. `collect_undigested_reviews()` — selects `reviews` where
   `digested_at IS NULL`, ordered by `severity_score DESC` so the
   worst PRs land at the top of the email.
2. **Empty-digest behavior** — if there are zero undigested rows
   AND `GITHUB_EVENT_SCHEDULE != DAILY_SCHEDULE` (`"0 7 * * *"`),
   skip sending. The proof-of-life ("all quiet") email only goes
   out on the daily run.
3. `build_digest(reviews)` returns `(subject, text_body, html_body)`.
   Subject is dynamic — different formats for "all quiet" vs
   "auto-closed" vs "errors" vs "bugs flagged" vs "all clean".
4. `send_email(...)` — `smtplib.SMTP_SSL("smtp.gmail.com", 465)`
   with the Gmail app password.
5. `record_digest_sent(...)` — inserts a `digests` row first.
6. `mark_reviews_digested(...)` — stamps `digested_at = now()` on
   the included reviews. Order matters: if step 6 fails, the
   `digests` row in step 5 is the reconciliation pointer.

Per-card rendering: `_render_pr_card` includes
`_render_top_bug` (severity-sorted top bug with code snippet),
`_render_context_badge` ("context: yes/no"), and a per-card cost
line computed from the row's `model` + tokens (Phase 3 additions).

### `agent/track_human_actions.py` — Phase 7 poller

Runs on the 6-hour cron. Pipeline:

1. `list_reviews_to_poll()` — reviews from the last
   `REVIEW_LOOKBACK_DAYS = 7` that don't already have a settled
   `human_actions` row (anything except `pending` is "settled").
2. For each, `get_pr_state(repo, num)` returns `state`, `merged`,
   `merged_at`, `base_ref`, `merge_commit_sha`.
3. If the review's `action == "commented"` AND `merged`:
   `has_revert_commit(repo, base_ref, merged_at, pr_number)` looks
   for commits on the base branch within `REVERT_LOOKBACK_DAYS = 7`
   whose first line matches `^revert.*#<pr_number>` (the GitHub
   "Revert this PR" UI format).
4. `classify(action, pr_state, reverted)` returns one of:

   ```
   action == "closed"   and pr_state.state == "open"   → "false_close"
   action == "closed"   and pr_state.state == "closed" → "agreement_close"
   action == "commented" and merged and reverted       → "missed_issue"
   action == "commented" and merged and not reverted   → "agreement_approve"
   else                                                → "pending"
   ```

5. `upsert_human_action(...)` on `review_id` unique index.
6. `compute_drift_and_alert()` — computes
   `false_close_rate = false_closes / total_closes` and
   `missed_issue_rate = missed_issues / total_approves` over
   `DRIFT_LOOKBACK_DAYS = 30`. Inserts an `agent_alerts` row when
   either > `DRIFT_THRESHOLD = 0.05` AND no unresolved alert of the
   same `alert_type` already exists (deduplication).

### `agent/prompt_tuner.py` — Phase 8 prompt-tuner

Runs weekly (Mondays 8am UTC). **The agent NEVER edits prompt.md
directly. The prompt-tuner only opens a PR.** A human must merge.

Pipeline:

1. `refresh_open_run_statuses()` — first thing, on every run. Polls
   GitHub for each `prompt_tuner_runs` row where `status = 'open'`
   and flips to `merged`/`closed`/`unknown` so the dashboard's
   "open" filter stays accurate without anyone touching it.
2. `list_recent_failures()` — `human_actions` rows where
   `action_type IN ('false_close', 'missed_issue')` and
   `observed_at > now() - PROMPT_TUNER_LOOKBACK_DAYS (30)`,
   newest first.
3. Bail if `len(failures) < PROMPT_TUNER_MIN_FAILURES = 3`. Too few
   evidence cases would produce a noisy prompt change.
4. `bundle_cases(failures)` — joins each failure with its review row
   and the current PR diff (truncated to `PER_DIFF_TRUNCATE_CHARS = 4000`).
   Cap at `PROMPT_TUNER_MAX_CASES = 12`.
5. `compute_baseline_accuracy()` — `agreements / non-pending` over
   the same lookback. This is the "before" number on the PR
   description.
6. `call_meta_prompt(...)` — Claude returns
   `{ new_prompt, rationale, accuracy_after_pct_estimate }`.
   System prompt is `_META_SYSTEM_PROMPT` (preserves structure,
   surgical edits over rewrites, "Hard rules" section is sacrosanct).
7. `compute_unified_diff(current_prompt, new_prompt, "agent/prompt.md")`.
   If empty, exit cleanly (model returned an unchanged prompt).
8. Open a PR on the agent repo:
   - Branch: `prompt-tuner/<YYYYMMDD-HHMMSS>` from `BASE_BRANCH`
   - `github_create_branch` (fails on 422 — refuses to overwrite)
   - `github_put_file("agent/prompt.md", branch, message, new_prompt, sha)`
   - `github_open_pr(...)` with `build_pr_body(...)` showing the
     failure-case table, rationale, baseline vs estimated accuracy
9. `insert_run(...)` — upsert one `prompt_tuner_runs` row on
   `(agent_repo, pr_number)` so the dashboard's `/learning` page
   can render it under "Pending prompt improvements".

### `agent/benchmark.py` — Sonnet vs Opus

Manual one-off. **NOT wired into GitHub Actions on purpose** — Opus
costs ~5× Sonnet per token and we don't want it firing on every PR.

Critical invariant: `benchmark.py` must always call
`review_pr_with_claude` (the single-pass baseline), **NOT**
`run_review_graph`. The Sonnet output is read verbatim from the
existing `reviews` row — never re-run — so the comparison isn't
confounded by Sonnet's own run-to-run variance. Forcing the Opus
re-run through the LangGraph would compare graph-Opus vs
single-pass-Sonnet, which would mix two independent variables.

`_match_bugs(sonnet_bugs, opus_bugs)` uses greedy Jaccard ≥ 0.7 on
`(file + first 60 chars of issue)`. Stores cost as `int micros` so
float rounding never bites summary math.

### `dashboard/` — Next.js 16 App Router

| Page | File | Data |
|---|---|---|
| `/` | `app/page.tsx` | 5 stat cards (`getStats`, `getAccuracyStats`), repo breakdown (`getRepoStats`), filterable/sortable reviews table (`getRecentReviews`), severity histogram, activity line chart |
| `/repos` | `app/repos/page.tsx` | `getRepoStats()` per-repo table |
| `/pr/[id]` | `app/pr/[id]/page.tsx` | `getReviewById(id)` + `getHumanAction(id)`. Renders deliberation (reviewer / critic / arbiter), bugs, human verdict |
| `/runs` | `app/runs/page.tsx` | `getRuns(limit=50)` |
| `/learning` | `app/learning/page.tsx` | `getAccuracyStats`, `getAccuracyOverTime`, `getRecentMisses`, `getAgentAlerts(unresolved=true)`, `getOpenPromptTunerRuns` |
| `/benchmark` | `app/benchmark/page.tsx` | `getBenchmarkRuns`, `getBenchmarkStats` |
| `/settings` | `app/settings/page.tsx` | Static config viewer |
| `POST /api/webhook/pull-request` | `app/api/webhook/pull-request/route.ts` | HMAC verify → workflow_dispatch |

**Server-component data flow.** Every page is `export const dynamic =
"force-dynamic"` and uses `await Promise.all([...])` to fan out
queries. Client components (`components/filters.tsx`,
`components/severity-chart.tsx`, etc.) are marked `"use client"` but
receive their data as serializable props — no client-side Supabase
calls in v1.

**Supabase clients.**
- `lib/supabase/server.ts` — `createSupabaseServerClient()` with
  `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
  No-op cookies adapter (required by signature, unused).
- `lib/supabase/client.ts` — `createSupabaseBrowserClient()` exists
  but is unused in v1.

**RLS posture.** Tables that the dashboard reads (`benchmark_runs`,
`repo_fingerprints`, `human_actions`, `agent_alerts`,
`prompt_tuner_runs`) have RLS enabled with an explicit
`anon read` policy. Older tables (`reviews`, `runs`, `digests`)
have RLS *disabled* per Phase 1 — the dashboard reads them with
the anon key directly, which works because no policies are required
when RLS is off.

### `.github/workflows/pr-review.yml` — four jobs, four crons

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'   # review scan
    - cron: '0 7 * * *'      # daily digest
    - cron: '0 */6 * * *'    # human-action poll + drift
    - cron: '0 8 * * 1'      # weekly prompt-tuner
  workflow_dispatch:
```

Jobs and what fires them:

| Job | Fires on | Steps |
|---|---|---|
| `review` | every cron + `workflow_dispatch` | checkout → setup-python → install deps → run `pr_reviewer.py` → conditionally run `send_digest.py` (the `if: github.event.schedule == '0 7 * * *' \|\| github.event_name == 'workflow_dispatch'` gate inside the same job) |
| `poll-human-actions` | `cron == '0 */6 * * *'` or `workflow_dispatch` | runs `track_human_actions.py` |
| `prompt-tuner` | `cron == '0 8 * * 1'` or `workflow_dispatch` | runs `prompt_tuner.py`, needs `permissions: pull-requests: write` |

Dependency graph: the four jobs are independent (no `needs:` chain).
The digest is a *step* inside the `review` job — guaranteed to run
after the reviewer step finishes successfully on the trigger that
gates it.

Concurrency group `pr-reviewer` with `cancel-in-progress: false`
prevents overlapping runs of the same workflow.

---

## Supabase schema

8 tables. Reviews is the hub; everything else either references
`reviews.id` (cascade-delete) or is independent.

| Table | Migration | Purpose | Key columns | Key relationships |
|---|---|---|---|---|
| `reviews` | 001 + 004 + 005 | One row per PR reviewed | `id` PK, `repo`, `pr_number`, `verdict`, `confidence`, `severity_score`, `summary`, `bugs jsonb`, `concerns jsonb`, `questions jsonb`, `praise jsonb`, `action`, `gate_reason`, `digested_at`, `repo_context_used`, `model`, `critic_output jsonb`, `arbiter_output jsonb`, `escalated` | Unique on `(repo, pr_number)`. FK target for `benchmark_runs`, `human_actions` (both cascade-delete) |
| `runs` | 001 | One row per `pr_reviewer.py` invocation | `id` PK, `started_at`, `finished_at`, `repos_scanned text[]`, `reviews_created`, `skipped`, `errors jsonb`, `trigger_source` | Standalone |
| `digests` | 001 | One row per email sent | `id` PK, `sent_at`, `review_ids uuid[]`, `review_count`, `closed_count`, `subject`, `trigger_source` | Logical (not FK) reference to `reviews.id[]` |
| `benchmark_runs` | 002 | One row per Sonnet-vs-Opus comparison | `id` PK, `review_id` FK → reviews(id) cascade, `sonnet_*`, `opus_*`, `verdict_agreement`, `severity_delta`, `bug_overlap_count`, `bugs_only_in_sonnet`, `bugs_only_in_opus`, `sonnet_cost_micros`, `opus_cost_micros` | FK to reviews. RLS-enabled, anon read |
| `repo_fingerprints` | 003 | Cached repo summaries | `id` PK, `repo unique`, `fingerprint text`, `last_updated`, `commit_sha`, `token_count` | Unique on `repo` for upsert. RLS-enabled, anon read |
| `human_actions` | 006 | One row per polled review | `id` PK, `review_id` FK → reviews(id) cascade, `action_type` check, `pr_state`, `reopened`, `merged`, `reverted`, `poll_count`, `notes` | FK to reviews. Unique on `review_id` for upsert. Partial index on `action_type = 'pending'`. RLS-enabled, anon read |
| `agent_alerts` | 007 | Drift threshold alerts | `id` PK, `raised_at`, `alert_type`, `metric_value numeric`, `threshold numeric`, `resolved_at` | Standalone. Partial index where `resolved_at IS NULL`. RLS-enabled, anon read |
| `prompt_tuner_runs` | 008 | One row per prompt-tuner PR | `id` PK, `pr_url`, `pr_number`, `pr_title`, `branch_name`, `base_branch`, `agent_repo`, `failure_case_count`, `failure_cases jsonb`, `proposed_diff`, `rationale`, `accuracy_before_pct numeric`, `accuracy_after_pct_est numeric`, `status` check (`open`/`merged`/`closed`/`unknown`), `status_observed_at` | Unique on `(agent_repo, pr_number)` for upsert. RLS-enabled, anon read |

**Migration numbering.** Files are `agent/migrations/NNN_<name>.sql`,
strictly ordered. Each migration is applied manually via the Supabase
SQL Editor. Next migration is `009_*.sql`.

---

## Data flow: a PR is opened — what happens, in order

1. **GitHub** fires a `pull_request` webhook event with
   `action = "opened"` and a body including `repository.full_name`,
   `pull_request.number`, `pull_request.html_url`, etc.
2. **Vercel function** (`dashboard/app/api/webhook/pull-request/route.ts`)
   receives the POST. Reads raw body, computes
   `expected = "sha256=" + HMAC(WEBHOOK_SECRET, body)`,
   `timingSafeHexCompare(expected, x-hub-signature-256)`. Rejects 401
   on mismatch.
3. Filters event: `x-github-event` must be `pull_request` AND
   `action ∈ {"opened", "synchronize"}`. Pings are answered with
   `{ pong: true }`; everything else is 200 `{ ignored: ... }`.
4. **`dispatchWorkflow(...)`** POSTs to
   `https://api.github.com/repos/${AGENT_REPO}/actions/workflows/${AGENT_WORKFLOW}/dispatches`
   with the `AGENT_WORKFLOW_PAT` and `{ ref, inputs: {} }`. GitHub
   returns 204. Function returns
   `{ ok: true, dispatched: true, action, trigger_repo, pr_number }`.
5. **GitHub Actions** wakes up. `pr-review.yml` runs the `review`
   job: checkout, setup-python 3.11, `pip install -r
   agent/requirements.txt`, then `python agent/pr_reviewer.py` with
   the full env block.
6. **`pr_reviewer.main()`** opens a `runs` row, iterates over
   `REPOS`.
7. For the repo of the just-opened PR:
   - `list_open_prs(repo)` returns it among the open PRs.
   - `get_or_refresh_fingerprint(repo)` checks
     `repo_fingerprints` for a row newer than 7 days. If hit, returns
     `(fingerprint, "cached")`. If miss, shallow-clones to
     `/tmp/fp-<slug>-XXXX`, reads README + dep file + 2-level dir
     tree, calls Claude summarizer, upserts the row, returns
     `(fingerprint, "fresh")`. Any failure ⇒ `(None, "unavailable")`.
8. `already_reviewed(repo, pr_number)` looks for our markers in
   PR comments. New PR ⇒ no match ⇒ continue.
9. `get_pr_diff(repo, pr_number)` fetches the unified diff
   (truncated at `MAX_DIFF_CHARS = 60_000`).
10. **`run_review_graph(pr, diff, repo_fingerprint=...)`**:
    - `repo_context` node distills the fingerprint into
      `diff_specific_context` (or `None` on failure).
    - `reviewer` node sends the system prompt (`agent/prompt.md`),
      the fingerprint, the diff-specific context, and the diff to
      Claude Opus 4.5. Parses JSON.
    - `critic` node runs adversarial pass on the reviewer's output.
    - `_route_after_critic` compares verdicts/severities. On
      disagreement, edge ⇒ `arbiter`. Else ⇒ `final`.
    - `final_node` selects the winner, merges the bug union.
    - `run_review_graph` returns a dict with summary, verdict,
      confidence, severity_score, bugs (merged), concerns, questions,
      praise, _input_tokens, _output_tokens, _truncated,
      _critic_output, _arbiter_output, _escalated.
11. **`should_auto_close(review)`** — three gates. Default
    `ALLOW_AUTO_CLOSE = false` ⇒ never close.
12. **`format_review_comment(review)`** builds the markdown and
    **`post_review_comment(repo, pr_number, body)`** POSTs to
    `/repos/{repo}/issues/{pr_number}/comments`.
13. **`upsert_review(...)`** writes to `reviews` on
    `(repo, pr_number)` conflict. Soft-fails — the GitHub comment
    is already up.
14. **`finalize_run(...)`** patches the `runs` row.
15. Future (within 6 hours): **`track_human_actions.py`** picks up
    this review on its next poll. As long as the PR is open with no
    revert, classification stays `pending`. Once the human reopens
    (false_close) or merges and reverts (missed_issue), the bucket
    flips and may contribute to a drift alert.
16. Future (within 24 hours): **`send_digest.py`** picks up the
    `digested_at IS NULL` row, includes it in the morning email,
    stamps `digested_at`.

---

## Environment variables

Every variable, every consumer, every storage location.

| Variable | Used by | Stored in | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `pr_reviewer.py`, `review_graph.py`, `prompt_tuner.py`, `benchmark.py` (via `pr_reviewer` import) | GitHub Actions secret | Must have access to `claude-opus-4-5` |
| `GITHUB_TOKEN_PAT` | `pr_reviewer.py`, `track_human_actions.py`, `prompt_tuner.py`, `benchmark.py` (via import) | GitHub Actions secret = `PR_REVIEWER_PAT` | Fine-grained PAT with `Pull requests: Read and write`, `Contents: Read-only`, `Metadata: Read-only` on target repos. Owned by `HarshBti1805`. Used to read diffs, post comments, list commits |
| `REPOS` | `pr_reviewer.py` | GitHub Actions secret | Comma-separated `owner/name,owner/name` |
| `ALLOW_AUTO_CLOSE` | `pr_reviewer.py` | GitHub Actions variable (not secret) | `"true"` to enable. Default `"false"` |
| `SUPABASE_URL` | All Python scripts; not the dashboard | GitHub Actions secret | Same project URL throughout |
| `SUPABASE_SERVICE_KEY` | All Python scripts | GitHub Actions secret | **service_role key — never in Vercel, never client-side** |
| `GMAIL_USER` | `send_digest.py` | GitHub Actions secret | Sender email |
| `GMAIL_APP_PASSWORD` | `send_digest.py` | GitHub Actions secret | Google app password (not Gmail password) |
| `DIGEST_RECIPIENT` | `send_digest.py` | GitHub Actions secret | Where the digest is mailed |
| `GITHUB_EVENT_NAME` | `pr_reviewer.py` | Set by Actions runtime | Used for `runs.trigger_source` |
| `GITHUB_EVENT_SCHEDULE` | `send_digest.py` | Set by Actions runtime | Detects the daily 7am cron to gate the "all quiet" email |
| `GITHUB_REPOSITORY` | `prompt_tuner.py` | Set by Actions runtime | `owner/name` of the agent repo (where the prompt-tuner opens its PR) |
| `PROMPT_TUNER_MIN_FAILURES` | `prompt_tuner.py` | optional env, default 3 | Min cases before opening a PR |
| `PROMPT_TUNER_MAX_CASES` | `prompt_tuner.py` | optional, default 12 | Caps bundle size into the meta-prompt |
| `PROMPT_TUNER_BASE_BRANCH` | `prompt_tuner.py` | GitHub Actions variable, default `main` | Branch the prompt-tuner PRs target |
| `PROMPT_TUNER_LOOKBACK_DAYS` | `prompt_tuner.py` | optional, default 30 | Failure-case lookback window |
| `NEXT_PUBLIC_SUPABASE_URL` | Dashboard (server + client) | Vercel env (Production + Preview + Development) | Public — `NEXT_PUBLIC_` prefix means it ships to the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard | Vercel env | Public — anon key, read-only via RLS |
| `WEBHOOK_SECRET` | `app/api/webhook/pull-request/route.ts` | Vercel env (server-only) | Same string configured in the GitHub webhook UI |
| `AGENT_WORKFLOW_PAT` | Webhook route | Vercel env | Fine-grained PAT with `actions: write` on the agent repo. **Different account from `GITHUB_TOKEN_PAT`** — see secrets map |
| `AGENT_REPO` | Webhook route | Vercel env | `owner/name` of the repo hosting `pr-review.yml` (NOT the repo a PR was opened against) |
| `AGENT_WORKFLOW` | Webhook route (optional) | Vercel env, default `pr-review.yml` | Workflow file name |
| `AGENT_WORKFLOW_REF` | Webhook route (optional) | Vercel env, default `main` | Git ref to dispatch on |

---

## Secrets map — why two PATs

Two distinct GitHub PATs are required. They live in two different
storage locations and have different ownership.

| PAT | Owned by | Stored as | Purpose | Why it can't be the other PAT |
|---|---|---|---|---|
| `PR_REVIEWER_PAT` (i.e. `GITHUB_TOKEN_PAT` in the script env) | **`HarshBti1805`** (the GitHub account that owns the *target* repos) | GitHub Actions secret on the agent repo | The Python agent uses this to list open PRs, fetch diffs, post review comments, list commits for revert detection, and (for the prompt-tuner) commit changes to `agent/prompt.md` on a feature branch | Fine-grained PATs can only access repos owned by the account that minted them. `harshsingla-ti` (who owns the agent repo) cannot mint a fine-grained PAT that reads `HarshBti1805/HackHelix-LLMHallucination` |
| `AGENT_WORKFLOW_PAT` | **`harshsingla-ti`** (the GitHub account that owns the *agent* repo with `pr-review.yml`) | Vercel environment variable | The Vercel webhook function uses this to call `POST /repos/{agent_repo}/actions/workflows/pr-review.yml/dispatches` so a PR event on a target repo triggers an Actions run on the agent repo | The PAT must have `actions: write` on the *agent* repo, which only an account that has admin on that repo can mint. `HarshBti1805` doesn't own the agent repo, so its PAT can't dispatch the agent's workflow |

The default `GITHUB_TOKEN` in Actions is also insufficient for the
agent's needs — it's scoped to the agent repo itself, not the
target repos, and would be unable to read diffs or post comments
anywhere except the agent repo.

The **service_role Supabase key** lives ONLY in GitHub Actions
secrets (used by every Python script). It must NEVER appear in
Vercel — the dashboard uses the anon key exclusively. The webhook
function also does not need a Supabase key because it doesn't write
to Supabase; the workflow it dispatches handles all DB writes via
the Python scripts.
