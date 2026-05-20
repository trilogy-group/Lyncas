-- 016_devpod_auth_user_lookup.sql
--
-- Adds a security-definer function that maps a github_username
-- (case-insensitive) to its auth.users id by reading the OAuth
-- metadata directly. This is the canonical source —
-- `user_profiles.github_username` (used by 014's
-- devpod_user_id_by_username) is a denormalized copy populated at
-- /auth/callback time, so it can lag (or be missing entirely) for
-- users where the upsert raced or failed.
--
-- Callers (dashboard/lib/devpod.ts → resolveUserIdByAuthUsername):
--
--   * /api/chat with the X-DevPod-Token header.
--     The in-DevPod `npr` CLI is allowed to query any repo the
--     deploy's PR_REVIEWER_PAT can reach (EC2 always has access),
--     so we skip the watched_repos ownership 403 — but we still
--     need a user_id for log lines and downstream RLS-scoped reads.
--     Pulling the id from auth.users guarantees the lookup works
--     even when user_profiles is missing.
--
-- The function is security-definer because auth.users is in the
-- `auth` schema, which the anon role cannot SELECT directly under
-- normal RLS. We pin search_path to `public, pg_temp` to defend
-- against the classic security-definer search-path hijack.
--
-- Lookup is case-insensitive — GitHub treats `Octocat` and
-- `octocat` as the same login, and our X-DevPod-Token format
-- normalizes the username to lowercase before sending.

create or replace function devpod_user_id_by_auth_username(p_username text)
  returns uuid
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  select id
  from auth.users
  where lower(raw_user_meta_data->>'user_name') = lower(p_username)
  limit 1;
$$;

revoke all on function devpod_user_id_by_auth_username(text) from public;
grant execute on function devpod_user_id_by_auth_username(text)
  to anon, authenticated, service_role;
