"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Repo connection flow. Three states:
//   loading       — fetching the user's profile + current repo count
//   limit-reached — show the upgrade banner instead of the form
//   form          — owner/name + GitHub PAT, with a Verify step
//
// Verify hits GET https://api.github.com/repos/{owner}/{name} with
// the supplied token. A 200 + `permissions.push|admin|maintain` means
// the token can read the repo; anything else means we shouldn't
// accept it. The PAT lives in `watched_repos.github_token` after
// Save; it never leaves the client unencrypted-over-the-wire because
// Supabase enforces HTTPS.
//
// Why we don't store the OAuth token from Supabase Auth here: that
// token has `read:user` scope only (see login/page.tsx), which isn't
// enough to read private repo contents. The PAT a user pastes in is
// the actual review credential.

interface VerifyState {
  status: "idle" | "checking" | "ok" | "error";
  message: string | null;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export default function ConnectRepoPage() {
  const router = useRouter();
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
  const [toast, setToast] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          // Middleware should have caught this, but render safely
          // if a stale tab finds itself here.
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

  // Reset verification whenever either input changes — handled in
  // the onChange handlers below rather than a useEffect because
  // React-strict-mode flags effect-based state resets as a smell.
  function resetVerify() {
    setVerify((v) => (v.status === "idle" ? v : { status: "idle", message: null }));
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
        const canRead = body.permissions?.pull !== false; // undefined OK for public repos
        if (!canRead) {
          setVerify({
            status: "error",
            message:
              "Token authenticated but lacks read access on this repo.",
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
      const { error } = await supabase.from("watched_repos").insert({
        user_id: user.id,
        repo: repo.trim(),
        github_token: token.trim(),
        enabled: true,
      });
      if (error) throw error;
      setToast({ kind: "success", message: "Repository connected." });
      // Give the user a beat to see the toast, then bounce to the
      // repos list. router.replace so the back button doesn't bring
      // them back to a now-stale form.
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
    const t = setTimeout(() => setToast(null), 3000);
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
          The agent will review every new pull request on this repo.
        </p>
      </div>

      {atLimit ? (
        <Card className="p-6 space-y-3 border-2" style={{ borderColor: "#fbbf24" }}>
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
        <Card className="p-6 space-y-5">
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
        </Card>
      )}

      {toast && (
        <div
          className="fixed bottom-6 right-6 px-4 py-2 rounded-md shadow-lg text-sm font-medium"
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
