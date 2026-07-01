// dashboard/lib/terminal.ts
//
// Shared helpers for the "house terminal" — a Lyncas-controlled Linux
// box (EC2 for now) that exposes an interactive PTY over a WebSocket so
// a dashboard user without their own DevPod can still open a live shell
// from /dashboard/terminal. First slice of Improvements.md item 4.
//
// Auth split (mirrors lib/devpod.ts):
//   * /api/terminal/register + /api/terminal/ping authenticate with a
//     shared secret (DEVPOD_CONNECT_SECRET) — the runner is trusted org
//     infra, not an end user, so a single shared secret is acceptable.
//   * /api/terminal/info is JWT-gated. It mints a short-lived HS256
//     token (signed with the SAME shared secret) that the PTY server
//     verifies at the WebSocket handshake. The tunnel URL is not the
//     security boundary; this signed token is.
//
// SECURITY NOTE (testing phase): the house terminal has NO per-user
// isolation yet — every authenticated dashboard user who opens the tab
// gets a shell on the same box. Keep this behind a trusted org until
// container/microVM isolation lands (tracked in Improvements.md item 4).

import "server-only";

import jwt from "jsonwebtoken";

// The token only needs to be valid long enough to complete the
// WebSocket handshake; the connection itself is long-lived. Two minutes
// is plenty and keeps a leaked token useless almost immediately.
export const TERMINAL_TOKEN_TTL_SEC = 120;

// 8h rolling window, matching devpod_sessions / house_terminal.
export const HOUSE_TERMINAL_TTL_MS = 8 * 60 * 60 * 1000;

export function houseTerminalExpiresAt(): string {
  return new Date(Date.now() + HOUSE_TERMINAL_TTL_MS).toISOString();
}

// The one shared secret used for both the register/ping check and the
// HS256 signing key. Reusing DEVPOD_CONNECT_SECRET means operators only
// have to set one value in both Vercel and on the EC2 box.
export function getTerminalSecret(): string | undefined {
  return process.env.DEVPOD_CONNECT_SECRET;
}

// Constant-time compare of a register/ping secret against the server
// secret. Unlike the DevPod token this is not username-bound — the
// runner is infra, not a person — so it's a straight equality check.
export function verifyTerminalSecret(
  provided: unknown,
  serverSecret: string | undefined,
): boolean {
  if (typeof provided !== "string" || !serverSecret) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(serverSecret);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Mint the WebSocket-handshake token for a signed-in user. HS256 so the
// stdlib-only Python server can verify it without PyJWT.
export function mintTerminalToken(params: {
  secret: string;
  userId: string;
  githubUsername: string | null;
}): string {
  return jwt.sign(
    {
      scope: "terminal",
      gh: params.githubUsername ?? undefined,
    },
    params.secret,
    {
      algorithm: "HS256",
      subject: params.userId,
      expiresIn: TERMINAL_TOKEN_TTL_SEC,
    },
  );
}

export function isValidWsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith("https://")) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// The runner registers its https:// Cloudflare tunnel URL; the browser
// connects over wss://. Swap the scheme (and strip any trailing slash)
// here so the client always gets a ready-to-use ws endpoint.
export function toWebSocketUrl(httpsUrl: string): string {
  return httpsUrl.replace(/^https:\/\//, "wss://").replace(/\/$/, "");
}
