-- 015_sandbox_results.sql
--
-- Per-PR sandbox test outcomes. Filled by:
--   * agent/devpod_tester.py (server-side, fired in parallel with the
--     LangGraph review when the PR-owning user has an active DevPod
--     session — see agent/webhook_handler.py).
--   * dashboard/app/api/devpod/run-pr-tests (on-demand from the chat
--     UI's "🧪 Run sandbox test" button).
--
-- The table is the single source of truth for "did this PR's tests
-- pass in the user's own workspace?", which the dashboard chat reads
-- back when rendering health reports and PR detail pages.
--
-- Why a dedicated table rather than widening `reviews`:
--   * The two pipelines (review vs sandbox) run in parallel and may
--     finish in either order. Co-locating them on `reviews` would
--     require either a partial-write contract (which row writes
--     first?) or sentinel "tests pending" values. Easier to keep
--     them separate and join when needed.
--   * The auto-close gate logic in pr_reviewer.py is documented as
--     load-bearing (CLAUDE.md). Adding test-result columns to
--     reviews would inevitably tempt someone to fold them into the
--     gate; keeping them on a separate table keeps the gate
--     contract visible.
--
-- Idempotency: unique(repo, pr_number) so a re-test of the same PR
-- (e.g. force-push, then "run sandbox test" again) overwrites the
-- prior row via upsert. Loses prior results but matches user
-- intent ("show me the LATEST sandbox state, not history").
--
-- RLS:
--   * users read own results — JWT path, joins via user_id.
--   * service write results — anon insert/update with check (true).
--     The dashboard write path (run-pr-tests) authenticates via
--     Supabase JWT before writing, and the agent path
--     (devpod_tester.py) writes via the service-role key (which
--     bypasses RLS anyway). So this permissive write policy only
--     matters for the rare case where the dashboard is using anon
--     credentials — keeping it broad lets the JWT path work without
--     a service_role key in Vercel (CLAUDE.md rule 5).
--
-- How to run:
--   1. Apply migrations 001–014 first.
--   2. Open Supabase SQL Editor → paste this file → Run.
--   3. Verify in Table Editor: pr_sandbox_results exists, RLS enabled,
--      both policies present, the unique index on (repo, pr_number).

create table if not exists pr_sandbox_results (
  id              uuid primary key default gen_random_uuid(),
  repo            text not null,
  pr_number       int not null,
  user_id         uuid references auth.users(id),
  -- The DevPod session this run executed on. Useful for pivoting
  -- "which sessions had test failures" without joining via user.
  -- ON DELETE SET NULL is implicit when the column is nullable;
  -- preserving the row even after the session expires keeps the
  -- audit trail intact.
  session_id      uuid references devpod_sessions(id) on delete set null,
  tests_passed    int default 0,
  tests_failed    int default 0,
  -- Truncated by the writer (16 KB cap is enough for most pytest /
  -- jest output and small enough that querying 30 of these for a
  -- repo report doesn't OOM the dashboard server).
  test_output     text,
  app_url         text,
  app_started     boolean default false,
  clone_success   boolean default false,
  install_success boolean default false,
  overall         text check (overall in ('pass','fail','no_tests','error')),
  created_at      timestamptz not null default now(),
  duration_ms     int,
  unique(repo, pr_number)
);

alter table pr_sandbox_results enable row level security;

drop policy if exists "users read own results" on pr_sandbox_results;
create policy "users read own results" on pr_sandbox_results
  for select using (auth.uid() = user_id);

drop policy if exists "service write results" on pr_sandbox_results;
create policy "service write results" on pr_sandbox_results
  for all using (true) with check (true);

-- Composite index supporting the dashboard's "latest sandbox state
-- for this repo's open PRs" lookup. The unique() above already
-- creates a btree on (repo, pr_number); this one orders by recency
-- so the chat report doesn't sort in memory.
create index if not exists pr_sandbox_results_repo_recency_idx
  on pr_sandbox_results(repo, created_at desc);
