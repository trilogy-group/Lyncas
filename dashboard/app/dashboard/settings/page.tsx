"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  SettingsPanel,
  SettingsPill,
  SettingsRow,
  SettingsRows,
  Toggle,
} from "@/components/ui/settings-panel";
import { DevPodSettingsPanel } from "@/components/devpod-settings-panel";
import { GridBackdrop } from "@/components/ui/grid-backdrop";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// /dashboard/settings — per-user account preferences.
//
// Sections:
//   * Notifications — digest email (OTP-verified, persisted to
//     user_profiles) plus the digest / alert toggles.
//   * Sandbox / dev environment — DevPod connect token + presentational
//     compute controls.
//   * Other — pointer to per-repo configuration.
//
// Persistence note: the digest email + its verified flag are the only
// fields backed by the database today (user_profiles). The digest /
// alert / keep-warm toggles and the compute tier are UI-only for now —
// there are no columns for them yet, so they reset on reload. Wiring
// them up is a schema change (a new migration), deliberately deferred.

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

  // Presentational-only preference state (see persistence note above).
  const [dailyDigest, setDailyDigest] = useState(false);
  const [alertOnClose, setAlertOnClose] = useState(false);
  const [keepWarm, setKeepWarm] = useState(true);
  const [computeTier, setComputeTier] = useState("2 vCPU · 4 GB");

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
      <Container className="py-10">
        <Card className="p-10 text-center text-sm text-muted">Loading…</Card>
      </Container>
    );
  }

  const currentVerified =
    profile.digest_email_verified && profile.digest_email === email;

  return (
    <div className="relative">
      <GridBackdrop tone="warm" />
      <Container className="relative py-10 space-y-8">
        <SectionHeading
          eyebrow="Settings"
          title="ACCOUNT"
          subtitle="Notification, environment, and account preferences."
        />

        {/* ---- Notifications ------------------------------------------- */}
        <SettingsPanel title="Notifications" meta="Digest + alerts">
          <div className="space-y-2">
            <label
              htmlFor="digest-email"
              className="block font-mono text-[10px] uppercase tracking-[0.18em] text-muted"
            >
              Digest email
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
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
                className="h-12 flex-1 rounded-md border border-border bg-bg-elev px-4 font-mono text-sm text-white focus:border-border-strong focus:outline-none"
              />
              {currentVerified ? (
                <span className="inline-flex h-12 items-center justify-center rounded-md border border-[#58e684]/45 px-5 font-mono text-xs uppercase tracking-[0.16em] text-[#58e684]">
                  ✓ Verified
                </span>
              ) : (
                <Button
                  type="button"
                  onClick={() => void sendCode()}
                  disabled={sending || !email}
                  variant="primary"
                  size="lg"
                >
                  {sending
                    ? "Sending…"
                    : stage === "sent"
                      ? "Resend code"
                      : "Send code"}
                </Button>
              )}
            </div>
          </div>

          {stage === "sent" && !currentVerified && (
            <div className="mt-4 space-y-2 rounded-md border border-border bg-bg-elev p-4">
              <label
                htmlFor="otp"
                className="block font-mono text-[10px] uppercase tracking-[0.18em] text-muted"
              >
                Enter the 6-digit code sent to{" "}
                <span className="font-mono normal-case tracking-normal text-muted-strong">
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
                  className="h-11 w-full rounded-md border border-border bg-bg px-3 text-center font-mono text-base tracking-[0.4em] focus:border-border-strong focus:outline-none sm:w-44"
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
                <div className="mt-2 rounded-md border border-[#f5c63a]/40 bg-[#f5c63a]/10 p-2 font-mono text-[11px] text-[#f5c63a]">
                  Dev mode (no SMTP configured): your code is{" "}
                  <span className="font-bold">{devOtp}</span>. Configure{" "}
                  <code>GMAIL_USER</code> + <code>GMAIL_APP_PASSWORD</code> in the
                  environment to email it instead.
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-md border border-[#ff5252]/40 bg-[#ff5252]/10 px-3 py-2 text-xs text-[#ff5252]">
              {error}
            </div>
          )}

          <div className="mt-5 border-t border-border">
            <SettingsRows>
              <SettingsRow
                title="Daily digest email"
                description="A summary of the day's reviews, sent at 9am."
                control={
                  <Toggle
                    label="Daily digest email"
                    checked={dailyDigest}
                    onChange={setDailyDigest}
                  />
                }
              />
              <SettingsRow
                title="Alert on auto-close"
                description="Email me immediately when the agent auto-closes a PR."
                control={
                  <Toggle
                    label="Alert on auto-close"
                    checked={alertOnClose}
                    onChange={setAlertOnClose}
                  />
                }
              />
            </SettingsRows>
          </div>
        </SettingsPanel>

        {/* ---- Sandbox / dev environment ------------------------------- */}
        <SettingsPanel
          title="Sandbox / Dev environment"
          meta={<SettingsPill dot>Connected</SettingsPill>}
        >
          <p className="text-sm text-muted">
            The sandbox runs tests against PRs before the agent forms a verdict.
          </p>

          <div className="mt-3 border-t border-border">
            <SettingsRows>
              <SettingsRow
                title="Connection"
                description="Lyncas-managed sandbox · us-east-1"
                control={<SettingsPill dot>Online</SettingsPill>}
              />
              <SettingsRow
                title="Compute tier"
                description="vCPU + memory allocated per review run"
                control={
                  <div className="relative">
                    <select
                      aria-label="Compute tier"
                      value={computeTier}
                      onChange={(e) => setComputeTier(e.target.value)}
                      className="h-11 appearance-none rounded-md border border-border bg-bg-elev pl-4 pr-9 font-mono text-sm text-white focus:border-border-strong focus:outline-none"
                    >
                      <option>1 vCPU · 2 GB</option>
                      <option>2 vCPU · 4 GB</option>
                      <option>4 vCPU · 8 GB</option>
                    </select>
                    <span
                      aria-hidden
                      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
                    >
                      ⌄
                    </span>
                  </div>
                }
              />
              <SettingsRow
                title="Keep warm"
                description="Avoid cold-start latency on the first review of the day."
                control={
                  <Toggle
                    label="Keep warm"
                    checked={keepWarm}
                    onChange={setKeepWarm}
                  />
                }
              />
            </SettingsRows>
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <DevPodSettingsPanel />
          </div>
        </SettingsPanel>

        {/* ---- Other --------------------------------------------------- */}
        <SettingsPanel title="Other" meta="Per-repo">
          <SettingsRow
            className="py-0"
            title={
              <span className="text-sm font-normal text-muted-strong">
                Review behavior, auto-close, and rules are configured per
                repository.
              </span>
            }
            control={
              <Link
                href="/dashboard/repos"
                className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em] text-white underline-offset-4 hover:underline"
              >
                Go to repositories →
              </Link>
            }
          />
        </SettingsPanel>
      </Container>
    </div>
  );
}
