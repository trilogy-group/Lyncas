-- 018_pr_reports.sql
--
-- Per-PR "analysis report" rows produced by agent/report_generator.py
-- ~45 seconds after webhook_handler.py spawns both the reviewer
-- (pr_reviewer.py / review_graph.py) and the sandbox runner
-- (devpod_tester.py).
--
-- A report is NOT a third review pipeline. It's a *synthesis* layer:
-- the generator waits for the reviewer's row in `reviews` and the
-- sandbox's row in `pr_sandbox_results`, then asks Claude Sonnet to
-- compose a structured PR-level read on top of both signals:
--
--   * what_it_adds / use_case        — plain-English summary
--   * vision_alignment + reasoning   — is this PR pulling in the
--                                      direction the codebase wants
--                                      to go? Hard to express in the
--                                      review schema; easy here.
--   * the review's verdict / severity / bugs (denormalized for
--                                      cheap dashboard reads)
--   * the sandbox's overall / tests / build / preview URL (also
--                                      denormalized — querying
--                                      pr_sandbox_results joined to
--                                      this table is the common case
--                                      so a small join cost matters)
--   * merge_recommendation + confidence + reasoning — the
--                                      head-line verdict the report
--                                      page renders as a colored
--                                      badge
--   * report_markdown                 — the full markdown body Claude
--                                      produced, which the
--                                      /dashboard/reports page renders
--                                      and the "Download Report"
--                                      button serves as a .md file.
--
-- Cost: Sonnet, not Opus. The reviewer already paid the Opus toll
-- on the deep code-review side; the report is meant to be cheap and
-- frequent, so Sonnet's lower output rate ($3/$15 vs Opus's $15/$75
-- per 1M tokens) is the right tradeoff. See agent/report_generator.py
-- for the model constant.
--
-- Idempotency: unique(repo, pr_number). report_generator.py upserts
-- on that key, so a re-spawned report (e.g. operator manually
-- re-triggers the webhook on the same PR) overwrites in place rather
-- than accreting duplicates.
--
-- RLS: deliberately permissive ("anon read", "service write" with
-- using(true) — every role can read & write). This is the same
-- pattern migration 017 chose for npr_conversations: the actual
-- security boundary is the /api/reports route handler, which scopes
-- reads to the caller's watched_repos before returning. Writes only
-- ever come from agent/report_generator.py via the SUPABASE_SERVICE_KEY
-- (CLAUDE.md rule 5: that key is GitHub-Actions-only / EC2-only,
-- never client-side or in Vercel env), so a wide-open write policy
-- here doesn't expose an attack surface beyond what's already
-- enforced by SERVICE_KEY's blast radius.
--
-- How to run:
--   1. Apply migrations 001-017 first.
--   2. Open Supabase SQL Editor -> paste this file -> Run.
--   3. Verify in Table Editor: pr_reports exists, RLS is enabled,
--      both policies are present, and the unique index on
--      (repo, pr_number) exists.

create table if not exists pr_reports (
  id                    uuid primary key default gen_random_uuid(),
  -- Subject identifiers. Mirror reviews/pr_sandbox_results so the
  -- (repo, pr_number) tuple is the universal join key across the
  -- three tables.
  repo                  text not null,
  pr_number             int not null,
  -- Denormalized from `reviews`. Stored here so the reports page
  -- can render a card without a join (the report is the natural
  -- aggregation point for both PR-level metadata sources).
  pr_title              text,
  pr_author             text,
  -- Owner of the watched_repos row. Optional because report_generator.py
  -- runs from the agent's service context where auth.users is not
  -- the calling principal; the API route resolves ownership via
  -- watched_repos.user_id instead. References auth.users so a
  -- cascading delete cleans up reports when an account is wiped.
  user_id               uuid references auth.users(id),
  created_at            timestamptz default now(),

  -- Synthesis fields produced by Claude (see report_generator.py
  -- prompt). All free-text; the check-constrained columns below
  -- carry the structured signal.
  what_it_adds          text,
  use_case              text,
  vision_alignment      text check (
    vision_alignment in ('aligned', 'neutral', 'misaligned', 'unknown')
  ),
  vision_reasoning      text,

  -- Denormalized from `reviews` (the LangGraph reviewer's row).
  -- Kept verbatim so a future schema change in `reviews` doesn't
  -- silently warp historical reports. review_bugs is jsonb to
  -- preserve the structured Bug[] shape the reviewer emits.
  review_verdict        text,
  review_severity       int,
  review_bugs           jsonb,
  review_summary        text,

  -- Denormalized from `pr_sandbox_results` (devpod_tester.py's row).
  -- sandbox_overall mirrors the migration-015 CHECK constraint set
  -- ('pass' / 'fail' / 'no_tests' / 'error') but is NOT itself
  -- constrained — we tolerate 'not_run' here for the case where
  -- the sandbox row never landed (no DevPod connected, or the
  -- generator timed out on wait_for_data). sandbox_build_success
  -- is best-effort: pr_sandbox_results doesn't carry a dedicated
  -- column, so report_generator.py infers it from the
  -- test_output header or defaults to false.
  sandbox_overall       text,
  sandbox_tests_passed  int default 0,
  sandbox_tests_failed  int default 0,
  sandbox_build_success boolean,
  sandbox_app_url       text,

  -- The report's headline call. The four-value enum matches the
  -- color buckets the dashboard renders:
  --   merge            -> green
  --   request_changes  -> yellow
  --   reject           -> red
  --   needs_review     -> blue
  merge_recommendation  text check (
    merge_recommendation in (
      'merge', 'request_changes', 'reject', 'needs_review'
    )
  ),
  merge_confidence      text check (
    merge_confidence in ('high', 'medium', 'low')
  ),
  merge_reasoning       text,

  -- Full markdown body produced by Claude. Rendered on
  -- /dashboard/reports and served verbatim by the "Download Report"
  -- button (data URI -> .md file).
  report_markdown       text,

  unique(repo, pr_number)
);

alter table pr_reports enable row level security;

drop policy if exists "anon read pr_reports" on pr_reports;
create policy "anon read pr_reports" on pr_reports
  for select using (true);

drop policy if exists "service write pr_reports" on pr_reports;
create policy "service write pr_reports" on pr_reports
  for all using (true) with check (true);

-- Sort index for the reports page: newest-first feed.
create index if not exists pr_reports_created_at_idx
  on pr_reports(created_at desc);

-- Lookup index for the /api/reports/[repo]/[pr_number] route and
-- the sandbox card's "View Report" fetch. The unique constraint
-- above already creates one, but naming it explicitly makes the
-- query plan obvious in pg_stat_statements.
create index if not exists pr_reports_repo_pr_idx
  on pr_reports(repo, pr_number);
