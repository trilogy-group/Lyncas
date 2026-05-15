# Skill: Supabase schema reference

Dense reference for writing correct queries against the Supabase
project. Schema is defined by `agent/migrations/001…008_*.sql`,
applied in order through the Supabase web SQL Editor.

8 tables. RLS posture differs by migration generation: 001-era tables
(`reviews`, `runs`, `digests`) have RLS DISABLED; everything from 002
onwards has RLS ENABLED with an explicit `anon read` policy. The agent
side writes via the `service_role` key (bypasses RLS); the dashboard
reads via the anon key.

## `reviews` (migration 001 + 004 + 005)

Hub table. One row per PR reviewed.

| Column | Type | Constraint / default | Notes |
|---|---|---|---|
| `id` | `uuid` | PK, `default gen_random_uuid()` | |
| `created_at` | `timestamptz` | `default now()` | |
| `repo` | `text` | NOT NULL | `owner/name` |
| `pr_number` | `int` | NOT NULL | |
| `pr_url` | `text` | NOT NULL | |
| `pr_title` | `text` | NOT NULL | |
| `pr_author` | `text` | nullable | |
| `verdict` | `text` | NOT NULL, CHECK `('approve','request_changes','comment')` | |
| `confidence` | `text` | NOT NULL, CHECK `('high','medium','low')` | |
| `severity_score` | `int` | NOT NULL, CHECK `between 1 and 10` | |
| `summary` | `text` | NOT NULL | |
| `bug_count` | `int` | NOT NULL, default 0 | derived; set by `upsert_review` |
| `bugs` | `jsonb` | | array of bug objects |
| `concerns` | `jsonb` | | |
| `questions` | `jsonb` | | |
| `praise` | `jsonb` | | |
| `action` | `text` | NOT NULL, CHECK `('commented','closed')` | |
| `gate_reason` | `text` | nullable | populated when auto-close gates fail |
| `input_tokens` | `int` | nullable | summed across all graph nodes |
| `output_tokens` | `int` | nullable | summed across all graph nodes |
| `digested_at` | `timestamptz` | nullable | stamped by `send_digest.py` |
| `truncated` | `boolean` | default false | true if diff exceeded `MAX_DIFF_CHARS` |
| `repo_context_used` | `boolean` | NOT NULL, default false | mig 004; true when fingerprint was `cached` or `fresh` |
| `model` | `text` | nullable | mig 004; e.g. `claude-opus-4-5` |
| `critic_output` | `jsonb` | nullable | mig 005; raw critic JSON |
| `arbiter_output` | `jsonb` | nullable | mig 005; raw arbiter JSON; NULL when not escalated |
| `escalated` | `boolean` | NOT NULL, default false | mig 005; true when arbiter fired |

**Indexes:**

- `reviews_pr_unique` — UNIQUE on `(repo, pr_number)`. Drives the
  `upsert(..., on_conflict="repo,pr_number")` in `upsert_review`.
- `reviews_digested_idx` — partial on `(digested_at)`
  WHERE `digested_at IS NULL`. Drives `collect_undigested_reviews`.
- `reviews_created_idx` — `(created_at DESC)`. Drives the dashboard's
  recent-reviews fetch.

**FK targets** (cascade delete): `benchmark_runs.review_id`,
`human_actions.review_id`.

## `runs` (migration 001)

One row per `pr_reviewer.py` invocation.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `insert_run` returns this |
| `started_at` | `timestamptz` default `now()` | |
| `finished_at` | `timestamptz` | set by `finalize_run` |
| `repos_scanned` | `text[]` | copy of `REPOS` env at run start |
| `reviews_created` | `int` default 0 | count of successful Supabase upserts |
| `skipped` | `int` default 0 | count of `already_reviewed = true` |
| `errors` | `jsonb` | list of `{repo,error}` / `{pr,error}` objects |
| `trigger_source` | `text` | `os.environ["GITHUB_EVENT_NAME"]` |

Index: `runs_started_idx` on `(started_at DESC)`.

## `digests` (migration 001)

One row per email sent.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `sent_at` | `timestamptz` default `now()` | |
| `review_ids` | `uuid[]` NOT NULL | reviews included in this digest |
| `review_count` | `int` NOT NULL | |
| `closed_count` | `int` NOT NULL | |
| `subject` | `text` NOT NULL | final subject line |
| `trigger_source` | `text` | `"schedule"` (daily cron) or `"workflow_dispatch"` |

No FK on `review_ids` — it's a denormalized array. Treat it as
read-only history.

## `benchmark_runs` (migration 002, RLS enabled)

One row per Sonnet-vs-Opus comparison.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `created_at` | `timestamptz` default `now()` | |
| `review_id` | `uuid` FK → `reviews(id)` ON DELETE CASCADE | NOT NULL |
| `pr_url` | `text` NOT NULL | snapshot (in case reviews row mutates) |
| `pr_title` | `text` NOT NULL | snapshot |
| `sonnet_verdict` | `text` NOT NULL | copied verbatim from reviews row |
| `sonnet_confidence` | `text` NOT NULL | |
| `sonnet_severity` | `int` NOT NULL | |
| `sonnet_bugs` | `jsonb` | |
| `sonnet_summary` | `text` | |
| `sonnet_input_tokens` | `int` | |
| `sonnet_output_tokens` | `int` | |
| `opus_verdict` | `text` | nullable — Opus call may fail mid-bench |
| `opus_confidence` | `text` | |
| `opus_severity` | `int` | |
| `opus_bugs` | `jsonb` | |
| `opus_summary` | `text` | |
| `opus_input_tokens` | `int` | |
| `opus_output_tokens` | `int` | |
| `verdict_agreement` | `boolean` | derived |
| `severity_delta` | `int` | `abs(sonnet_sev - opus_sev)` |
| `bug_overlap_count` | `int` | matched via Jaccard ≥ 0.7 |
| `bugs_only_in_sonnet` | `int` | |
| `bugs_only_in_opus` | `int` | |
| `sonnet_cost_micros` | `int` | integer micro-USD; never floats |
| `opus_cost_micros` | `int` | |

**RLS:** enabled. Policy: `anon read benchmark_runs FOR SELECT USING (true)`.

Indexes: `benchmark_runs_review_idx (review_id)`,
`benchmark_runs_created_idx (created_at DESC)`.

## `repo_fingerprints` (migration 003, RLS enabled)

Per-repo cached summary.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `repo` | `text` UNIQUE NOT NULL | drives `upsert(on_conflict="repo")` |
| `fingerprint` | `text` NOT NULL | Claude-generated summary, ~200–500 words |
| `last_updated` | `timestamptz` default `now()` | TTL is `FINGERPRINT_TTL_DAYS = 7` in `pr_reviewer.py` |
| `commit_sha` | `text` | HEAD at clone time |
| `token_count` | `int` | word count for cost visibility |

**RLS:** enabled. Policy: `anon read repo_fingerprints`.

## `human_actions` (migration 006, RLS enabled)

Ground-truth label per review.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `review_id` | `uuid` FK → `reviews(id)` ON DELETE CASCADE | NOT NULL, UNIQUE for upsert |
| `observed_at` | `timestamptz` default `now()` | |
| `action_type` | `text` NOT NULL, CHECK `('agreement_close','false_close','agreement_approve','missed_issue','pending')` | |
| `pr_state` | `text` NOT NULL | `"open"` / `"closed"` / `"unknown"` |
| `reopened` | `boolean` default false | true iff `action_type == 'false_close'` |
| `merged` | `boolean` default false | |
| `reverted` | `boolean` default false | true iff revert commit found |
| `poll_count` | `int` default 0 | monotonic per (review_id) |
| `notes` | `text` | nullable; future-use for manual annotation |

**Indexes:**

- `human_actions_review_unique` UNIQUE on `(review_id)` — for upsert.
- `human_actions_type_idx` on `(action_type)`.
- `human_actions_pending_idx` partial on `(action_type)`
  WHERE `action_type = 'pending'` — fast scan for "what still needs polling".

**RLS:** enabled. Policy: `anon read human_actions`.

## `agent_alerts` (migration 007, RLS enabled)

Drift / threshold alerts.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `raised_at` | `timestamptz` default `now()` | |
| `alert_type` | `text` NOT NULL | e.g. `false_close_rate`, `missed_issue_rate` |
| `metric_value` | `numeric` NOT NULL | the rate that tripped the threshold |
| `threshold` | `numeric` NOT NULL | the threshold itself (e.g. 0.05) |
| `resolved_at` | `timestamptz` | nullable; manual for now |

Index: `agent_alerts_unresolved_idx` partial on `(raised_at DESC)`
WHERE `resolved_at IS NULL` — drives the dashboard banner.

**RLS:** enabled. Policy: `anon read agent_alerts`.

## `prompt_tuner_runs` (migration 008, RLS enabled)

One row per PR opened by `agent/prompt_tuner.py`.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `created_at` | `timestamptz` default `now()` | |
| `pr_url` | `text` NOT NULL | the prompt-tuner PR |
| `pr_number` | `int` NOT NULL | |
| `pr_title` | `text` NOT NULL | |
| `branch_name` | `text` NOT NULL | `prompt-tuner/YYYYMMDD-HHMMSS` |
| `base_branch` | `text` NOT NULL | usually `main` |
| `agent_repo` | `text` NOT NULL | the repo the PR was opened against |
| `failure_case_count` | `int` NOT NULL | |
| `failure_cases` | `jsonb` NOT NULL | denormalized; diff field stripped |
| `proposed_diff` | `text` NOT NULL | unified diff of `agent/prompt.md` |
| `rationale` | `text` | from the meta-prompt |
| `accuracy_before_pct` | `numeric` | baseline `agreements / non-pending` |
| `accuracy_after_pct_est` | `numeric` | model self-estimate |
| `status` | `text` NOT NULL default `'open'`, CHECK `('open','merged','closed','unknown')` | refreshed by `refresh_open_run_statuses` |
| `status_observed_at` | `timestamptz` NOT NULL default `now()` | |

**Indexes:**

- `prompt_tuner_runs_pr_unique` UNIQUE on `(agent_repo, pr_number)`
  — drives the upsert.
- `prompt_tuner_runs_open_idx` partial on `(created_at DESC)`
  WHERE `status = 'open'` — drives `getOpenPromptTunerRuns`.

**RLS:** enabled. Policy: `anon read prompt_tuner_runs`.

## Query patterns

**Upsert review on `(repo, pr_number)`:**

```python
supabase.table("reviews").upsert(payload, on_conflict="repo,pr_number").execute()
```

**Undigested rows ordered for the digest:**

```python
supabase.table("reviews").select("*").is_("digested_at", "null").order(
  "severity_score", desc=True
).execute()
```

**Stamp digested_at:**

```python
supabase.table("reviews").update({"digested_at": now_iso}).in_("id", ids).execute()
```

**Find non-pending observations for accuracy stats:**

```python
supabase.table("human_actions").select("action_type").gte(
  "observed_at", since_iso
).execute()
```

**Insert agent alert with dedupe:**

```python
existing = supabase.table("agent_alerts").select("id").eq(
  "alert_type", t
).is_("resolved_at", "null").limit(1).execute()
if not existing.data:
    supabase.table("agent_alerts").insert({...}).execute()
```

## Adding a new table — checklist

1. Pick the next migration number (current latest is 008; next is 009).
2. Use `create table if not exists` and `create index if not exists`.
3. Enable RLS: `alter table NEW_TABLE enable row level security;`
4. Add anon read policy:
   ```sql
   drop policy if exists "anon read NEW_TABLE" on NEW_TABLE;
   create policy "anon read NEW_TABLE" on NEW_TABLE for select using (true);
   ```
5. Add a header comment with how-to-run + which feature it serves.
6. Add the type in `dashboard/lib/types.ts`, mirroring column nullability.
7. Add the query function in `dashboard/lib/queries.ts`.
8. Document in `ARCHITECTURE.md` § "Supabase schema".

## Service_role vs anon — never confuse them

- `SUPABASE_SERVICE_KEY` — GitHub Actions only. Bypasses RLS.
  All Python scripts use it.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Vercel + browser. Subject to RLS.
  Dashboard uses it.

A leaked service_role key can write any row in any table. Treat
it like a database password.
