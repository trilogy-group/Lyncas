-- 002_benchmark_runs.sql
--
-- Storage for Sonnet-vs-Opus comparisons. Each row is one PR diff
-- evaluated by both models, with computed agreement metrics. Run
-- agent/benchmark.py to populate. The /benchmark dashboard page reads
-- from this table directly.
--
-- How to run:
--   1. Open Supabase project -> SQL Editor -> New query.
--   2. Paste this entire file and click Run.
--   3. Verify in Table Editor that benchmark_runs appears.
--
-- See IMPROVEMENTS.md and agent/benchmark.py for context.

create table benchmark_runs (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  review_id       uuid not null references reviews(id) on delete cascade,

  -- Snapshot of the PR being benchmarked. We store url + title here so
  -- the dashboard can render the row even if the reviews row is later
  -- mutated or deleted (review_id is FK on delete cascade so a deleted
  -- review removes its benchmark too — these fields cover the cases
  -- where the reviews row stays but title/url change).
  pr_url          text not null,
  pr_title        text not null,

  -- Sonnet output: copied from the original review at benchmark time
  -- so the comparison is fair even if the reviews row is later edited.
  sonnet_verdict        text not null,
  sonnet_confidence     text not null,
  sonnet_severity       int not null,
  sonnet_bugs           jsonb,
  sonnet_summary        text,
  sonnet_input_tokens   int,
  sonnet_output_tokens  int,

  -- Opus output: computed by benchmark.py against the same diff
  -- using the exact same prompt.md. Nullable so we can record a
  -- benchmark attempt even if the Opus call fails partway.
  opus_verdict          text,
  opus_confidence       text,
  opus_severity         int,
  opus_bugs             jsonb,
  opus_summary          text,
  opus_input_tokens     int,
  opus_output_tokens    int,

  -- Derived agreement metrics (computed in Python).
  --   bug_overlap_count   : bugs both models flagged (Jaccard >= 0.7
  --                         on file + first-60-chars-of-issue tokens)
  --   bugs_only_in_sonnet : Sonnet bugs with no Opus counterpart
  --   bugs_only_in_opus   : Opus bugs with no Sonnet counterpart
  verdict_agreement     boolean,
  severity_delta        int,
  bug_overlap_count     int,
  bugs_only_in_sonnet   int,
  bugs_only_in_opus     int,

  -- Cost in micro-USD (1 USD = 1,000,000 micros) — integer storage
  -- so float rounding never bites us in summary math.
  -- Sonnet pricing: $3  / 1M input, $15 / 1M output
  -- Opus   pricing: $15 / 1M input, $75 / 1M output
  sonnet_cost_micros    int,
  opus_cost_micros      int
);

create index benchmark_runs_review_idx on benchmark_runs(review_id);
create index benchmark_runs_created_idx on benchmark_runs(created_at desc);

-- The dashboard reads with the anon key, so anon must be able to SELECT.
-- The agent writes with the service_role key, which bypasses RLS, so we
-- don't need an INSERT policy.
alter table benchmark_runs enable row level security;
create policy "anon read benchmark_runs"
  on benchmark_runs for select
  using (true);
