-- 017_npr_history.sql
--
-- Conversation history for the `npr` CLI. One row per
-- (github_username, repo) — switching repos in the same shell
-- gives a fresh conversation, but re-running `npr` inside the
-- same repo continues where you left off.
--
-- Filled by:
--   * dashboard/app/api/npr/history (POST upsert / DELETE clear),
--     which the npr CLI calls before and after every /api/chat
--     round trip. Auth is the same composite token
--     (<github_username>:<DEVPOD_CONNECT_SECRET>) the CLI already
--     persists at ~/.night-pr-reviewer/.token — see
--     dashboard/lib/devpod.ts::verifyConnectToken.
--
-- Why a dedicated table rather than widening user_profiles or
-- watched_repos:
--   * History is high-churn (every CLI invocation rewrites the
--     row), so storing it next to low-churn auth metadata would
--     hot-spot the user_profiles index.
--   * The row is also intentionally per-repo: a user juggling
--     three repos in three different shells doesn't want their
--     contexts cross-pollinating. Keeping the table narrow makes
--     that clear at the schema level.
--
-- Idempotency: unique(github_username, repo) so the CLI's POST
-- upsert always merges into the same row. Older messages are
-- trimmed by the route handler (last 20 entries kept = 10
-- user/assistant exchanges); the table itself does not enforce a
-- cap so we can grow that window without a migration.
--
-- RLS:
--   * Permissive "anon all" policy. The actual authorization
--     boundary is the route handler's verifyConnectToken check
--     (mirrors migration 014's pattern for devpod_sessions). RLS
--     stays permissive because the route runs as anon — the
--     /api/devpod/* family deliberately avoids the service_role
--     key in Vercel (CLAUDE.md rule 5).
--   * If you find yourself wanting to tighten this, port the
--     auth.uid() = user_id pattern from migration 015 — but only
--     after wiring resolveUserIdByAuthUsername() into the route
--     and persisting a user_id column here.
--
-- How to run:
--   1. Apply migrations 001–016 first.
--   2. Open Supabase SQL Editor → paste this file → Run.
--   3. Verify in Table Editor: npr_conversations exists, RLS is
--      enabled, the "anon all npr_conversations" policy is
--      present, and the unique index on (github_username, repo)
--      exists.

create table if not exists npr_conversations (
  id              uuid primary key default gen_random_uuid(),
  github_username text not null,
  repo            text not null,
  -- messages is an ordered array of {role, content} entries. The
  -- route handler is responsible for trimming to the last 20
  -- before writing; older messages are silently dropped. We use
  -- jsonb (not json) so PostgREST returns parsed arrays without
  -- the client having to JSON.parse the column.
  messages        jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  -- updated_at is set explicitly by the POST handler on every
  -- upsert so the column reflects the last CLI exchange, not the
  -- first insert. A trigger would also work, but every other
  -- table in this project tracks updates application-side; sticking
  -- to that convention keeps the migration footprint minimal.
  updated_at      timestamptz not null default now(),
  unique(github_username, repo)
);

alter table npr_conversations enable row level security;

drop policy if exists "anon all npr_conversations" on npr_conversations;
create policy "anon all npr_conversations" on npr_conversations
  for all using (true) with check (true);

-- Composite index supporting the dashboard's "most recently used
-- repos for this user" lookup (not wired up yet, but the cost is
-- zero and the index supports the foreseeable read pattern).
create index if not exists npr_conversations_user_recency_idx
  on npr_conversations(github_username, updated_at desc);
