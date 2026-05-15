-- 008_prompt_tuner_runs.sql
--
-- Phase 8: prompt-tuner agent ledger. The prompt-tuner runs as a separate
-- scheduled script (agent/prompt_tuner.py). Each time it finds enough
-- failure cases (false_close + missed_issue from human_actions, last 30d)
-- to justify a prompt change, it:
--
--   1. asks Claude to rewrite agent/prompt.md based on those cases,
--   2. opens a PR against the agent repo with the new prompt.md, and
--   3. inserts one row here so the /learning dashboard can list it.
--
-- The agent NEVER edits prompt.md on the main branch directly and NEVER
-- merges its own PR — a human must review every prompt change. This table
-- is purely a render-side ledger; the source of truth is the GitHub PR.
--
-- `status` is the cached PR state (open / merged / closed) so the
-- dashboard can render "pending prompt improvements" without paying a
-- GitHub API round-trip per page load. The script refreshes status on
-- every run by polling open rows.
--
-- `failure_cases` is a JSON array of {review_id, repo, pr_number, pr_url,
-- pr_title, action_type, observed_at, summary} — the evidence bundle that
-- drove this proposal, denormalized so the dashboard doesn't need to
-- re-join human_actions/reviews to render the card.
--
-- `proposed_diff` is a unified-diff text rendering of prompt.md (old vs
-- new) that the dashboard shows in a <pre> block; we keep it on the row
-- so the dashboard never has to fetch the PR diff from GitHub.
--
-- RLS is enabled with anon-read so /learning renders without holding a
-- service-role key.
--
-- How to run:
--   1. Open Supabase project -> SQL Editor -> New query.
--   2. Paste this entire file and click Run.
--   3. Verify in Table Editor that `prompt_tuner_runs` exists.

create table if not exists prompt_tuner_runs (
  id                       uuid primary key default gen_random_uuid(),
  created_at               timestamptz not null default now(),
  pr_url                   text not null,
  pr_number                int not null,
  pr_title                 text not null,
  branch_name              text not null,
  base_branch              text not null,
  agent_repo               text not null,
  failure_case_count       int not null,
  failure_cases            jsonb not null,
  proposed_diff            text not null,
  rationale                text,
  accuracy_before_pct      numeric,
  accuracy_after_pct_est   numeric,
  status                   text not null default 'open'
                           check (status in ('open', 'merged', 'closed', 'unknown')),
  status_observed_at       timestamptz not null default now()
);

create unique index if not exists prompt_tuner_runs_pr_unique
  on prompt_tuner_runs(agent_repo, pr_number);

create index if not exists prompt_tuner_runs_open_idx
  on prompt_tuner_runs(created_at desc)
  where status = 'open';

alter table prompt_tuner_runs enable row level security;

drop policy if exists "anon read prompt_tuner_runs" on prompt_tuner_runs;
create policy "anon read prompt_tuner_runs" on prompt_tuner_runs
  for select using (true);
