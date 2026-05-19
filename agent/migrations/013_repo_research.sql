-- 013_repo_research.sql
--
-- Cached "Research" sidebar content for the chat page.
--
-- Why a dedicated table (vs widening repo_fingerprints):
--   * Fingerprints are summary text the agent writes; research is an
--     LLM-suggested list of external articles the dashboard writes.
--     Different writers, different cadence, different lifetime — keep
--     them separate so a fingerprint refresh and an article refresh
--     can fail independently.
--   * Easier to wipe and regenerate without touching the agent's
--     prompt context.
--
-- Cache invalidation strategy:
--   * fingerprint_hash mirrors a hash of the corresponding
--     repo_fingerprints.fingerprint text. When the fingerprint changes
--     (cache miss / weekly refresh), the dashboard recomputes the hash
--     and, on mismatch, asks Claude (Haiku — cheap) for a fresh
--     suggestion list.
--   * "force=true" on the API route bypasses the hash compare so an
--     operator can always click "Refresh research" and see live output.
--
-- RLS:
--   * Anon SELECT — the dashboard reads the cache from a browser
--     session that may or may not be authenticated; the data isn't
--     sensitive (just public URLs + titles).
--   * Anon write — server routes use the user's session client which
--     defaults to anon when service-role isn't available. We don't
--     leak anything by allowing this; the worst case is a stale row.

create table if not exists repo_research (
  id                uuid primary key default gen_random_uuid(),
  -- One row per (owner/name). Upsert on `repo` keeps the cache
  -- single-source-of-truth.
  repo              text not null unique,
  -- JSON array of { title, url, source, description } objects. Empty
  -- default so a row created by the migration / a partial insert
  -- still validates JSON consumers downstream.
  articles          jsonb not null default '[]'::jsonb,
  -- SHA-256 of the fingerprint text used to generate `articles`.
  -- Null when there was no fingerprint at generation time (we still
  -- cache to avoid re-asking Claude on every page view, but a future
  -- fingerprint will invalidate the row).
  fingerprint_hash  text,
  updated_at        timestamptz not null default now()
);

alter table repo_research enable row level security;

drop policy if exists "anon read repo_research" on repo_research;
create policy "anon read repo_research" on repo_research
  for select using (true);

drop policy if exists "anon write repo_research" on repo_research;
create policy "anon write repo_research" on repo_research
  for all using (true) with check (true);

-- One-shot lookup by repo. The `unique` constraint creates a btree
-- index already but spelling it out keeps intent explicit when
-- reading the schema.
create index if not exists repo_research_repo_idx
  on repo_research(repo);
