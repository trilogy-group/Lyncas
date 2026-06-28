-- 021_sandbox_gate.sql
--
-- Phase 1 of SANDBOX_TESTING_PLAN.md — "Make the gate real".
--
-- The DevPod sandbox used to produce a Cloudflare preview URL (and
-- start the live app inside the DevPod) whenever clone + install + build
-- succeeded, IGNORING the test outcome. A PR that failed its tests — or
-- had no tests at all — still got a live preview. These two per-repo
-- knobs let the gate withhold the preview when the PR didn't actually
-- pass its checks, while keeping the behavior configurable.
--
--   sandbox_block_on_test_failure
--     When true (default), a failing authored test suite withholds the
--     live preview. The single highest-impact fix: a preview now means
--     "this PR's tests passed in the user's workspace".
--
--   sandbox_require_tests_for_preview
--     When true, the ABSENCE of tests also withholds the preview (strict
--     repos that mandate test coverage). Default false so test-less
--     repos still get a preview — they just won't on a real test failure.
--
-- Both are read defensively by the sandbox runners (agent/devpod_tester.py
-- and dashboard/app/api/devpod/run-pr-tests) via `select *`, so the
-- pipeline keeps working with the pre-migration defaults until this is
-- applied.
--
-- How to run:
--   1. Apply migrations 001–020 first.
--   2. Open Supabase SQL Editor → paste this file → Run.
--   3. Verify in Table Editor: repo_rules has the two new boolean columns.
--
-- RLS: no changes. repo_rules' existing policies (migration 009) already
-- cover reads/writes of the new columns.

alter table repo_rules
  add column if not exists sandbox_block_on_test_failure boolean not null default true;

alter table repo_rules
  add column if not exists sandbox_require_tests_for_preview boolean not null default false;
