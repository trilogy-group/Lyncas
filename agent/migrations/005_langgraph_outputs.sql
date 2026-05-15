-- 005_langgraph_outputs.sql
--
-- Phase 6 replaces the single LLM call with a LangGraph multi-node graph:
--   diff + context → Reviewer → Critic → router → (Arbiter) → Final
--
-- We persist each non-final node's raw JSON output so the /pr/[id] dashboard
-- page can render the agent's internal deliberation (Phase 6 dashboard
-- addition, brought up in a later commit per scope rules). `escalated` is a
-- denormalized bool the router toggles when reviewer/critic disagree enough
-- to fire the arbiter — it makes filtering "show me the close debates" on
-- the dashboard a one-column lookup instead of an output-shape inspection.
--
-- All three columns are nullable / default-false so:
--   * historical rows do not need a backfill (they pre-date the graph),
--   * the webhook path can keep upserting without these fields and the row
--     will still land cleanly (the webhook is intentionally out of Phase 6
--     scope and stays on the single-call path for now).
--
-- How to run:
--   1. Open Supabase project -> SQL Editor -> New query.
--   2. Paste this entire file and click Run.
--   3. Verify in Table Editor that `reviews` has the three new columns.

alter table reviews
  add column if not exists critic_output  jsonb;

alter table reviews
  add column if not exists arbiter_output jsonb;

alter table reviews
  add column if not exists escalated      boolean not null default false;
