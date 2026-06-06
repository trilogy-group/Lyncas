"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { DevPodSettingsPanel } from "@/components/devpod-settings-panel";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// /dashboard/settings — per-user account preferences. Currently scoped
// to one section ("Notification settings") that wires digest emails to
// an OTP-verified address.

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
      <Container size="narrow" className="py-10">
        <Card className="p-10 text-center text-sm text-muted">Loading…</Card>
      </Container>
    );
  }

  const currentVerified =
    profile.digest_email_verified && profile.digest_email === email;

  return (
    <Container size="narrow" className="py-10 space-y-8">
      <SectionHeading
        eyebrow="Settings"
        title="Account & notifications"
        subtitle="Manage where Lyncas sends your daily digest."
      />

      <Card className="p-6 space-y-6">
        <div>
          <h2 className="text-base font-semibold">Notification settings</h2>
          <p className="mt-1 text-xs text-muted">
            One digest per day summarising PRs reviewed and auto-closed across
            your connected repositories.
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="digest-email"
            className="block text-[10px] font-mono uppercase tracking-[0.18em] text-muted"
          >
            Digest email address
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
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
              className="flex-1 rounded-sm border border-border bg-bg px-3 py-2 text-sm font-mono focus:border-white focus:outline-none"
            />
            <Button
              type="button"
              onClick={() => void sendCode()}
              disabled={sending || !email || currentVerified}
              variant="primary"
            >
              {sending
                ? "Sending…"
                : currentVerified
                  ? "Verified"
                  : stage === "sent"
                    ? "Resend code"
                    : "Send verification code"}
            </Button>
          </div>
          {currentVerified && (
            <div className="text-xs text-[#4ade80]">
              ✓ Email verified — digests will go to{" "}
              <span className="font-mono">{email}</span>
            </div>
          )}
        </div>

        {stage === "sent" && !currentVerified && (
          <div className="space-y-2 border-t border-border pt-5">
            <label
              htmlFor="otp"
              className="block text-[10px] font-mono uppercase tracking-[0.18em] text-muted"
            >
              Enter the 6-digit code we sent to{" "}
              <span className="font-mono normal-case tracking-normal">
                {email}
              </span>
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
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
                className="w-full rounded-sm border border-border bg-bg px-3 py-2 text-center text-base font-mono tracking-[0.4em] focus:border-white focus:outline-none sm:w-40"
              />
              <Button
                type="button"
                onClick={() => void confirmCode()}
                disabled={verifying || otp.length !== 6}
                variant="default"
              >
                {verifying ? "Verifying…" : "Verify"}
              </Button>
            </div>
            <div className="text-[11px] text-muted">
              Code expires in 10 minutes. Didn&apos;t arrive? Check spam or
              click &quot;Resend code&quot; above.
            </div>
            {devOtp && (
              <div className="mt-2 rounded-sm border border-[#f5c63a]/40 bg-[#f5c63a]/10 p-2 text-[11px] font-mono text-[#f5c63a]">
                Dev mode (no SMTP configured): your code is{" "}
                <span className="font-bold">{devOtp}</span>. Configure{" "}
                <code>GMAIL_USER</code> + <code>GMAIL_APP_PASSWORD</code> in the
                environment to email it instead.
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-sm border border-[#ff5252]/40 bg-[#ff5252]/10 px-3 py-2 text-xs text-[#ff5252]">
            {error}
          </div>
        )}
      </Card>

      <DevPodSettingsPanel />

      <Card className="p-6 space-y-3">
        <h2 className="text-base font-semibold">Other settings</h2>
        <p className="text-xs text-muted">
          Per-repository configuration (path filters, custom prompts,
          auto-close behaviour) lives on each repo&apos;s settings page.
        </p>
        <Link
          href="/dashboard/repos"
          className="inline-block text-sm font-medium text-text underline underline-offset-4 hover:opacity-80"
        >
          Manage repository settings →
        </Link>
      </Card>
    </Container>
  );
}
