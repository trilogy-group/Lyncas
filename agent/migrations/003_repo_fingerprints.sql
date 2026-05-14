-- 003_repo_fingerprints.sql
--
-- Per-repo "fingerprint": a compact, Claude-generated summary of what the
-- repo is, what stack it uses, where things live, and what kinds of changes
-- are out-of-scope. Injected into the review prompt as REPOSITORY CONTEXT so
-- the reviewer knows whether a given diff is in-character for the project.
--
-- Caching: generated once via shallow `git clone` + Claude summarizer, then
-- read from this table for the next 7 days. The agent regenerates only when
-- the cached row is older than the TTL (or missing). This keeps the clone
-- cost off the hot path of every PR review.
--
-- How to run:
--   1. Open Supabase project -> SQL Editor -> New query.
--   2. Paste this entire file and click Run.
--   3. Verify in Table Editor that repo_fingerprints appears.
--
-- See IMPROVEMENTS_v2.md Phase 2 for full context.

create table repo_fingerprints (
  id              uuid primary key default gen_random_uuid(),

  -- "owner/name" — same shape the agent uses everywhere else.
  -- Unique so we never accumulate duplicate fingerprints for one repo.
  repo            text not null unique,

  -- The Claude-generated summary itself. Targets ~200-500 words; we cap
  -- the summarizer at 1200 output tokens which lands comfortably below.
  fingerprint     text not null,

  -- When this row was generated. Drives the 7-day cache TTL on the agent
  -- side: rows older than 7 days are treated as a cache miss and refreshed.
  last_updated    timestamptz not null default now(),

  -- HEAD SHA at the time we cloned. Useful for debugging "why does the
  -- fingerprint still mention the old framework" -- we can compare this
  -- against the repo's current HEAD to see how stale the snapshot is.
  commit_sha      text,

  -- Rough word count of the fingerprint; tracked so we can see at a glance
  -- if summaries are exploding in size (which would inflate review costs).
  token_count     int
);

create index repo_fingerprints_repo_idx on repo_fingerprints(repo);

-- Dashboard reads with the anon key, so anon must be able to SELECT.
-- Agent writes via service_role which bypasses RLS, so no INSERT policy needed.
alter table repo_fingerprints enable row level security;
create policy "anon read repo_fingerprints"
  on repo_fingerprints for select
  using (true);
