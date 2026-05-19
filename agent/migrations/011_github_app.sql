-- 011_github_app.sql
--
-- Replaces the PAT-only repo connection model (migration 010) with a
-- GitHub App installation flow. Both paths now coexist on the same
-- watched_repos row, distinguished by `token_type`:
--
--   token_type = 'pat'         -> credentials are watched_repos.github_token
--   token_type = 'github_app'  -> credentials are minted on demand from
--                                 watched_repos.github_installation_id via
--                                 github_app_installations + a short-lived
--                                 installation access token. github_token
--                                 stays NULL in this case.
--
-- The PAT path is kept on purpose — it's the only option for users
-- who can't install a GitHub App on a repo they don't admin, and it
-- matches the existing v1 agent which still reads github_token. The
-- /dashboard/connect-repo page makes the App flow the recommended
-- choice and collapses the PAT form behind an "Advanced" toggle.
--
-- How to run:
--   1. Apply 010_saas_auth.sql first if you haven't already (this
--      migration assumes watched_repos already exists with user_id,
--      repo, github_token, enabled).
--   2. Open Supabase project -> SQL Editor -> paste this file -> Run.
--   3. Verify in Table Editor: watched_repos now has the three new
--      columns, and github_app_installations exists with RLS on.

-- watched_repos: add the GitHub App fields. Existing rows (PAT-based)
-- get NULL installation_id and the default token_type='pat', which
-- matches their actual provenance.
alter table watched_repos
  add column if not exists github_installation_id bigint,
  -- `github_token` already exists from migration 010; the IF NOT
  -- EXISTS keeps this idempotent if 010 was applied as written.
  add column if not exists github_token text,
  add column if not exists token_type text not null default 'pat'
    check (token_type in ('pat', 'github_app'));

-- Faster lookup for the agent: when a webhook fires for a repo, we
-- need the user_id + installation_id without scanning the table.
-- Already covered by watched_repos_user_idx from 010 plus the
-- unique(user_id, repo) constraint, but an installation-id index is
-- handy when the agent revokes / refreshes a token in bulk.
create index if not exists watched_repos_installation_idx
  on watched_repos(github_installation_id)
  where github_installation_id is not null;

-- github_app_installations: one row per GitHub App install per user.
-- A single install can carry many repos (selected at install time on
-- GitHub) so this is a parent record; watched_repos rows reference
-- the same installation_id when token_type='github_app'.
create table if not exists github_app_installations (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  -- GitHub's numeric installation id. Globally unique across the
  -- GitHub App, so we enforce that here too. The agent uses this
  -- as the cache key when minting short-lived installation tokens.
  installation_id     bigint not null unique,

  -- The org or user the App was installed on. Stored verbatim from
  -- GET /app/installations/{id}.account.login so we can render
  -- "Installed on harshbti1805" without re-hitting GitHub.
  account_login       text not null,

  -- Account type drives UX nuances later (org-only billing rules,
  -- per-org repo grouping, etc.). Kept as a CHECK so a typo can't
  -- silently degrade the data.
  account_type        text not null
                      check (account_type in ('User', 'Organization')),

  -- Snapshot of the repo selection at install time. Refreshed on
  -- subsequent /auth/github-app/callback hits (the installation
  -- callback fires again when the user changes their selection
  -- inside GitHub). Watched_repos rows are the actual source of
  -- truth for "what the agent reviews"; this list exists mostly
  -- so the dashboard can reconcile orphans (installations whose
  -- repos haven't been provisioned into watched_repos yet).
  repos_selected      text[] not null default '{}',

  -- Stamped when GitHub notifies us the installation was suspended
  -- (via webhook, future work). Non-null means "ignore this install
  -- when minting tokens — they'll all 401 anyway". The current code
  -- doesn't read this yet; including it now avoids a follow-up
  -- migration when the webhook handler lands.
  suspended_at        timestamptz
);

alter table github_app_installations enable row level security;

drop policy if exists "users manage own installations" on github_app_installations;
create policy "users manage own installations" on github_app_installations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists github_app_installations_user_idx
  on github_app_installations(user_id);
