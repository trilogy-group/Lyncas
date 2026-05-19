"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// /dashboard/settings — per-user account preferences. Currently scoped
// to one section ("Notification settings") that wires digest emails to
// an OTP-verified address.
//
// Why a separate /dashboard/settings (vs the legacy /settings):
//   * /settings is the v1 public read-only "agent config" page.
//   * /dashboard/settings is auth-gated and owner-scoped — RLS on
//     user_profiles + email_verifications keeps the writes safe.

interface ProfileState {
  digest_email: string | null;
  digest_email_verified: boolean;
}

export default function DashboardSettingsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ProfileState>({
    digest_email: null,
    digest_email_verified: false,
  });
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState<"idle" | "sent" | "verified">("idle");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devOtp, setDevOtp] = useState<string | null>(null);

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
        const { data } = await supabase
          .from("user_profiles")
          .select("digest_email, digest_email_verified")
          .eq("id", user.id)
          .maybeSingle<ProfileState>();
        if (cancelled) return;
        const initial = data ?? {
          digest_email: null,
          digest_email_verified: false,
        };
        setProfile(initial);
        setEmail(initial.digest_email ?? user.email ?? "");
        if (initial.digest_email_verified) setStage("verified");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  async function sendCode() {
    setError(null);
    setDevOtp(null);
    setSending(true);
    try {
      const res = await fetch("/api/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        sent?: boolean;
        dev_otp?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setStage("sent");
      if (data.dev_otp) {
        setDevOtp(data.dev_otp);
      }
      // Optimistically reflect the new (unverified) address.
      setProfile({
        digest_email: email,
        digest_email_verified: false,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function confirmCode() {
    setError(null);
    setVerifying(true);
    try {
      const res = await fetch("/api/verify-email/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setStage("verified");
      setProfile({ digest_email: email, digest_email_verified: true });
      setOtp("");
      setDevOtp(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  if (loading) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-10">
        <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
      </main>
    );
  }

  const currentVerified =
    profile.digest_email_verified && profile.digest_email === email;

  return (
    <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <section>
        <h1 className="text-xl font-semibold mb-1">Settings</h1>
        <p className="text-sm text-muted">
          Manage where Night PR Reviewer sends your daily digest.
        </p>
      </section>

      <Card className="p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold">Notification settings</h2>
          <p className="text-xs text-muted mt-1">
            We send one digest per day summarising PRs reviewed and
            auto-closed across your connected repositories.
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="digest-email"
            className="block text-xs font-medium text-muted"
          >
            Digest email address
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="digest-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (stage !== "idle") setStage("idle");
                setDevOtp(null);
                setError(null);
              }}
              placeholder="you@example.com"
              className="flex-1 bg-bg border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void sendCode()}
              disabled={sending || !email || currentVerified}
              className="px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50 whitespace-nowrap"
              style={{ backgroundColor: "#4338ca" }}
            >
              {sending
                ? "Sending…"
                : currentVerified
                  ? "Verified"
                  : stage === "sent"
                    ? "Resend code"
                    : "Send verification code"}
            </button>
          </div>
          {currentVerified && (
            <div className="text-xs text-green-700">
              ✓ Email verified — digests will go to{" "}
              <span className="font-mono">{email}</span>
            </div>
          )}
        </div>

        {stage === "sent" && !currentVerified && (
          <div className="space-y-2 border-t border-border pt-5">
            <label
              htmlFor="otp"
              className="block text-xs font-medium text-muted"
            >
              Enter the 6-digit code we sent to{" "}
              <span className="font-mono">{email}</span>
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="otp"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="000000"
                className="w-full sm:w-40 bg-bg border border-border rounded-md px-3 py-2 text-base font-mono tracking-[0.4em] text-center focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
              />
              <button
                type="button"
                onClick={() => void confirmCode()}
                disabled={verifying || otp.length !== 6}
                className="px-4 py-2 rounded-md text-sm font-medium border border-border bg-card hover:bg-bg disabled:opacity-50 whitespace-nowrap"
              >
                {verifying ? "Verifying…" : "Verify"}
              </button>
            </div>
            <div className="text-[11px] text-muted">
              Code expires in 10 minutes. Didn&apos;t arrive? Check spam
              or click &quot;Resend code&quot; above.
            </div>
            {devOtp && (
              <div className="mt-2 p-2 text-[11px] font-mono rounded-md border border-amber-300 bg-amber-50 text-amber-800">
                Dev mode (no SMTP configured): your code is{" "}
                <span className="font-bold">{devOtp}</span>. Configure{" "}
                <code>GMAIL_USER</code> + <code>GMAIL_APP_PASSWORD</code>{" "}
                in the environment to email it instead.
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="text-xs px-3 py-2 rounded-md border border-red-300 bg-red-50 text-red-700">
            {error}
          </div>
        )}
      </Card>

      <Card className="p-6 space-y-2">
        <h2 className="text-base font-semibold">Other settings</h2>
        <p className="text-xs text-muted">
          Per-repository configuration (path filters, custom prompts,
          auto-close behaviour) lives on each repo&apos;s settings page.
        </p>
        <Link
          href="/dashboard/repos"
          className="inline-block mt-2 text-sm font-medium text-accent hover:underline"
        >
          Manage repository settings →
        </Link>
      </Card>
    </main>
  );
}
