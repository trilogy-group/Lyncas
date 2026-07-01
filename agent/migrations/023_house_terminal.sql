2-- 023_house_terminal.sql
--
-- Adds the "house terminal" layer: a Lyncas-controlled Linux box
-- (EC2 for now) that exposes an interactive PTY over a WebSocket,
-- fronted by a Cloudflare tunnel, so a dashboard user who has NOT
-- connected their own DevPod can still open a real shell from the
-- browser (/dashboard/terminal).
--
-- This is the first slice of Improvements.md item 4 ("INTERNAL
-- TESTING ENV THAT RUNS HERE IN THE DASHBOARD VIA EC2 AND DOES THE
-- SAME AS THE DEVPOD WOULD"). For the current testing phase the box
-- is the SAME EC2 instance that already runs the webhook handler —
-- there is no per-user isolation yet (tracked separately). Treat the
-- shell as trusted-org-only until isolation lands.
--
--   house_terminal — one row per registered runner, keyed by
--                    workspace_id. Stores the public Cloudflare
--                    tunnel URL the PTY WebSocket server is reachable
--                    on plus a heartbeat / TTL pair so a crashed
--                    runner self-expires (mirrors devpod_sessions).
--
-- Auth model (mirrors devpod_sessions, migration 014):
--   * /api/terminal/register + /api/terminal/ping authenticate with a
--     shared secret (DEVPOD_CONNECT_SECRET) checked app-side; RLS is
--     permissive for anon writes so the upsert can update on conflict.
--   * /api/terminal/info reads the row (JWT-authenticated route) and
--     mints a short-lived HS256 token that the PTY server verifies at
--     the WebSocket handshake. The tunnel URL is NOT the security
--     boundary — the signed token is — so a permissive anon read
--     policy is acceptable (and lets a lapsed-JWT tab still render the
--     online/offline indicator, same as /api/devpod/status).
--
-- How to run:
--   1. Apply migrations 001–022 first.
--   2. Open Supabase SQL Editor → paste this file → Run.
--   3. Verify in Table Editor: house_terminal exists, RLS enabled,
--      the three policies + two indexes below are present.
--
-- RLS: enabled with anon read + anon write, exactly like
-- devpod_sessions. The app-side shared-secret check on register/ping
-- is the real authorization boundary for writes.

create table if not exists house_terminal (
  id            uuid primary key default gen_random_uuid(),
  -- Free-form runner identifier from the server (`hostname` by
  -- default, or LYNCAS_TERMINAL_WORKSPACE_ID). Unique so register can
  -- upsert on conflict — one row per physical/logical box.
  workspace_id  text not null,
  -- Human label shown in the dashboard header (e.g. "webhook-ec2").
  label         text,
  -- HTTPS Cloudflare-tunnel URL the PTY WebSocket server is reachable
  -- on. The dashboard swaps the scheme to wss:// client-side. Validated
  -- app-side to start with `https://`.
  ws_url        text not null,
  status        text not null default 'active'
                check (status in ('active', 'inactive')),
  connected_at  timestamptz not null default now(),
  -- Stamped by /register and /ping. /info considers a row "live" only
  -- when status='active' AND expires_at is in the future.
  last_ping     timestamptz not null default now(),
  -- 8-hour rolling window, same as devpod_sessions. The runner pings
  -- every 30 minutes so a healthy box never ages out; a crashed one
  -- ages out within 8h.
  expires_at    timestamptz not null default (now() + interval '8 hours')
);

alter table house_terminal enable row level security;

-- Shared-secret-authenticated paths: /register, /ping. The app-side
-- check (`secret === DEVPOD_CONNECT_SECRET`) is the authorization
-- boundary; this permissive policy is what lets the upsert update the
-- existing row on conflict.
drop policy if exists "anon write house_terminal" on house_terminal;
create policy "anon write house_terminal" on house_terminal
  for all using (true) with check (true);

-- /api/terminal/info reads this to surface online/offline + the
-- tunnel URL. The WebSocket handshake still requires a signed token,
-- so a permissive read is acceptable (mirrors devpod_sessions).
drop policy if exists "anon read house_terminal" on house_terminal;
create policy "anon read house_terminal" on house_terminal
  for select using (true);

-- Postgres needs a unique index for ON CONFLICT (workspace_id).
create unique index if not exists house_terminal_workspace_unique_idx
  on house_terminal(workspace_id);
-- Supports the /info "most recently pinged live runner" lookup.
create index if not exists house_terminal_ping_idx
  on house_terminal(last_ping desc);
