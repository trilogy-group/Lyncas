-- 004_review_metadata.sql
--
-- Adds two columns the Phase 3 digest needs on every review:
--   * repo_context_used  — drives the "Repo context used" yes/no badge on
--                          each card in the daily email
--   * model              — the Claude model that produced the review, so the
--                          per-review cost line stays accurate even after a
--                          future production-model swap (Sonnet <-> Opus)
--
-- Both are nullable / default-false so backfilling historical rows is
-- unnecessary: pre-Phase-3 reviews will simply show "context: no" and a
-- cost line computed from whatever the production model was at the time
-- (best-effort, see send_digest.py for the fallback).
--
-- How to run:
--   1. Open Supabase project -> SQL Editor -> New query.
--   2. Paste this entire file and click Run.
--   3. Verify in Table Editor that `reviews` now has both new columns.

alter table reviews
  add column if not exists repo_context_used boolean not null default false;

alter table reviews
  add column if not exists model text;
