import { NextResponse, type NextRequest } from "next/server";
import {
  getInstallation,
  listInstallationRepos,
  probeAppJWT,
  type Installation,
} from "@/lib/github-app";
import { reconcileUserInstallations } from "@/lib/github-app-reconcile";
import { upsertInstallation } from "@/lib/queries";
import { getUser } from "@/lib/supabase/server";

// /auth/github-app/callback — landing page after a user installs (or
// re-configures) the Lyncas GitHub App.
//
// GitHub redirects here with these query params after install:
//   ?installation_id=<int>&setup_action=install
//   ?installation_id=<int>&setup_action=update     (repo selection changed)
//   ?installation_id=<int>&setup_action=request    (org admin must approve)
//
// What we do:
//   1. Require an authenticated user. Middleware already protects
//      /dashboard/*; this route lives at /auth/github-app/callback
//      (outside the dashboard prefix) so we re-check explicitly.
//   2. Fetch installation metadata + selected repos via the App JWT.
//   3. Upsert the github_app_installations row.
//   4. Provision a watched_repos row per selected repo, keyed on
//      (user_id, repo). Existing PAT rows are converted in place to
//      token_type='github_app'; this is the safest behavior —
//      operators rarely want to keep a stale PAT around once they've
//      installed the App on the same repo.
//   5. Redirect to /dashboard/chat so the new connections show up in
//      the room dropdown (the connect-repo page no longer exists).
//
// On any failure we bounce to /dashboard/chat?install_error=... so the
// chat page can surface the message inline (it owns the install modal
// now that the dedicated connect-repo page is gone).

export const dynamic = "force-dynamic";

function backToConnect(request: NextRequest, message: string) {
  const u = request.nextUrl.clone();
  u.pathname = "/dashboard/chat";
  u.search = `?install_error=${encodeURIComponent(message)}`;
  return NextResponse.redirect(u);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const installationIdRaw = searchParams.get("installation_id");
  const setupAction = searchParams.get("setup_action");

  if (!installationIdRaw) {
    return backToConnect(request, "GitHub did not return an installation_id");
  }
  const installationId = Number(installationIdRaw);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return backToConnect(request, "Invalid installation_id from GitHub");
  }

  // "request" means the install is pending org-admin approval — there's
  // no installation to reconcile yet, so route the user back with a
  // helpful note rather than 500'ing on the App API call below.
  if (setupAction === "request") {
    return backToConnect(
      request,
      "Installation pending org-admin approval. We'll pick it up automatically once approved.",
    );
  }

  const user = await getUser().catch(() => null);
  if (!user) {
    // Send them through /login with `next` pointing back here so the
    // installation isn't dropped on the floor when they sign in.
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = `?next=${encodeURIComponent(
      `/auth/github-app/callback?installation_id=${installationId}` +
        (setupAction ? `&setup_action=${setupAction}` : ""),
    )}`;
    return NextResponse.redirect(loginUrl);
  }

  let installation: Installation;
  let repos: string[];
  try {
    installation = await getInstallation(installationId);
    repos = await listInstallationRepos(installationId);
  } catch (e) {
    const baseMessage = (e as Error).message;

    // If GitHub rejected the JWT itself ("could not be decoded"),
    // run a follow-up probe against GET /app to separate "JWT is
    // wrong" from "install_id is wrong". The probe authenticates
    // with the same JWT but no install_id — if it ALSO 401s with
    // the same wording, the App ID and the private key disagree on
    // which App they belong to (the most common cause of this
    // error after a fresh App-creation cycle).
    if (
      baseMessage.includes("could not be decoded") ||
      baseMessage.includes("401")
    ) {
      const probe = await probeAppJWT();
      if (probe.ok) {
        console.error(
          `[github-app] JWT works against GET /app (app id=${probe.app.id}, slug=${probe.app.slug}) but installation ${installationId} 401s — installation_id probably belongs to a different App.`,
        );
        return backToConnect(
          request,
          `JWT is valid (App: ${probe.app.slug}) but installation ${installationId} doesn't belong to it. Re-install on the correct App, or update GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY to match the App you installed.`,
        );
      } else {
        console.error(
          `[github-app] GET /app probe also failed (status=${probe.status}, message=${probe.message}) — GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY do NOT belong to the same App. Compare the pub_key_fingerprint logged above to the SHA256 shown next to your private key at https://github.com/settings/apps/<slug>/keys.`,
        );
        return backToConnect(
          request,
          `GitHub can't validate the App JWT — the App ID (${process.env.GITHUB_APP_ID}) and private key in Vercel env vars don't belong to the same GitHub App. Check https://github.com/settings/apps and the function logs for the public-key fingerprint.`,
        );
      }
    }

    return backToConnect(request, baseMessage);
  }

  // Persist the install row first. If this fails we abort — we don't
  // want orphaned watched_repos rows pointing at an installation we
  // never recorded.
  try {
    await upsertInstallation({
      user_id: user.id,
      installation_id: installation.id,
      account_login: installation.account.login,
      account_type: installation.account.type,
      repos_selected: repos,
    });
  } catch (e) {
    return backToConnect(
      request,
      `Could not save installation: ${(e as Error).message}`,
    );
  }

  // Provision watched_repos via full reconciliation. The helper:
  //   * upserts one row per (live install, selected repo),
  //   * probes any other installations recorded for this user and
  //     deletes the stale ones, and
  //   * deletes watched_repos rows that no live install reports.
  //
  // This is what fixes "I reinstalled with 4 repos but the dashboard
  // still shows 51" — the old rows pointed at a now-stale install_id,
  // reconciliation drops them. Idempotent: a no-op when the DB
  // already matches GitHub.
  const summary = await reconcileUserInstallations(user.id);
  if (summary.warnings.length > 0) {
    // Don't fail the redirect — surface non-fatal issues in logs.
    console.warn(
      "[github-app/callback] reconcile warnings:",
      summary.warnings.join("; "),
    );
  }

  const u = request.nextUrl.clone();
  u.pathname = "/dashboard/chat";
  // The browser receives the count GitHub *currently* reports — not
  // the count from the URL — so a re-selection from 51 → 4 actually
  // shows as 4.
  const finalCount = repos.length;
  u.search = `?connected=${finalCount}`;
  return NextResponse.redirect(u);
}
