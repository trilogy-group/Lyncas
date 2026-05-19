-- 012_email_verification.sql
--
-- Per-user digest email + OTP verification (feat/saas-multi-tenant).
--
-- Two changes:
--   1. user_profiles gets two columns: digest_email (the verified
--      address the digest is sent to) and digest_email_verified (a
--      cached boolean so the dashboard doesn't have to join
--      email_verifications every render). digest_email is independent
--      of the auth.users email — a user may sign in with one address
--      but want digests delivered to another (e.g. a team alias).
--   2. email_verifications stores in-flight OTP codes. Rows are
--      ephemeral by design: created when a user requests a code,
--      stamped with verified_at on success, and ignored after
--      expires_at. We never delete rows here (audit trail), but a
--      cron could prune > 30d old.
--
-- RLS notes:
--   * Both tables are auth.uid()-scoped. Service role bypasses RLS
--     so the OTP-send route (which inserts) and the confirm route
--     (which selects + updates) work without surprise.
--   * digest_email_verified is set to false on every NEW write
--     of digest_email — we re-verify a freshly-typed address even
--     if the user previously verified it.

-- 1. user_profiles columns -------------------------------------------------
alter table user_profiles
  add column if not exists digest_email          text,
  add column if not exists digest_email_verified boolean not null default false;

-- 2. email_verifications --------------------------------------------------
create table if not exists email_verifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  email       text not null,
  -- 6-digit numeric OTP stored as text so leading zeros survive.
  -- We do NOT hash it: rows expire in 10 minutes, the OTP entropy
  -- is low (1M codes), and the surface is a per-user table with
  -- RLS-enforced access. A leaked DB dump would yield expired or
  -- short-window codes only.
  otp         text not null,
  created_at  timestamptz not null default now(),
  verified_at timestamptz,
  -- 10 minutes by default — short enough that a leaked email can't
  -- be replayed casually, long enough for a real user to switch
  -- tabs / unlock their phone / paste.
  expires_at  timestamptz not null default (now() + interval '10 minutes')
);

alter table email_verifications enable row level security;

drop policy if exists "users manage own verifications" on email_verifications;
create policy "users manage own verifications" on email_verifications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Two compound indexes — both queries the confirm route does are covered.
create index if not exists email_verifications_user_idx
  on email_verifications(user_id, created_at desc);
create index if not exists email_verifications_lookup_idx
  on email_verifications(user_id, email, verified_at);
