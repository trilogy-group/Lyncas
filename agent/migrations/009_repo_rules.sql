-- 009_repo_rules.sql
--
-- Per-repo configuration written by the dashboard's /repos/<owner>/<name>/settings
-- page and read by agent/pr_reviewer.py before each review. Lets operators
-- pause a repo, tighten/loosen the auto-close gate, scope reviews to a path
-- subset, and inject custom instructions into the reviewer prompt — all
-- without touching agent/prompt.md (which would require a prompt-tuner PR).
--
-- One row per repo. Repos with no row use the agent's built-in defaults
-- (enabled, no path filters, no extra instructions, global CLOSE_SEVERITY_MIN
-- gate of 9). The agent treats "no row" and "row with all-default values"
-- identically — operators can leave most fields NULL.
--
-- Why anon write (v1):
--   The dashboard is unauthenticated. The /settings page writes through
--   the public anon role. This is an intentional tradeoff acceptable while
--   the dashboard is internal-only and behind a Vercel preview URL; the
--   `for all using (true)` policy is what unblocks v1. The condition that
--   would flip this is shipping the dashboard publicly, at which point
--   replace the all-policy with a write policy gated on an auth claim
--   (Phase 9 — see PROJECT_PLAN.md v3 roadmap).
--
-- Fields populated by the agent (vs. by the dashboard):
--   repo_directory_tree    — agent computes the unique directories present
--                            in each reviewed PR's diff, joins them with
--                            newlines, and upserts back to this row. The
--                            dashboard renders it read-only so operators
--                            can author watch_paths / skip_paths without
--                            guessing the repo's layout.
--   All other fields       — written by /repos/[repo]/settings.
--
-- How to run:
--   1. Open Supabase project -> SQL Editor -> New query.
--   2. Paste this file and click Run.
--   3. Verify in Table Editor that `repo_rules` exists with the expected
--      columns and that RLS is ON with two policies (read + all).

create table if not exists repo_rules (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  repo            text not null unique,

  -- Global toggle: if false, the agent skips this repo entirely on every
  -- run (cron + webhook). Useful for muting a noisy or paused repo
  -- without removing it from the REPOS env var.
  enabled         boolean not null default true,

  -- Auto-close override: if true, close ALL PRs regardless of severity,
  -- verdict, or confidence — overriding pr_reviewer.py's three-gate
  -- check. Intended for moribund repos you want to drain. The dashboard
  -- surfaces a red warning when this is on.
  auto_close_all  boolean not null default false,

  -- Path filters: agent only reviews PRs touching these paths. Empty
  -- array = review everything. Stored as a Postgres text[] so the agent
  -- can do a single membership check per file in the diff.
  watch_paths     text[] not null default '{}',

  -- Path exclusions: PRs touching ONLY these paths are skipped entirely
  -- without review (no comment, no Supabase row). Example value:
  -- ['README.md', 'docs/']. Prefix matching is the agent's job, not the
  -- DB's — entries can be exact file names or directory prefixes.
  skip_paths      text[] not null default '{}',

  -- Custom instructions injected into the review prompt with an
  -- OPERATOR RULES: header, before the diff. Free-form natural
  -- language ("auto-close all README-only PRs even if they look
  -- clean", "treat any change to auth/ as severity 9+", etc.).
  custom_instructions text,

  -- Plain-text contents of an uploaded rules file, appended to
  -- custom_instructions when both are set. We store the content here
  -- rather than a Storage object reference because the rules file is
  -- typically <50KB and we want the agent to read rules without a
  -- second round-trip.
  rules_file_content  text,

  -- Severity threshold override for the auto-close gate. NULL =
  -- inherit pr_reviewer.py's global AUTO_CLOSE_MIN_SEVERITY (9). Valid
  -- range 1..10; 1 means "close on any request_changes verdict" and
  -- 10 means "only close on a perfect-storm severity-10".
  auto_close_severity_threshold int check (
    auto_close_severity_threshold between 1 and 10
  ),

  -- Newline-separated directory paths observed in this repo's recent
  -- PR diffs. Populated by the agent (see upsert_repo_directory_tree
  -- in agent/pr_reviewer.py), displayed read-only in the dashboard so
  -- operators can pick watch/skip paths without leaving the page.
  repo_directory_tree text
);

create index if not exists repo_rules_enabled_idx
  on repo_rules(enabled)
  where enabled = false;

alter table repo_rules enable row level security;

-- anon read: every server and client component reads this table.
drop policy if exists "anon read repo_rules" on repo_rules;
create policy "anon read repo_rules" on repo_rules
  for select using (true);

-- anon write: the dashboard writes through the same anon key as it
-- reads with. See header comment for the (v1-only) rationale.
drop policy if exists "anon write repo_rules" on repo_rules;
create policy "anon write repo_rules" on repo_rules
  for all using (true) with check (true);

-- updated_at trigger: keep the column meaningful without forcing every
-- client to remember to set it. Re-uses Postgres' built-in PL/pgSQL.
create or replace function repo_rules_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

drop trigger if exists repo_rules_set_updated_at on repo_rules;
create trigger repo_rules_set_updated_at
  before update on repo_rules
  for each row
  execute function repo_rules_set_updated_at();
