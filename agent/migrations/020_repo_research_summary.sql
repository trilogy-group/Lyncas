-- 020_repo_research_summary.sql
--
-- Adds a project-understanding summary to the chat "Research" panel.
--
-- Why:
--   The Research sidebar used to be a flat list of external links that
--   the LLM biased toward generic stack documentation (Next.js / MDN /
--   language docs). The new behaviour is project-aware: we first have
--   Claude describe WHAT the application actually is (its domain and
--   purpose, inferred from the repo fingerprint), then suggest research
--   on the *topics and features* that would help build THIS product —
--   not boilerplate framework docs.
--
--   `summary` stores that one-paragraph "what this project is" blurb so
--   it survives a cache hit (articles + summary are generated together
--   and invalidated together by `fingerprint_hash`).
--
-- Safe to re-run: the column add is guarded with `if not exists`.

alter table repo_research
  add column if not exists summary text;
