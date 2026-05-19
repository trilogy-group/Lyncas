"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// DevPodSettingsPanel — rendered in /dashboard/settings.
//
// Single responsibility: show the user their connect token. The
// chat sidebar already has its own offline / live UI; here we just
// surface the long-lived secret so the user can paste it back into
// their CLI (or rotate workspaces) without leaving settings.
//
// Token visibility:
//   * Hidden by default (input type=password).
//   * Reveal toggle (eye icon).
//   * Copy button.
//   * Regenerate button — disabled, "Coming soon" tooltip. Per-user
//     secret rotation is a v2 feature (see lib/devpod.ts comments).

export function DevPodSettingsPanel() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/devpod/token", { cache: "no-store" });
        const body = (await res.json()) as { token?: string; error?: string };
        if (cancelled) return;
        if (!res.ok || !body.token) {
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        setToken(body.token);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <Card className="p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold">DevPod Connect</h2>
        <p className="mt-1 text-xs text-muted">
          Paste this token into your DevPod terminal so the dashboard can run
          tests and commands inside your workspace.
        </p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="devpod-token"
          className="block text-[10px] font-mono uppercase tracking-[0.18em] text-muted"
        >
          Your DevPod connect token
        </label>

        {error ? (
          <div className="rounded-sm border border-[#ff5252]/40 bg-[#ff5252]/10 px-3 py-2 text-xs text-[#ff5252]">
            {error}
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="devpod-token"
              type={reveal ? "text" : "password"}
              value={loading ? "Loading…" : token ?? ""}
              readOnly
              className="flex-1 rounded-sm border border-border bg-bg px-3 py-2 text-sm font-mono focus:border-white focus:outline-none"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="default"
                onClick={() => setReveal((v) => !v)}
                disabled={loading || !token}
                title={reveal ? "Hide token" : "Reveal token"}
              >
                {reveal ? "Hide" : "Reveal"}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => void copy()}
                disabled={loading || !token}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        <p className="text-[11px] text-muted">
          Keep this secret. Anyone with this token can register a DevPod
          session on your account.
        </p>
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled
          title="Coming soon"
        >
          Regenerate
        </Button>
        <span className="text-[11px] text-muted">
          Token rotation is on the v2 hardening list.
        </span>
      </div>
    </Card>
  );
}
