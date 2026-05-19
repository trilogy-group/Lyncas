"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, ExternalLinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Repo connection page — migration 011.
// (Logic identical to v2; chrome rebuilt for the v3 black-mode design.)
//
// Two paths, GitHub App promoted as primary:
//   1. GitHub App install (recommended). One button to
//      https://github.com/apps/<slug>/installations/new?state=<user_id>.
//   2. PAT (collapsed, advanced). Includes a "Fetch my repos" picker.

interface VerifyState {
  status: "idle" | "checking" | "ok" | "error";
  message: string | null;
}

interface MyRepoOption {
  full_name: string;
  private: boolean;
}

type FetchReposState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; repos: MyRepoOption[] }
  | { kind: "fallback"; message: string };

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const APP_SLUG = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? "";

function ConnectRepoInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createSupabaseBrowserClient();

  const [loading, setLoading] = useState(true);
  const [repoCount, setRepoCount] = useState(0);
  const [repoLimit, setRepoLimit] = useState(2);
  const [userId, setUserId] = useState<string | null>(null);

  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [verify, setVerify] = useState<VerifyState>({
    status: "idle",
    message: null,
  });
  const [saving, setSaving] = useState(false);
  const [fetchRepos, setFetchRepos] = useState<FetchReposState>({ kind: "idle" });
  const [repoSearch, setRepoSearch] = useState("");
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
        if (!cancelled) setUserId(user.id);
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

  async function handleFetchMyRepos() {
    setFetchRepos({ kind: "loading" });
    try {
      const { data } = await supabase.auth.getSession();
      const providerToken = data.session?.provider_token;
      if (!providerToken) {
        setFetchRepos({
          kind: "fallback",
          message:
            "We couldn't read your GitHub OAuth token (magic-link logins don't include one). Type the repo manually below.",
        });
        return;
      }
      const res = await fetch(
        "https://api.github.com/user/repos?per_page=100&sort=updated",
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${providerToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!res.ok) {
        setFetchRepos({
          kind: "fallback",
          message:
            res.status === 401
              ? "GitHub rejected your OAuth token (it may have expired — sign in again, or type the repo manually below)."
              : `GitHub returned HTTP ${res.status}. Type the repo manually below.`,
        });
        return;
      }
      const body = (await res.json()) as Array<{
        full_name: string;
        private: boolean;
      }>;
      setFetchRepos({
        kind: "ok",
        repos: body.map((r) => ({
          full_name: r.full_name,
          private: r.private,
        })),
      });
    } catch (e) {
      setFetchRepos({
        kind: "fallback",
        message:
          (e as Error).message ||
          "Could not reach GitHub. Type the repo manually below.",
      });
    }
  }

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
      <Container size="narrow" className="py-10">
        <Card className="p-10 text-center text-sm text-muted">Loading…</Card>
      </Container>
    );
  }

  const atLimit = repoCount >= repoLimit;
  const installUrl =
    APP_SLUG && userId
      ? `https://github.com/apps/${APP_SLUG}/installations/new?state=${encodeURIComponent(userId)}`
      : APP_SLUG
        ? `https://github.com/apps/${APP_SLUG}/installations/new`
        : null;

  const filteredRepos =
    fetchRepos.kind === "ok"
      ? fetchRepos.repos.filter((r) =>
          r.full_name.toLowerCase().includes(repoSearch.trim().toLowerCase()),
        )
      : [];

  return (
    <Container size="narrow" className="py-10 space-y-8">
      <div className="space-y-1">
        <Link
          href="/dashboard/repos"
          className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted hover:text-text"
        >
          ← Your repositories
        </Link>
        <SectionHeading
          title="Connect a repository"
          subtitle="The agent will review every new pull request on the repos you connect."
        />
      </div>

      {atLimit ? (
        <Card className="p-6 space-y-4 border-[#f5c63a]">
          <h2 className="text-base font-semibold">
            Upgrade to Pro to add more repositories
          </h2>
          <p className="text-sm text-muted">
            You&apos;ve connected {repoCount} of {repoLimit} repositories
            included in your free plan.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled title="Billing not wired up yet">
              Upgrade to Pro (coming soon)
            </Button>
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
          <Card className="p-6 space-y-5">
            <div className="flex items-start gap-3">
              <span className="rounded-sm bg-[#4ade80] px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.16em] text-black">
                Recommended
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">
                  Connect via GitHub App
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Grant access to specific repositories without sharing
                  personal tokens. GitHub will ask you which repos to allow.
                </p>
              </div>
            </div>

            {installUrl ? (
              <ExternalLinkButton
                href={installUrl}
                variant="primary"
                size="md"
                className="w-full sm:w-auto"
              >
                <GitHubIcon />
                Install Night PR Reviewer on GitHub →
              </ExternalLinkButton>
            ) : (
              <div className="rounded-sm border border-[#ff5252]/40 bg-[#ff5252]/10 px-3 py-2 text-xs text-[#ff5252]">
                The GitHub App isn&apos;t fully configured on this deploy
                (missing <code>NEXT_PUBLIC_GITHUB_APP_SLUG</code>). Use the PAT
                path below or ask your administrator to finish setup.
              </div>
            )}

            <p className="text-xs text-muted">
              You&apos;ll be redirected to GitHub to select repositories, then
              brought back here automatically.
            </p>
          </Card>

          {/* Section 2 — PAT (collapsed) */}
          <Card flush className="overflow-hidden">
            <details className="group">
              <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-6 py-4">
                <div>
                  <span className="text-sm font-medium">
                    Advanced: use a PAT instead
                  </span>
                  <p className="mt-0.5 text-xs text-muted">
                    For personal use or testing only.
                  </p>
                </div>
                <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted group-open:hidden">
                  Show
                </span>
                <span className="hidden text-[11px] font-mono uppercase tracking-[0.14em] text-muted group-open:inline">
                  Hide
                </span>
              </summary>

              <div className="space-y-6 border-t border-border px-6 pb-6 pt-5">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <label
                      htmlFor="repo"
                      className="block text-[10px] font-mono uppercase tracking-[0.18em] text-muted"
                    >
                      Repository
                    </label>
                    <Button
                      type="button"
                      onClick={() => void handleFetchMyRepos()}
                      disabled={fetchRepos.kind === "loading"}
                      size="sm"
                      variant="default"
                    >
                      {fetchRepos.kind === "loading"
                        ? "Fetching…"
                        : fetchRepos.kind === "ok"
                          ? "Refresh"
                          : "Fetch my repos"}
                    </Button>
                  </div>

                  {repo && (
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg px-2.5 py-1 font-mono text-xs"
                        title={repo}
                      >
                        <span className="max-w-[260px] truncate">{repo}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setRepo("");
                            resetVerify();
                          }}
                          className="text-muted hover:text-text"
                          aria-label="Clear selection"
                          title="Clear selection"
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  )}

                  {fetchRepos.kind === "ok" && (
                    <div className="overflow-hidden rounded-sm border border-border">
                      <input
                        type="text"
                        value={repoSearch}
                        onChange={(e) => setRepoSearch(e.target.value)}
                        placeholder={`Search ${fetchRepos.repos.length} repos…`}
                        className="w-full border-b border-border bg-bg px-3 py-2 text-xs font-mono focus:outline-none"
                      />
                      <div className="max-h-52 overflow-y-auto bg-bg">
                        {filteredRepos.length === 0 ? (
                          <div className="px-3 py-3 text-xs text-muted">
                            No matches.
                          </div>
                        ) : (
                          filteredRepos.map((r) => (
                            <button
                              key={r.full_name}
                              type="button"
                              onClick={() => {
                                setRepo(r.full_name);
                                resetVerify();
                              }}
                              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-bg-elev"
                            >
                              <span className="truncate">{r.full_name}</span>
                              {r.private && (
                                <span className="text-[10px] uppercase text-muted">
                                  private
                                </span>
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {fetchRepos.kind === "fallback" && (
                    <p className="rounded-sm border border-[#f5c63a]/40 bg-[#f5c63a]/10 px-3 py-2 text-xs text-[#f5c63a]">
                      {fetchRepos.message}
                    </p>
                  )}

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
                    className="w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm font-mono focus:border-white focus:outline-none"
                  />
                  <p className="text-xs text-muted">
                    Format: <code className="font-mono">owner/name</code>. Click{" "}
                    <em>Fetch my repos</em> to pick from a list instead.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="token"
                    className="mb-1.5 block text-[10px] font-mono uppercase tracking-[0.18em] text-muted"
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
                    className="w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm font-mono focus:border-white focus:outline-none"
                  />
                  <p className="mt-1.5 text-xs text-muted">
                    Needs <code className="font-mono">contents:read</code> and{" "}
                    <code className="font-mono">pull_requests:write</code>{" "}
                    permissions.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    onClick={handleVerify}
                    disabled={verify.status === "checking" || !repo || !token}
                    variant="default"
                  >
                    {verify.status === "checking" ? "Checking…" : "Verify access"}
                  </Button>

                  {verify.status === "ok" && (
                    <span className="text-sm text-[#4ade80]">
                      ✓ {verify.message}
                    </span>
                  )}
                  {verify.status === "error" && (
                    <span className="text-sm text-[#ff5252]">
                      ✕ {verify.message}
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-border pt-4">
                  <Link
                    href="/dashboard/repos"
                    className="text-sm text-muted hover:text-text"
                  >
                    Cancel
                  </Link>
                  <Button
                    type="button"
                    onClick={handleSave}
                    disabled={verify.status !== "ok" || saving}
                    variant="primary"
                  >
                    {saving ? "Saving…" : "Save & connect"}
                  </Button>
                </div>
              </div>
            </details>
          </Card>
        </>
      )}

      {toast && (
        <div
          className={
            "fixed bottom-6 right-6 max-w-md rounded-sm px-4 py-2 text-sm font-medium shadow-lg " +
            (toast.kind === "success"
              ? "bg-[#4ade80] text-black"
              : "bg-[#ff5252] text-black")
          }
          role="status"
        >
          {toast.message}
        </div>
      )}
    </Container>
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
        <Container size="narrow" className="py-10">
          <Card className="p-10 text-center text-sm text-muted">Loading…</Card>
        </Container>
      }
    >
      <ConnectRepoInner />
    </Suspense>
  );
}
