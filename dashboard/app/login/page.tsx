"use client";

import Link from "next/link";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { BrandMark } from "@/components/ui/brand";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Login page — black, monospace, motion-eased entrance, two paths:
//   1. Continue with GitHub  → Supabase Auth OAuth (returns to
//                              /auth/callback).
//   2. Continue with Email   → magic link (signInWithOtp).
// Post-auth the callback redirects to `next`, which defaults to
// /dashboard/chat (the v3 default landing).

function siteUrl(): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

const EASE = [0.16, 1, 0.3, 1] as const;

function LoginInner() {
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard/chat";
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
          scopes: "read:user",
        },
      });
      if (error) throw error;
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
    <main className="relative min-h-screen flex items-center justify-center bg-bg bg-noise text-text px-4 dot-grid">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: EASE }}
        className="w-full max-w-md space-y-8"
      >
        <div className="text-center space-y-5">
          <BrandMark href="/landing" />
          <div>
            <h1 className="font-mono font-bold uppercase tracking-tight text-3xl text-white">
              Sign in
            </h1>
            <p className="mt-2 text-sm text-muted-strong">
              Autonomous code review for your repositories
            </p>
          </div>
        </div>

        <Card className="p-6 space-y-5">
          {emailSent ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center space-y-3 py-4"
            >
              <p className="text-sm font-medium text-white">
                Check your email for a magic link.
              </p>
              <p className="text-xs text-muted-strong">
                We sent it to <span className="font-mono text-white">{email}</span>.
              </p>
              <button
                type="button"
                onClick={() => {
                  setEmailSent(false);
                  setEmail("");
                }}
                className="text-xs text-muted underline underline-offset-4 hover:text-white transition-colors"
              >
                Use a different email
              </button>
            </motion.div>
          ) : (
            <>
              <Button
                variant="primary"
                size="lg"
                onClick={handleGitHub}
                disabled={submitting !== null}
                className="w-full"
              >
                <GitHubIcon />
                {submitting === "github" ? "Redirecting…" : "Continue with GitHub"}
              </Button>

              <div className="flex items-center gap-3 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
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
                  className="w-full bg-bg border border-border rounded-sm px-3 py-3 text-sm font-mono text-white placeholder:text-muted focus:border-white focus:outline-none focus:ring-2 focus:ring-white/15 transition-colors"
                />
                <Button
                  type="submit"
                  size="lg"
                  variant="default"
                  disabled={submitting !== null}
                  className="w-full"
                >
                  {submitting === "email" ? "Sending magic link…" : "Continue with Email"}
                </Button>
              </form>

              {error && (
                <p
                  className="text-xs text-center text-[#ff5a5a] font-mono"
                  role="alert"
                >
                  {error}
                </p>
              )}
            </>
          )}
        </Card>

        <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-center text-muted leading-relaxed">
          <Link href="/landing" className="hover:text-white transition-colors">
            ← Back to landing
          </Link>
        </p>
      </motion.div>
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
