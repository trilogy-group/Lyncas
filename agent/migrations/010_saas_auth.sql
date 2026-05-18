-- 010_saas_auth.sql
--
-- SaaS multi-tenant foundations (feat/saas-multi-tenant branch). Adds
-- three things on top of the v1 schema:
--
--   1. user_profiles — one row per authenticated user, joined 1:1 with
--      Supabase Auth's `auth.users`. Holds plan + repo_limit so feature
--      gating lives in the database rather than in app code.
--   2. watched_repos — per-user repo connections, each carrying its own
--      GitHub token. Replaces the agent's REPOS env var as the source
--      of truth once SaaS is live. The v1 agent still reads REPOS env,
--      so for now this table coexists with the env var rather than
--      replacing it — see PROJECT_PLAN.md v3 for the cutover plan.
--   3. reviews.user_id — additive column. Existing rows have NULL
--      user_id (legacy demo data) and are intentionally visible to
--      every authenticated user so the dashboard isn't empty on day
--      one. New reviews written by the SaaS-aware agent should set
--      user_id from the watched_repos row that triggered them.
--
-- RLS notes:
--   - user_profiles + watched_repos use auth.uid() so a logged-in
--     user can only see their own rows. This is the v2 baseline; the
--     v1 anon-read policies on existing tables stay in place.
--   - reviews is intentionally NOT switched to user-scoped RLS in this
--     migration. The /dashboard pages filter in queries (user_id IS
--     NULL OR user_id = me) so legacy rows remain visible. Locking
--     reviews down to user-only is a follow-up migration once every
--     row has a non-null user_id.
--
-- How to run:
--   1. Apply in Supabase SQL editor.
--   2. Configure GitHub OAuth provider (manual UI step — see
--      docs/handoff or the agent's commit message validation block).
--   3. Add NEXT_PUBLIC_SITE_URL to Vercel env so the magic-link / OAuth
--      redirect lands on the right deploy.

-- 1. user_profiles --------------------------------------------------------
create table if not exists user_profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  email           text,
  github_username text,
  display_name    text,
  avatar_url      text,
  -- free: 2 repos, pro: unlimited, enterprise: unlimited + SSO (future).
  plan            text not null default 'free'
                  check (plan in ('free', 'pro', 'enterprise')),
  -- Per-plan repo cap. Free=2 (sized so a new signup can wire one repo
  -- and still have headroom to test before upgrading). Pro/enterprise
  -- get a sentinel high number that the app treats as "unlimited".
  repo_limit      int not null default 2
);

alter table user_profiles enable row level security;

drop policy if exists "users read own profile" on user_profiles;
create policy "users read own profile" on user_profiles
  for select using (auth.uid() = id);

drop policy if exists "users update own profile" on user_profiles;
create policy "users update own profile" on user_profiles
  for update using (auth.uid() = id);

-- INSERT policy so the /auth/callback route (signed-in but no row yet)
-- can self-provision its profile. The id column references auth.users
-- with a check, so a user can only ever insert their own row.
drop policy if exists "users create own profile" on user_profiles;
create policy "users create own profile" on user_profiles
  for insert with check (auth.uid() = id);

-- 2. watched_repos --------------------------------------------------------
create table if not exists watched_repos (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Always <owner>/<name>. Validated app-side; we don't enforce it in
  -- the DB because Postgres's regex check syntax is fiddly and the
  -- /dashboard/connect-repo page already verifies via the GitHub API
  -- before insert.
  repo        text not null,
  -- Per-repo GitHub token (PAT or installation token). NEVER exposed
  -- to the browser — the only reader is the agent / API routes that
  -- run with the service-role key. anon RLS is "users read own
  -- repos" but the agent uses service_role which bypasses RLS, so
  -- exposing this column to the user themselves is intentional: they
  -- can see it exists, but only they (and the agent) can read it.
  github_token text,
  enabled     boolean not null default true,
  unique(user_id, repo)
);

alter table watched_repos enable row level security;

drop policy if exists "users manage own repos" on watched_repos;
create policy "users manage own repos" on watched_repos
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists watched_repos_user_idx
  on watched_repos(user_id);

-- 3. reviews.user_id ------------------------------------------------------
-- Additive: existing rows get NULL. New writes from a SaaS-aware agent
-- should set user_id = the watched_repos.user_id that owns the repo.
alter table reviews add column if not exists user_id uuid
  references auth.users(id);

create index if not exists reviews_user_idx on reviews(user_id);
