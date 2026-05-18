"use client";

import Link from "next/link";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Login page. Two paths:
//   1. Continue with GitHub  → Supabase Auth OAuth, redirects to
//                              <site>/auth/callback?code=...
//   2. Continue with Email   → magic link (signInWithOtp) — clicking
//                              the email also lands on /auth/callback.
//
// The callback route exchanges the code for a session and creates the
// user_profiles row on first login. The `next` query param flows
// through so we can return the user to wherever they came from after
// the middleware bounced them.

// Computes the redirect-to URL for both OAuth and magic-link flows.
// Prefers NEXT_PUBLIC_SITE_URL (set on Vercel) so production deploys
// don't accidentally redirect to localhost. Falls back to
// window.location.origin for local dev where the env var is unset.
function siteUrl(): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

function LoginInner() {
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";
  const errorParam = params.get("error");

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState<"github" | "email" | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState<string | null>(errorParam);

  async function handleGitHub() {
    setError(null);
    setSubmitting("github");
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "github",
        options: {
          redirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
          // Ask GitHub for the scopes we'll need when we wire per-user
          // GitHub App / OAuth installations. For v2 launch the
          // dashboard still asks operators for a separate PAT on the
          // connect-repo page; `read:user` keeps the consent screen
          // minimal in the meantime.
          scopes: "read:user",
        },
      });
      if (error) throw error;
      // The redirect navigates away from this page; if it didn't
      // (popup blocked, etc.) we'll fall through and show a generic
      // error.
    } catch (e) {
      setError((e as Error).message || "GitHub sign-in failed");
      setSubmitting(null);
    }
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError("Enter your email address");
      return;
    }
    setSubmitting("email");
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw error;
      setEmailSent(true);
    } catch (err) {
      setError((err as Error).message || "Could not send magic link");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-bg text-text px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <Link
            href="/landing"
            className="inline-block text-xs text-muted hover:text-text"
          >
            ← back
          </Link>
          <h1 className="text-2xl font-semibold">Night PR Reviewer</h1>
          <p className="text-sm text-muted">
            Autonomous code review for your repositories
          </p>
        </div>

        <Card className="p-6 space-y-4">
          {emailSent ? (
            <div className="text-center space-y-3">
              <p className="text-sm font-medium">
                Check your email for a magic link.
              </p>
              <p className="text-xs text-muted">
                We sent it to <span className="font-mono">{email}</span>.
              </p>
              <button
                type="button"
                onClick={() => {
                  setEmailSent(false);
                  setEmail("");
                }}
                className="text-xs text-muted underline hover:text-text"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={handleGitHub}
                disabled={submitting !== null}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md font-medium text-sm text-white disabled:opacity-50"
                style={{ backgroundColor: "#18181b" }}
              >
                <GitHubIcon />
                {submitting === "github"
                  ? "Redirecting…"
                  : "Continue with GitHub"}
              </button>

              <div className="flex items-center gap-3 text-xs text-muted">
                <div className="flex-1 h-px bg-border" />
                or
                <div className="flex-1 h-px bg-border" />
              </div>

              <form onSubmit={handleEmail} className="space-y-3">
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
                <button
                  type="submit"
                  disabled={submitting !== null}
                  className="w-full px-4 py-2.5 rounded-md font-medium text-sm border border-border bg-card hover:bg-bg disabled:opacity-50 transition-colors"
                >
                  {submitting === "email"
                    ? "Sending magic link…"
                    : "Continue with Email"}
                </button>
              </form>

              {error && (
                <p
                  className="text-xs text-center"
                  style={{ color: "#dc2626" }}
                  role="alert"
                >
                  {error}
                </p>
              )}
            </>
          )}
        </Card>

        <p className="text-xs text-muted text-center leading-relaxed">
          By signing in you agree to let the agent review your pull requests.
        </p>
      </div>
    </main>
  );
}

function GitHubIcon() {
  // Inline SVG — keeps us off any icon library and away from a new dep.
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

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center bg-bg">
          <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
        </main>
      }
    >
      <LoginInner />
    </Suspense>
  );
}
