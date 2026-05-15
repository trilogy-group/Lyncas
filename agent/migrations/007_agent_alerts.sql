-- 007_agent_alerts.sql
--
-- Phase 7: drift alerts. After each human_actions polling run,
-- track_human_actions.py computes two rolling-30-day rates:
--
--   false_close_rate   = false_closes  / total_closes
--   missed_issue_rate  = missed_issues / total_approves
--
-- When either crosses 5%, an agent_alerts row is inserted. The /learning
-- dashboard surfaces unresolved alerts as a red banner so the operator
-- knows the agent is degrading before false-close storms compound. To
-- avoid spamming, the poller does not insert a second alert of the same
-- type while a prior alert of that type still has resolved_at = NULL.
--
-- Resolution is manual for now (set resolved_at via SQL); v3 will add a
-- "mark resolved" button on /learning.
--
-- How to run:
--   1. Open Supabase project -> SQL Editor -> New query.
--   2. Paste this entire file and click Run.
--   3. Verify in Table Editor that `agent_alerts` exists.

create table if not exists agent_alerts (
  id              uuid primary key default gen_random_uuid(),
  raised_at       timestamptz not null default now(),
  alert_type      text not null,
  metric_value    numeric not null,
  threshold       numeric not null,
  resolved_at     timestamptz
);

create index if not exists agent_alerts_unresolved_idx
  on agent_alerts(raised_at desc)
  where resolved_at is null;

alter table agent_alerts enable row level security;

drop policy if exists "anon read agent_alerts" on agent_alerts;
create policy "anon read agent_alerts" on agent_alerts
  for select using (true);
