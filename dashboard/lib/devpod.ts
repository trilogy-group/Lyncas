// dashboard/lib/devpod.ts
//
// Shared DevPod connect helpers. The /api/devpod/* routes split across
// two auth modes:
//
//   * Shared-secret (register, ping)
//       Authenticate by checking the `secret` body field equals
//       `<github_username>:<DEVPOD_CONNECT_SECRET>`. The CLI gets this
//       composite token from the dashboard's /api/devpod/token endpoint
//       and passes it as `--token`. Binding the secret to the username
//       removes the worst impersonation vector (one user using their
//       own token to register a session AS another user); the residual
//       weakness is that DEVPOD_CONNECT_SECRET is shared across all
//       users in the org, so a malicious user can still split their
//       own token to extract the secret and forge a token for any
//       other username.
//
//       This is intentional in the v1 design: the deployment is
//       expected to live inside one trusted org. A v2 hardening would
//       move to per-user random secrets stored on user_profiles.
//
//   * Supabase JWT (status (anon-readable), disconnect, execute, token)
//       Standard `getUser()` flow.
//
// All routes share the same Supabase server client + the user-id
// lookup function below.

import "server-only";

import { createSupabaseServerClient } from "./supabase/server";

export interface DevpodTokenParts {
  github_username: string;
  secret_body: string;
}

// Default capabilities — must match the JSON default on
// devpod_sessions.capabilities so a registration without a
// `capabilities` field still serializes the same shape.
export const DEFAULT_CAPABILITIES = {
  run_command: true,
  run_tests: true,
  start_app: true,
  expose_port: true,
} as const;

// Lower-case the username on every store / compare. GitHub treats
// `Octocat` and `octocat` as the same login; we normalize so the
// upsert's ON CONFLICT (github_username) doesn't end up with two
// rows for the same person.
export function normalizeGithubUsername(username: unknown): string {
  if (typeof username !== "string") return "";
  return username.trim().toLowerCase();
}

// Validate the shared-secret token. We expect exactly:
//   `<github_username>:<DEVPOD_CONNECT_SECRET>`
// The username comparison is case-insensitive (GitHub conventions)
// and constant-time on the secret half so timing doesn't leak the
// secret one char at a time.
export function verifyConnectToken(
  providedToken: unknown,
  claimedUsername: string,
  serverSecret: string | undefined,
): boolean {
  if (typeof providedToken !== "string") return false;
  if (!serverSecret) return false;
  const idx = providedToken.indexOf(":");
  if (idx <= 0) return false;
  const tokenUser = providedToken.slice(0, idx).trim().toLowerCase();
  const tokenSecret = providedToken.slice(idx + 1);
  if (tokenUser !== claimedUsername) return false;
  // Constant-time string compare. Using two TextEncoders keeps the
  // comparison byte-aligned and avoids JS string-interning shortcuts.
  const a = new TextEncoder().encode(tokenSecret);
  const b = new TextEncoder().encode(serverSecret);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// Resolve a Supabase user_id from a github_username. Calls the
// `devpod_user_id_by_username` security-definer function in
// migration 014 — direct SELECT on user_profiles is blocked by RLS
// for the anon role, which is what the shared-secret routes run as.
//
// Returns null when no profile matches (the user has never signed in
// with GitHub OAuth on this deploy yet) — callers may still create
// the session row with user_id=null so the CLI doesn't have to wait
// for a sign-in race.
export async function resolveUserIdByUsername(
  github_username: string,
): Promise<string | null> {
  if (!github_username) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("devpod_user_id_by_username", {
    p_username: github_username,
  });
  if (error) {
    console.warn(
      `[devpod] user_id lookup for github_username='${github_username}' failed: ${error.message}`,
    );
    return null;
  }
  // The function returns a uuid; PostgREST surfaces it directly as
  // the value (not wrapped in an object) for scalar functions.
  if (typeof data === "string" && data.length > 0) return data;
  return null;
}

// Same shape as resolveUserIdByUsername, but reads auth.users
// directly via the migration-016 security-definer function. Use
// this when you need to authenticate a github_username regardless
// of whether the user_profiles upsert has run — e.g. the X-DevPod-
// Token path on /api/chat, where the CLI's user MUST resolve even
// in the rare race where their profile row hasn't landed yet.
//
// Why a second helper instead of replacing resolveUserIdByUsername:
// the existing /register and /ping paths intentionally write
// `user_id=null` when the profile row is missing (the CLI does
// not have to wait for a OAuth-callback race to finish). Pointing
// those routes at auth.users would change that contract; we keep
// the user_profiles helper for them and add this one only for
// callers that need the canonical source.
export async function resolveUserIdByAuthUsername(
  github_username: string,
): Promise<string | null> {
  if (!github_username) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "devpod_user_id_by_auth_username",
    { p_username: github_username },
  );
  if (error) {
    console.warn(
      `[devpod] auth.users lookup for github_username='${github_username}' failed: ${error.message}`,
    );
    return null;
  }
  if (typeof data === "string" && data.length > 0) return data;
  return null;
}

// Notify the local Openclaw gateway (if any) that a new DevPod is
// online. Fire-and-forget — Openclaw not running is the steady state
// for deployments that aren't using it, so any error here is logged
// at debug level, not warn.
//
// 1.5s timeout: localhost shouldn't take longer than that, and a
// hung gateway must not block the /register response that the CLI
// is awaiting.
export async function notifyOpenclaw(payload: {
  github_username: string;
  tunnel_url: string;
  workspace_id: string | null;
}): Promise<void> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1500);
  try {
    await fetch("http://localhost:18789/api/devpod-registered", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
      cache: "no-store",
    });
  } catch {
    // Expected on most deploys (Openclaw is opt-in / local only).
    // Don't log — production noise.
  } finally {
    clearTimeout(t);
  }
}

// Validate a tunnel_url (must be https, must parse). Used by both
// /register and /ping (since /ping is sometimes the first time the
// CLI is sending us its tunnel URL after a Cloudflare reconnect).
export function isValidTunnelUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith("https://")) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// Default 8h TTL window. Centralized here so the migration default,
// the /register override, and the /ping refresh all agree.
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export function newExpiresAt(): string {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}
