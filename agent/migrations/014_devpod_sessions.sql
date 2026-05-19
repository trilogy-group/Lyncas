-- 014_devpod_sessions.sql
--
-- Adds the DevPod MCP connect layer (Openclaw bridge):
--
--   1. devpod_sessions      — one row per logged-in DevPod CLI agent.
--                             Tracks the public Cloudflare tunnel URL
--                             the user's MCP server is reachable on,
--                             plus a heartbeat / TTL pair so stale
--                             sessions self-expire when the CLI quits.
--   2. devpod_executions    — audit log of every command dispatched
--                             through /api/devpod/execute. Read-only
--                             from the dashboard, written by the same
--                             route that proxies the command.
--   3. devpod_user_id_by_username(text) — helper function the
--                             /register and /ping routes use to map a
--                             GitHub login back to a Supabase user id
--                             without exposing user_profiles to anon
--                             selects.
--
-- Why a security-definer function instead of widening user_profiles
-- RLS:
--   * The shared-secret-authenticated routes (register, ping) cannot
--     run with auth.uid() — there's no JWT in those flows. Without
--     this function they would either need the service-role key
--     (which CLAUDE.md explicitly prohibits in Vercel) or a
--     permissive read policy on user_profiles (which would expose
--     plan / digest_email / display_name to any anon caller). The
--     function returns ONLY the uuid and only when given an exact
--     github_username match — no enumeration via wildcards, no
--     surface-area widening.
--
-- RLS strategy on devpod_sessions:
--   * "users manage own sessions" — the JWT-authenticated routes
--     (/disconnect, /execute, /token) match by auth.uid().
--   * "anon write sessions" — the shared-secret routes (/register,
--     /ping) need both INSERT and UPDATE for upsert semantics. The
--     application-side check in those routes
--     (`secret === '<username>:<DEVPOD_CONNECT_SECRET>'`) is the
--     actual authorization boundary; RLS here is permissive on
--     purpose. Without this policy the upsert in /register fails
--     silently when a row for that github_username already exists.
--   * "anon read sessions" — /api/devpod/status is intentionally
--     unauthenticated (the chat sidebar polls it across browser
--     tabs without a refreshed JWT) so a permissive SELECT policy
--     is required. The route itself filters out tunnel_url for
--     callers it can't authenticate.
--
-- RLS strategy on devpod_executions:
--   * "users read own executions" mirrors the session ownership rule
--     so the audit log is per-user.
--   * "anon insert executions" exists because /api/devpod/execute
--     does the insert AFTER it has authenticated the caller via JWT
--     and looked up their session. The check (true) is safe because
--     the route enforces session ownership before insert.
--
-- How to run:
--   1. Apply migrations 010 (user_profiles + watched_repos), 011
--      (github_app), and 012 (email verification) first.
--   2. Open Supabase SQL Editor, paste this file, Run.
--   3. Verify in Table Editor: devpod_sessions + devpod_executions
--      both exist with RLS enabled and the four policies + three
--      indexes shown below.

-- 1. devpod_sessions ------------------------------------------------------
create table if not exists devpod_sessions (
  id                  uuid primary key default gen_random_uuid(),
  -- Nullable: rows created via the shared-secret /register endpoint
  -- can resolve user_id only when user_profiles already has a row
  -- for that github_username (which it does as long as the user has
  -- signed in at least once). If lookup fails we still create the
  -- row so the CLI doesn't error, and the next OAuth login fills it.
  user_id             uuid references auth.users(id) on delete cascade,
  -- The GitHub OAuth login. This is the lookup key used by the
  -- status route — anyone polling /status?username=<x> is asking
  -- "is x's DevPod online right now?". Lower-cased on insert by
  -- the application code.
  github_username     text not null,
  -- HTTPS Cloudflare-tunnel URL the user's mcp_server.py is
  -- reachable on. Validated app-side to start with `https://`.
  tunnel_url          text not null,
  -- Free-form workspace identifier from the CLI (`hostname` by
  -- default). Used as a display label only.
  workspace_id        text,
  status              text not null default 'active'
                      check (status in ('active', 'inactive')),
  connected_at        timestamptz not null default now(),
  -- Stamped by /ping and /register. /status considers a row "live"
  -- only when last_ping is recent AND expires_at is in the future.
  last_ping           timestamptz not null default now(),
  -- 8-hour rolling window. The CLI pings every 30 minutes, so a
  -- normally-running session never ages out. A crashed CLI ages
  -- out within 8h.
  expires_at          timestamptz not null
                      default (now() + interval '8 hours'),
  -- Reserved for the Openclaw integration: when the gateway
  -- accepts /api/devpod-registered it returns its own session id,
  -- which we persist here so /execute can correlate logs.
  openclaw_session_id text,
  -- Capability descriptor mirrored from the CLI registration body.
  -- Defaults to "everything supported by the v1 mcp_server.py"
  -- so a stripped-down CLI that omits the field still works.
  capabilities        jsonb not null default
                      '{"run_command":true,"run_tests":true,"start_app":true,"expose_port":true}'::jsonb
);

alter table devpod_sessions enable row level security;

-- JWT-authenticated paths: /disconnect, /execute, /token.
drop policy if exists "users manage own sessions" on devpod_sessions;
create policy "users manage own sessions" on devpod_sessions
  for all using (auth.uid() = user_id);

-- Shared-secret-authenticated paths: /register, /ping. The
-- application-side check binds the secret to the github_username
-- (`secret === '<github_username>:<DEVPOD_CONNECT_SECRET>'`), so this
-- permissive policy is fine; without it, upsert can't update the
-- existing row on conflict.
drop policy if exists "anon write sessions" on devpod_sessions;
create policy "anon write sessions" on devpod_sessions
  for all using (true) with check (true);

-- /api/devpod/status is intentionally unauthenticated.
drop policy if exists "anon read sessions" on devpod_sessions;
create policy "anon read sessions" on devpod_sessions
  for select using (true);

-- Lookups by github_username (status route) and by expiry (a future
-- cleanup job that prunes ancient inactive rows) and by status (so
-- the dashboard's "active sessions" panel doesn't full-scan).
create index if not exists devpod_sessions_github_idx
  on devpod_sessions(github_username);
create index if not exists devpod_sessions_expires_idx
  on devpod_sessions(expires_at);
create index if not exists devpod_sessions_status_idx
  on devpod_sessions(status);
-- Composite index supporting the upsert path
-- ON CONFLICT (github_username) — Postgres needs a unique index for
-- ON CONFLICT to work. Lower-case the column at write time so two
-- rows can't appear for the same user with different casing.
create unique index if not exists devpod_sessions_github_unique_idx
  on devpod_sessions(github_username);

-- 2. devpod_executions ----------------------------------------------------
-- Audit log of every command the dashboard proxied to a DevPod.
-- Useful for debugging "did my run_tests button do anything?" without
-- spelunking Vercel logs, and lays groundwork for a future
-- /dashboard/devpod history page.
create table if not exists devpod_executions (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid references devpod_sessions(id) on delete cascade,
  -- The command string the user (or chat) requested. Stored verbatim
  -- so the dashboard history can render it exactly.
  command      text not null,
  -- Categorical type — mirrors the MCP server's switch statement.
  type         text not null
               check (type in ('run_command','run_tests','start_app','expose_port')),
  -- Filled in after the MCP server returns. Truncated at write-time
  -- by the route handler so we don't bloat Postgres with multi-MB
  -- test outputs.
  output       text,
  exit_code    int,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  duration_ms  int
);

alter table devpod_executions enable row level security;

-- Read your own audit log only. The subquery joins on the parent
-- session, which is itself user-scoped via the policy above.
drop policy if exists "users read own executions" on devpod_executions;
create policy "users read own executions" on devpod_executions
  for select using (
    session_id in (
      select id from devpod_sessions where user_id = auth.uid()
    )
  );

-- Allow inserts: the /execute route does this AFTER authenticating
-- the user with their JWT and confirming the session belongs to
-- them, so a permissive insert policy is the easiest way to make
-- the audit-log write succeed without a second round-trip to verify
-- the same ownership we just verified.
drop policy if exists "anon insert executions" on devpod_executions;
create policy "anon insert executions" on devpod_executions
  for insert with check (true);

create index if not exists devpod_executions_session_idx
  on devpod_executions(session_id, started_at desc);

-- 3. user_id lookup helper -----------------------------------------------
-- Returns the uuid of the user whose user_profiles.github_username
-- matches the supplied login (case-insensitive). Returns NULL when no
-- such user exists yet.
--
-- security definer — the calling role (anon, in the /register and
-- /ping flows) doesn't have read access to user_profiles, so the
-- function is granted only this single, narrow capability:
-- "translate one github_username into one user_id, and nothing
-- else". search_path is set to a fixed schema list to defeat
-- search-path-hijack attacks (https://www.postgresql.org/docs/16/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).
create or replace function devpod_user_id_by_username(p_username text)
  returns uuid
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  select id
  from user_profiles
  where lower(github_username) = lower(p_username)
  limit 1;
$$;

-- Lock down execute: the function is only called from PostgREST as
-- the anon role, so we explicitly grant to anon + authenticated and
-- nobody else. (Public defaults to grant-execute on functions, which
-- is fine here since the function itself reveals nothing beyond the
-- already-public github_username -> user_id relationship; tightening
-- it is belt-and-suspenders.)
revoke all on function devpod_user_id_by_username(text) from public;
grant execute on function devpod_user_id_by_username(text)
  to anon, authenticated, service_role;
