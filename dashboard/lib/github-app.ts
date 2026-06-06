// dashboard/lib/github-app.ts
//
// Server-only helpers for talking to GitHub as the Lyncas
// GitHub App. Two flavors of credential live in this module:
//
//   1. App JWT — short-lived (10 min) RS256 token signed with the App's
//      private key. Used to call:
//        GET  /app/installations/{id}
//        GET  /app/installations/{id}/repositories
//        POST /app/installations/{id}/access_tokens
//      Nothing else uses it; in particular the App JWT does NOT have
//      access to a repo's contents — it just identifies "this is the
//      App, asking for an installation-scoped token".
//
//   2. Installation token — short-lived (~1h) opaque string returned by
//      POST /app/installations/{id}/access_tokens. THIS is the
//      credential the agent uses to read diffs, post comments, and
//      close PRs. We mint a fresh one on demand rather than caching;
//      Phase 9 of PROJECT_PLAN.md sketches an optional per-installation
//      token cache once we're paying for the round-trip latency.
//
// IMPORTANT: This module is `import "server-only"` so it can never be
// pulled into a client bundle. The private key would leak otherwise.

import "server-only";

import * as crypto from "crypto";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

interface AppConfig {
  appId: string;
  privateKey: string;
}

// Centralized config read so a missing env throws once with a clear
// message rather than landing as a cryptic jwt.sign error inside
// node-jsonwebtoken.
//
// Vercel accepts the private key in either shape:
//   * Single-line with literal `\n` between PEM lines — common when
//     pasted via the CLI / API or copied from a `.env.local`. We
//     have to decode these or node-jsonwebtoken sees a one-line
//     PEM and rejects it.
//   * Multi-line with actual newlines — what Vercel's web UI
//     produces when you paste the raw .pem contents. These already
//     parse, so we leave them untouched (a blind replace would be a
//     no-op anyway, but the conditional makes the intent obvious
//     when reading logs).
function appConfig(): AppConfig {
  const appId = process.env.GITHUB_APP_ID;
  if (!appId) throw new Error("GITHUB_APP_ID env var is not set");
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY || "";
  const privateKey = rawKey.includes("\\n")
    ? rawKey.replace(/\\n/g, "\n")
    : rawKey;
  if (!privateKey) throw new Error("GITHUB_APP_PRIVATE_KEY env var is not set");

  // TEMP debug — single one-line classifier the Vercel logs can be
  // grepped for. Expected output: `[github-app] key format: valid`.
  // Anything else (most likely `INVALID`) means the env var contents
  // got mangled: the PEM body is intentionally NOT logged so this
  // line is safe to leave on until prod is happy.
  console.log(
    "[github-app] key format:",
    privateKey.startsWith("-----BEGIN") ? "valid" : "INVALID",
  );

  return { appId, privateKey };
}

/**
 * Sign a short-lived App JWT (10 minutes — GitHub's documented max).
 *
 * Hand-rolled with node:crypto rather than node-jsonwebtoken: the
 * primitive is RSA-SHA256, the encoding is base64url, both straight
 * out of the JWT spec.
 *
 * Two GitHub-specific gotchas baked in here:
 *
 *   1. `iss` MUST be a JSON number. GitHub rejects string `iss`
 *      values with "A JSON web token could not be decoded" — the
 *      exact 401 we kept getting before this fix. `Number(appId)`
 *      coerces; we throw if the env var isn't a positive integer
 *      because that's an unrecoverable config error.
 *
 *   2. `iat` is backdated 60s to cope with mild clock skew between
 *      Vercel's runtime and GitHub's API; an `iat` in the future
 *      fails 401 with the same opaque "could not be decoded" error.
 */
export function getAppJWT(): string {
  const { appId, privateKey } = appConfig();
  const issAsNumber = Number(appId);
  if (!Number.isInteger(issAsNumber) || issAsNumber <= 0) {
    throw new Error(
      `GITHUB_APP_ID must be a positive integer, got "${appId}"`,
    );
  }
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");

  const payloadObj = {
    iat: now - 60,
    exp: now + 600,
    iss: issAsNumber,
  };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString(
    "base64url",
  );

  const signingInput = `${header}.${payload}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  sign.end();

  const signature = sign.sign(privateKey, "base64url");
  const token = `${signingInput}.${signature}`;

  // Derive a public-key fingerprint so we can prove the env-var key
  // matches the App. GitHub's App settings page shows the same
  // SHA-256-of-DER-public-key fingerprint next to each private key
  // registered for the App. If THIS fingerprint isn't listed on
  // https://github.com/settings/apps/<your-app>/keys, the key in
  // GITHUB_APP_PRIVATE_KEY belongs to a different App (or was
  // deleted) — that's the most common cause of GitHub returning
  // "A JSON web token could not be decoded" with an otherwise
  // well-formed JWT.
  let pubKeyFingerprint = "unknown";
  try {
    const pubKey = crypto.createPublicKey(privateKey);
    const der = pubKey.export({ format: "der", type: "spki" });
    pubKeyFingerprint =
      "SHA256:" +
      crypto
        .createHash("sha256")
        .update(der as Buffer)
        .digest("base64")
        .replace(/=+$/, "");
  } catch (e) {
    pubKeyFingerprint = `derive-failed: ${(e as Error).message}`;
  }

  // TEMP diagnostic — every field below is intentionally non-secret
  // (iss is the public App ID, iat/exp are timestamps, sig_len is
  // the byte count of the signature segment, fingerprint is the
  // PUBLIC part of an asymmetric pair). Lets us tell at a glance:
  //   * whether iss is numeric (fixed in the previous commit)
  //   * whether iat is in the past
  //   * whether the sig length is right (~342 for 2048-bit RSA,
  //     ~683 for 4096-bit)
  //   * whether we produced exactly three dot-separated segments
  //   * whether the key in the env matches an App on GitHub
  console.log(
    "[github-app] jwt:",
    JSON.stringify({
      iss: payloadObj.iss,
      iss_type: typeof payloadObj.iss,
      iat: payloadObj.iat,
      exp: payloadObj.exp,
      now,
      sig_len: signature.length,
      segments: token.split(".").length,
      pub_key_fingerprint: pubKeyFingerprint,
    }),
  );

  return token;
}

/**
 * Sanity probe — calls GET /app, which is the simplest endpoint
 * authenticated only by the App JWT (no installation, no repo
 * scope). If this succeeds, the JWT + key + App ID combination is
 * correct and any subsequent failure is about the installation
 * being wrong (or revoked). If it fails with the same "could not
 * be decoded" message, the App ID and the private key disagree
 * on which App they belong to.
 *
 * We use it as a diagnostic step in /auth/github-app/callback so
 * the user gets a precise error rather than a confusing 401.
 */
export async function probeAppJWT(): Promise<
  | { ok: true; app: { id: number; slug: string; name: string } }
  | { ok: false; status: number; message: string }
> {
  const token = getAppJWT();
  try {
    const res = await fetch(`${GITHUB_API}/app`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      cache: "no-store",
    });
    if (res.ok) {
      const app = (await res.json()) as {
        id: number;
        slug: string;
        name: string;
      };
      return { ok: true, app };
    }
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) message = j.message;
    } catch {
      // non-json body
    }
    return { ok: false, status: res.status, message };
  } catch (e) {
    return { ok: false, status: 0, message: (e as Error).message };
  }
}

interface FetchOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}

/**
 * Authenticated fetch against the GitHub API using an App JWT.
 * Throws on non-2xx so callers can rely on a successful return.
 * Errors include the status + GitHub-supplied message so the
 * /auth/github-app/callback surface can render something useful.
 */
async function ghFetch<T>(
  path: string,
  token: string,
  opts: FetchOptions = {},
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    // GitHub recommends no caching for App auth flows; setting
    // `cache: 'no-store'` keeps Next from memoizing across requests.
    cache: "no-store",
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = (body as { message?: string }).message ?? "";
    } catch {
      // Non-JSON error body — fall through with empty detail.
    }
    throw new Error(
      `GitHub ${opts.method ?? "GET"} ${path} failed: ` +
        `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
    );
  }

  return (await res.json()) as T;
}

// --- Installation metadata -----------------------------------------------

export interface InstallationAccount {
  login: string;
  type: "User" | "Organization";
}

export interface Installation {
  id: number;
  account: InstallationAccount;
  // Other fields exist on the GitHub response; we narrow to what we
  // persist + display. Add fields here when you persist them.
}

export async function getInstallation(
  installationId: number | string,
): Promise<Installation> {
  return ghFetch<Installation>(
    `/app/installations/${installationId}`,
    getAppJWT(),
  );
}

export interface InstallationRepoListItem {
  full_name: string;
}

export interface InstallationRepoList {
  total_count: number;
  repositories: InstallationRepoListItem[];
}

/**
 * Lists repos the user picked during install. Paginated — GitHub
 * caps at 100 per page; we loop pages until a short page is
 * returned. Hard-capped at 10 pages (1000 repos) as a runaway guard.
 *
 * NB on auth: the canonical "list repos for this installation"
 * endpoint is `GET /installation/repositories`, and it requires an
 * **installation access token** — NOT the App JWT. (Earlier we hit
 * `/app/installations/{id}/repositories` with the App JWT; that
 * path does not exist on GitHub's API and returns 404.) So we mint
 * an installation token first, then page through `/installation/
 * repositories` with it.
 */
export async function listInstallationRepos(
  installationId: number | string,
): Promise<string[]> {
  const installationToken = (
    await createInstallationToken(installationId)
  ).token;

  const collected: string[] = [];
  let page = 1;
  const perPage = 100;
  for (let i = 0; i < 10; i++) {
    const data = await ghFetch<InstallationRepoList>(
      `/installation/repositories?per_page=${perPage}&page=${page}`,
      installationToken,
    );
    for (const r of data.repositories) {
      collected.push(r.full_name);
    }
    if (data.repositories.length < perPage) break;
    page += 1;
  }
  return collected;
}

// --- Installation access tokens ------------------------------------------

export interface InstallationAccessToken {
  token: string;
  // ISO-8601 — GitHub returns this exactly as we relay it to clients.
  expires_at: string;
}

/**
 * Mint a short-lived (≈1h) installation token. Used by:
 *   * the /api/github-app/installation-token POST endpoint (for the
 *     agent or any server-side consumer that needs to act on a repo)
 *   * potentially the agent itself, if it ever calls into the dashboard
 *     directly rather than holding a static PAT
 *
 * NB: the returned token is the credential the caller needs to keep
 * secret. Do NOT log it, do NOT return it from any browser-facing
 * route handler without first verifying the caller owns the
 * installation.
 */
export async function createInstallationToken(
  installationId: number | string,
): Promise<InstallationAccessToken> {
  return ghFetch<InstallationAccessToken>(
    `/app/installations/${installationId}/access_tokens`,
    getAppJWT(),
    { method: "POST" },
  );
}
