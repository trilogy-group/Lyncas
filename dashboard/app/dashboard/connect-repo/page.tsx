"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Repo connection page — migration 011.
//
// Two paths, with the GitHub App promoted as the recommended one:
//
//   1. GitHub App install (primary)
//      One button that links to
//      https://github.com/apps/<slug>/installations/new. GitHub asks
//      the user which repos to grant, then redirects them back to
//      /auth/github-app/callback?installation_id=… which provisions
//      the watched_repos rows server-side.
//
//   2. PAT (collapsed, "Advanced") — unchanged behavior from the
//      pre-011 flow. Kept because:
//        * Some users can't install Apps on repos they don't admin.
//        * The v1 cron-path agent still reads github_token directly.
//      Hidden behind a <details> so the App path is what users see
//      first; the PAT form only appears when explicitly expanded.
//
// Free-plan check (repo_limit) gates both paths — at-limit users see
// the upgrade banner regardless of which method they'd prefer.
//
// Wrapped in <Suspense> because useSearchParams() requires it under
// the App Router's static-bailout rules.

interface VerifyState {
  status: "idle" | "checking" | "ok" | "error";
  message: string | null;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const APP_SLUG = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? "";

function ConnectRepoInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createSupabaseBrowserClient();

  const [loading, setLoading] = useState(true);
  const [repoCount, setRepoCount] = useState(0);
  const [repoLimit, setRepoLimit] = useState(2);

  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [verify, setVerify] = useState<VerifyState>({
    status: "idle",
    message: null,
  });
  const [saving, setSaving] = useState(false);
  // The callback bounces back here with ?error=… on failure (and to
  // /dashboard/repos?connected=N on success, which this page never
  // sees). Surface the inbound error as a toast on first render by
  // seeding the initial state — doing this in an effect would trip
  // the project's react-hooks/set-state-in-effect lint rule.
  const [toast, setToast] = useState<
    { kind: "success" | "error"; message: string } | null
  >(() => {
    const incoming = searchParams.get("error");
    return incoming ? { kind: "error", message: incoming } : null;
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          if (!cancelled) router.replace("/login");
          return;
        }
        const [profileRes, watchedRes] = await Promise.all([
          supabase
            .from("user_profiles")
            .select("repo_limit")
            .eq("id", user.id)
            .maybeSingle(),
          supabase
            .from("watched_repos")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id),
        ]);
        if (cancelled) return;
        setRepoLimit((profileRes.data?.repo_limit as number) ?? 2);
        setRepoCount(watchedRes.count ?? 0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  function resetVerify() {
    setVerify((v) =>
      v.status === "idle" ? v : { status: "idle", message: null },
    );
  }

  async function handleVerify() {
    const trimmedRepo = repo.trim();
    const trimmedToken = token.trim();
    if (!REPO_PATTERN.test(trimmedRepo)) {
      setVerify({
        status: "error",
        message: "Use the owner/name format (e.g. HarshBti1805/Rasoi.io).",
      });
      return;
    }
    if (trimmedToken.length < 20) {
      setVerify({
        status: "error",
        message: "Token looks too short — paste your full GitHub PAT.",
      });
      return;
    }

    setVerify({ status: "checking", message: null });
    try {
      const res = await fetch(`https://api.github.com/repos/${trimmedRepo}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${trimmedToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.status === 200) {
        const body = (await res.json()) as {
          permissions?: { pull?: boolean; push?: boolean };
        };
        const canRead = body.permissions?.pull !== false;
        if (!canRead) {
          setVerify({
            status: "error",
            message: "Token authenticated but lacks read access on this repo.",
          });
          return;
        }
        setVerify({ status: "ok", message: "Access verified" });
      } else if (res.status === 401 || res.status === 403) {
        setVerify({
          status: "error",
          message: "Token doesn't have access to this repo.",
        });
      } else if (res.status === 404) {
        setVerify({
          status: "error",
          message:
            "Repo not found. Check the owner/name, or that the token can see private repos.",
        });
      } else {
        setVerify({
          status: "error",
          message: `GitHub returned HTTP ${res.status}.`,
        });
      }
    } catch (e) {
      setVerify({
        status: "error",
        message: (e as Error).message || "Network error.",
      });
    }
  }

  async function handleSave() {
    if (verify.status !== "ok") return;
    setSaving(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Session expired — please sign in again.");
      const { error } = await supabase.from("watched_repos").upsert(
        {
          user_id: user.id,
          repo: repo.trim(),
          github_token: token.trim(),
          token_type: "pat",
          github_installation_id: null,
          enabled: true,
        },
        { onConflict: "user_id,repo" },
      );
      if (error) throw error;
      setToast({ kind: "success", message: "Repository connected." });
      setTimeout(() => router.replace("/dashboard/repos"), 600);
    } catch (e) {
      setToast({
        kind: "error",
        message: `Could not save: ${(e as Error).message}`,
      });
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  if (loading) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-10">
        <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
      </main>
    );
  }

  const atLimit = repoCount >= repoLimit;
  const installUrl = APP_SLUG
    ? `https://github.com/apps/${APP_SLUG}/installations/new`
    : null;

  return (
    <main className="max-w-2xl mx-auto px-6 py-8 space-y-6">
      <div className="space-y-1">
        <Link
          href="/dashboard/repos"
          className="text-xs text-muted hover:text-text"
        >
          ← Your repositories
        </Link>
        <h1 className="text-xl font-semibold">Connect a repository</h1>
        <p className="text-sm text-muted">
          The agent will review every new pull request on the repos you
          connect.
        </p>
      </div>

      {atLimit ? (
        <Card
          className="p-6 space-y-3 border-2"
          style={{ borderColor: "#fbbf24" }}
        >
          <h2 className="text-base font-semibold">
            Upgrade to Pro to add more repositories
          </h2>
          <p className="text-sm text-muted">
            You&apos;ve connected {repoCount} of {repoLimit} repositories
            included in your free plan.
          </p>
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              disabled
              className="px-4 py-2 rounded-md text-sm font-medium text-white opacity-60 cursor-not-allowed"
              style={{ backgroundColor: "#4338ca" }}
              title="Billing not wired up yet"
            >
              Upgrade to Pro (coming soon)
            </button>
            <Link
              href="/dashboard/repos"
              className="text-sm text-muted hover:text-text"
            >
              Manage existing repos →
            </Link>
          </div>
        </Card>
      ) : (
        <>
          {/* Section 1 — GitHub App (recommended) */}
          <Card className="p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div
                className="mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
                style={{ backgroundColor: "#dcfce7", color: "#15803d" }}
              >
                Recommended
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">
                  Connect via GitHub App
                </h2>
                <p className="text-sm text-muted mt-1">
                  Grant access to specific repositories without sharing
                  personal tokens. GitHub will ask you which repos to
                  allow.
                </p>
              </div>
            </div>

            {installUrl ? (
              <a
                href={installUrl}
                className="inline-flex items-center justify-center gap-2 w-full sm:w-auto px-4 py-2.5 rounded-md text-sm font-medium text-white"
                style={{ backgroundColor: "#18181b" }}
              >
                <GitHubIcon />
                Install Night PR Reviewer on GitHub →
              </a>
            ) : (
              <div
                className="text-xs px-3 py-2 rounded-md border"
                style={{
                  borderColor: "#fecaca",
                  backgroundColor: "#fef2f2",
                  color: "#991b1b",
                }}
              >
                The GitHub App isn&apos;t fully configured on this deploy
                (missing <code>NEXT_PUBLIC_GITHUB_APP_SLUG</code>). Use the
                PAT path below or ask your administrator to finish setup.
              </div>
            )}

            <p className="text-xs text-muted">
              You&apos;ll be redirected to GitHub to select repositories,
              then brought back here automatically.
            </p>
          </Card>

          {/* Section 2 — PAT (collapsed) */}
          <Card className="p-0 overflow-hidden">
            <details className="group">
              <summary className="px-6 py-4 cursor-pointer flex items-center justify-between gap-3 select-none">
                <div>
                  <span className="text-sm font-medium">
                    Advanced: use a PAT instead
                  </span>
                  <p className="text-xs text-muted mt-0.5">
                    For personal use or testing only.
                  </p>
                </div>
                <span className="text-muted text-xs group-open:hidden">
                  Show
                </span>
                <span className="text-muted text-xs hidden group-open:inline">
                  Hide
                </span>
              </summary>

              <div className="px-6 pb-6 pt-2 border-t border-border space-y-5">
                <div>
                  <label
                    htmlFor="repo"
                    className="block text-sm font-medium text-text mb-1.5"
                  >
                    Repository
                  </label>
                  <input
                    id="repo"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={repo}
                    onChange={(e) => {
                      setRepo(e.target.value);
                      resetVerify();
                    }}
                    placeholder="e.g. HarshBti1805/HackHelix-LLMHallucination"
                    className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                  <p className="text-xs text-muted mt-1.5">
                    Format: <code className="font-mono">owner/name</code>
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="token"
                    className="block text-sm font-medium text-text mb-1.5"
                  >
                    GitHub Personal Access Token
                  </label>
                  <input
                    id="token"
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      resetVerify();
                    }}
                    placeholder="ghp_…"
                    className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                  <p className="text-xs text-muted mt-1.5">
                    Needs <code className="font-mono">contents:read</code> and{" "}
                    <code className="font-mono">pull_requests:write</code>{" "}
                    permissions.
                  </p>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={handleVerify}
                    disabled={verify.status === "checking" || !repo || !token}
                    className="px-4 py-2 rounded-md text-sm font-medium border border-border bg-card hover:bg-bg disabled:opacity-50"
                  >
                    {verify.status === "checking" ? "Checking…" : "Verify access"}
                  </button>

                  {verify.status === "ok" && (
                    <span className="text-sm" style={{ color: "#16a34a" }}>
                      ✓ {verify.message}
                    </span>
                  )}
                  {verify.status === "error" && (
                    <span className="text-sm" style={{ color: "#dc2626" }}>
                      ✕ {verify.message}
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <Link
                    href="/dashboard/repos"
                    className="text-sm text-muted hover:text-text"
                  >
                    Cancel
                  </Link>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={verify.status !== "ok" || saving}
                    className="px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50"
                    style={{ backgroundColor: "#4338ca" }}
                  >
                    {saving ? "Saving…" : "Save & connect"}
                  </button>
                </div>
              </div>
            </details>
          </Card>
        </>
      )}

      {toast && (
        <div
          className="fixed bottom-6 right-6 px-4 py-2 rounded-md shadow-lg text-sm font-medium max-w-md"
          style={{
            backgroundColor: toast.kind === "success" ? "#16a34a" : "#dc2626",
            color: "white",
          }}
          role="status"
        >
          {toast.message}
        </div>
      )}
    </main>
  );
}

function GitHubIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.65 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.17a11 11 0 0 1 5.78 0c2.21-1.48 3.18-1.17 3.18-1.17.62 1.59.23 2.77.11 3.06.73.8 1.18 1.82 1.18 3.07 0 4.39-2.69 5.36-5.25 5.64.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.55C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export default function ConnectRepoPage() {
  return (
    <Suspense
      fallback={
        <main className="max-w-2xl mx-auto px-6 py-10">
          <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
        </main>
      }
    >
      <ConnectRepoInner />
    </Suspense>
  );
}
