-- 006_human_actions.sql
--
-- Phase 7: ground-truth feedback layer. For every review the agent posts,
-- a poller (agent/track_human_actions.py, scheduled every 6 hours)
-- inspects the PR's current state on GitHub and classifies the human
-- response into one of five buckets:
--
--   agreement_close   — agent closed, PR is still closed (correct close)
--   false_close       — agent closed, human reopened (incorrect close)
--   agreement_approve — agent commented, PR merged cleanly (correct comment)
--   missed_issue      — agent commented, PR merged but a revert commit
--                        landed on the base branch within 7 days
--   pending           — not yet resolvable (PR still open, etc.)
--
-- The unique index on review_id makes upsert idempotent — repeated polls
-- of the same review overwrite the prior classification. The partial
-- index on (action_type) where action_type = 'pending' makes the
-- "what still needs polling?" query a cheap index scan.
--
-- RLS is enabled with an anon-read policy so the dashboard can render
-- /learning and the per-PR "Human verdict" section without holding a
-- service-role key.
--
-- How to run:
--   1. Open Supabase project -> SQL Editor -> New query.
--   2. Paste this entire file and click Run.
--   3. Verify in Table Editor that `human_actions` exists with the
--      action_type check constraint and the three indexes.

create table if not exists human_actions (
  id              uuid primary key default gen_random_uuid(),
  review_id       uuid not null references reviews(id) on delete cascade,
  observed_at     timestamptz not null default now(),
  action_type     text not null check (action_type in (
    'agreement_close',
    'false_close',
    'agreement_approve',
    'missed_issue',
    'pending'
  )),
  pr_state        text not null,
  reopened        boolean default false,
  merged          boolean default false,
  reverted        boolean default false,
  poll_count      int default 0,
  notes           text
);

create unique index if not exists human_actions_review_unique
  on human_actions(review_id);

create index if not exists human_actions_type_idx
  on human_actions(action_type);

create index if not exists human_actions_pending_idx
  on human_actions(action_type)
  where action_type = 'pending';

alter table human_actions enable row level security;

drop policy if exists "anon read human_actions" on human_actions;
create policy "anon read human_actions" on human_actions
  for select using (true);
