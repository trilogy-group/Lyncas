-- 019_rename_npr_to_lyncas.sql
--
-- Project rebrand: "Night PR Reviewer" -> "Lyncas". This migration
-- renames the conversation-history table created in migration 017
-- (npr_conversations) to lyncas_conversations, along with its index
-- and RLS policy, to keep the schema consistent with the new name.
--
-- The dashboard route moved from /api/npr/history to
-- /api/lyncas/history and now reads/writes lyncas_conversations.
-- Apply this migration BEFORE (or together with) deploying that code,
-- otherwise the route will query a table that no longer exists.
--
-- Safe to re-run: each step is guarded so applying it twice is a
-- no-op (matches the convention adopted for migrations >= 009).
--
-- How to run:
--   1. Open Supabase SQL Editor -> paste this file -> Run.
--   2. Verify in Table Editor: lyncas_conversations exists, RLS is
--      enabled, the "anon all lyncas_conversations" policy is
--      present, and the unique index on (github_username, repo)
--      still exists.

-- Rename the table only if the old name is still present. On a
-- database where 017 was never applied (or 019 already ran) this
-- is a no-op.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'npr_conversations'
  ) and not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'lyncas_conversations'
  ) then
    alter table npr_conversations rename to lyncas_conversations;
  end if;
end $$;

alter index if exists npr_conversations_user_recency_idx
  rename to lyncas_conversations_user_recency_idx;

alter table if exists lyncas_conversations enable row level security;

drop policy if exists "anon all npr_conversations" on lyncas_conversations;
drop policy if exists "anon all lyncas_conversations" on lyncas_conversations;
create policy "anon all lyncas_conversations" on lyncas_conversations
  for all using (true) with check (true);
