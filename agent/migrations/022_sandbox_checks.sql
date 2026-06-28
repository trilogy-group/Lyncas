-- 022_sandbox_checks.sql
--
-- Phase 3 of SANDBOX_TESTING_PLAN.md — "Diff-aware testing, static
-- analysis, security, and coverage".
--
-- Phase 1 (migration 021) made the preview gate real. Phase 2 broadened
-- the test/build matrix. Phase 3 adds quality checks LEFT of the gate —
-- lint, type-check, dependency audit, SAST, a diff-scoped secret scan,
-- and opportunistic coverage — and persists their structured results.
--
-- We store the per-check results as a single JSONB blob rather than a
-- column-per-check. Rationale (same one called out in the plan):
--   * The set of checks will keep growing (Phase 4 adds generated-test
--     counts) and a JSONB blob absorbs that without a migration each time.
--   * It sidesteps the rich-verdict CHECK-constraint problem hit in
--     migration 015 — `overall` stays the legacy 4-value enum; the
--     detailed signal lives in `checks`.
--
-- Shape of pr_sandbox_results.checks (all keys optional; absent == not run):
--   {
--     "diff":     { "changed_files": int, "base": string|null },
--     "lint":      { "status": "pass|fail|skip", "tool": string, "summary": string },
--     "typecheck": { "status": "pass|fail|skip", "tool": string, "summary": string },
--     "security": {
--       "secrets": { "status": "pass|fail|skip", "tool": "regex-diff",
--                    "count": int, "findings": string[] },
--       "audit":   { "status": "pass|fail|skip", "tool": string, "summary": string },
--       "sast":    { "status": "pass|fail|skip", "tool": "semgrep", "summary": string }
--     },
--     "coverage": { "status": "ok|skip", "pct": number|null, "tool": string }
--   }
--
-- gate_passed / gate_reason were folded into the GitHub comment + the
-- test_output column in Phase 1; they get real columns here so the
-- dashboard can read the gate decision without parsing free text.
--
-- repo_rules.sandbox_block_on_secrets makes the one new BLOCKING check
-- (a newly-added secret in the diff) configurable per repo, matching the
-- 021 pattern. Lint, type-check, audit, SAST, and coverage are advisory
-- and never block the preview.
--
-- How to run:
--   1. Apply migrations 001–021 first.
--   2. Open Supabase SQL Editor → paste this file → Run.
--   3. Verify: pr_sandbox_results has `checks` / `gate_passed` /
--      `gate_reason`; repo_rules has `sandbox_block_on_secrets`.
--
-- RLS: no changes. Existing policies on pr_sandbox_results (migration
-- 015) and repo_rules (migration 009) already cover the new columns.

alter table pr_sandbox_results
  add column if not exists checks jsonb not null default '{}'::jsonb;

alter table pr_sandbox_results
  add column if not exists gate_passed boolean;

alter table pr_sandbox_results
  add column if not exists gate_reason text;

alter table repo_rules
  add column if not exists sandbox_block_on_secrets boolean not null default true;
