-- 001_initial_schema.sql
--
-- Initial Supabase schema for night-pr-reviewer v2.
-- Creates three tables (reviews, runs, digests) plus their indexes/constraints.
--
-- How to run:
--   1. Open the Supabase project's web UI.
--   2. Go to SQL Editor → New query.
--   3. Paste the contents of this file and click "Run".
--   4. Verify in Table Editor that all three tables appear.
--
-- This migration is idempotent only in the sense that re-running it on a
-- clean database is fine; running it twice in a row will error on the
-- duplicate `create table`. If you need to re-run, drop the tables first
-- or wrap the statements in `create table if not exists` manually.
--
-- See IMPROVEMENTS.md (Phase 1) for the rationale behind these tables.

-- Each PR review the agent has done
create table reviews (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  repo            text not null,
  pr_number       int not null,
  pr_url          text not null,
  pr_title        text not null,
  pr_author       text,
  verdict         text not null check (verdict in ('approve','request_changes','comment')),
  confidence      text not null check (confidence in ('high','medium','low')),
  severity_score  int not null check (severity_score between 1 and 10),
  summary         text not null,
  bug_count       int not null default 0,
  bugs            jsonb,
  concerns        jsonb,
  questions       jsonb,
  praise          jsonb,
  action          text not null check (action in ('commented','closed')),
  gate_reason     text,
  input_tokens    int,
  output_tokens   int,
  digested_at     timestamptz,
  truncated       boolean default false
);

create unique index reviews_pr_unique on reviews(repo, pr_number);
create index reviews_digested_idx on reviews(digested_at) where digested_at is null;
create index reviews_created_idx on reviews(created_at desc);

-- Each run of the agent (for observability)
create table runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  repos_scanned   text[],
  reviews_created int default 0,
  skipped         int default 0,
  errors          jsonb,
  trigger_source  text
);

create index runs_started_idx on runs(started_at desc);

-- Each digest email sent (for audit / dashboard)
create table digests (
  id              uuid primary key default gen_random_uuid(),
  sent_at         timestamptz not null default now(),
  review_ids      uuid[] not null,
  review_count    int not null,
  closed_count    int not null,
  subject         text not null,
  trigger_source  text
);
