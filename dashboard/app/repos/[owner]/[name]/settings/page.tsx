"use client";

// Per-repo configuration page. The only 'use client' page in the
// dashboard — file upload, local form state, and direct Supabase
// upserts via the browser anon key (RLS policy in 009_repo_rules.sql
// allows anon write).
//
// Route is /repos/<owner>/<name>/settings. Two dynamic segments rather
// than a catch-all because Next requires catch-alls to be the last
// path segment, and we want /settings to sit underneath. GitHub repos
// are always two-part (owner/name), so two segments is exactly right.

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { RepoRule } from "@/lib/types";

interface PageProps {
  params: Promise<{ owner: string; name: string }>;
}

interface FormState {
  enabled: boolean;
  auto_close_all: boolean;
  auto_close_severity_threshold: string;
  watch_paths: string;
  skip_paths: string;
  custom_instructions: string;
  rules_file_content: string;
  rules_file_name: string | null;
}

const DEFAULT_FORM: FormState = {
  enabled: true,
  auto_close_all: false,
  auto_close_severity_threshold: "",
  watch_paths: "",
  skip_paths: "",
  custom_instructions: "",
  rules_file_content: "",
  rules_file_name: null,
};

// One typographic family for the whole page (default sans). The label
// styles below intentionally avoid the all-caps font-mono used on
// table headers — that style fights the form inputs. Hints are a
// small muted line in the same family.
const LABEL = "block text-sm font-medium text-text mb-1.5";
const SUBLABEL = "text-xs text-muted leading-relaxed";
const INPUT =
  "w-full bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors";
const TEXTAREA = `${INPUT} font-mono text-xs leading-relaxed`;

function arrayToLines(arr: string[] | null | undefined): string {
  return (arr ?? []).join("\n");
}

function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Section wrapper — single source of truth for spacing + card chrome.
// Title is a clear sans-serif heading; the optional `description` slot
// holds at most one short line. Anything longer goes inline next to
// the field it describes.
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text">{title}</h2>
        {description && (
          <p className="text-xs text-muted mt-1">{description}</p>
        )}
      </div>
      {children}
    </Card>
  );
}

// Inline toggle row used for the two boolean settings. Reads
// left-to-right like a sentence; checkbox stays on the left so the
// click target is wide and obvious.
function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  tone = "default",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint: string;
  tone?: "default" | "danger";
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-accent cursor-pointer"
      />
      <div className="flex-1 min-w-0">
        <div
          className="text-sm font-medium text-text"
          style={
            tone === "danger" && checked ? { color: "#dc2626" } : undefined
          }
        >
          {label}
        </div>
        <div className={`${SUBLABEL} mt-0.5`}>{hint}</div>
      </div>
    </label>
  );
}

export default function RepoSettingsPage({ params }: PageProps) {
  const { owner, name } = use(params);
  const repo = `${owner}/${name}`;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [directoryTree, setDirectoryTree] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data, error } = await supabase
          .from("repo_rules")
          .select("*")
          .eq("repo", repo)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          // Tolerate the table not existing yet (PGRST205) — render
          // an empty form so an operator setting up Phase 9 for the
          // first time can still save once the migration has run.
          setForm(DEFAULT_FORM);
          setDirectoryTree(null);
        } else if (data) {
          const r = data as RepoRule;
          setForm({
            enabled: r.enabled,
            auto_close_all: r.auto_close_all,
            auto_close_severity_threshold:
              r.auto_close_severity_threshold !== null
                ? String(r.auto_close_severity_threshold)
                : "",
            watch_paths: arrayToLines(r.watch_paths),
            skip_paths: arrayToLines(r.skip_paths),
            custom_instructions: r.custom_instructions ?? "",
            rules_file_content: r.rules_file_content ?? "",
            rules_file_name: r.rules_file_content ? "saved file" : null,
          });
          setDirectoryTree(r.repo_directory_tree ?? null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [repo]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleFileUpload(
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 200_000) {
      setToast({
        kind: "error",
        message: `${file.name} is too large (${file.size} bytes; max 200KB).`,
      });
      return;
    }
    try {
      const text = await file.text();
      setForm((f) => ({
        ...f,
        rules_file_content: text,
        rules_file_name: file.name,
      }));
    } catch (err) {
      setToast({
        kind: "error",
        message: `Could not read file: ${(err as Error).message}`,
      });
    } finally {
      e.target.value = "";
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    try {
      const thresholdRaw = form.auto_close_severity_threshold.trim();
      let threshold: number | null = null;
      if (thresholdRaw.length > 0) {
        const n = Number(thresholdRaw);
        if (!Number.isInteger(n) || n < 1 || n > 10) {
          setToast({
            kind: "error",
            message: "Threshold must be an integer 1–10.",
          });
          setSaving(false);
          return;
        }
        threshold = n;
      }

      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase
        .from("repo_rules")
        .upsert(
          {
            repo,
            enabled: form.enabled,
            auto_close_all: form.auto_close_all,
            auto_close_severity_threshold: threshold,
            watch_paths: linesToArray(form.watch_paths),
            skip_paths: linesToArray(form.skip_paths),
            custom_instructions:
              form.custom_instructions.trim().length > 0
                ? form.custom_instructions
                : null,
            rules_file_content:
              form.rules_file_content.length > 0
                ? form.rules_file_content
                : null,
          },
          { onConflict: "repo" },
        );

      if (error) throw error;
      setToast({ kind: "success", message: "Saved" });
    } catch (err) {
      setToast({
        kind: "error",
        message: `Save failed: ${(err as Error).message}`,
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-10">
        <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
      </main>
    );
  }

  // Status pill in the header reflects the live form state, not the
  // saved state — operators get immediate visual feedback when they
  // flip the "Enable reviews" toggle.
  const statusPill = form.enabled
    ? { bg: "#dcfce7", color: "#15803d", label: "Active" }
    : { bg: "#fee2e2", color: "#b91c1c", label: "Paused" };

  return (
    <main className="max-w-3xl mx-auto px-6 py-8 pb-24">
      {/* Header */}
      <div className="mb-6 space-y-3">
        <Link
          href="/repos"
          className="text-xs text-muted hover:text-text inline-flex items-center gap-1"
        >
          ← All repos
        </Link>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-text font-mono truncate">
              {repo}
            </h1>
            <p className="text-xs text-muted mt-1">
              Per-repo rules · read by the agent before each review.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="px-2 py-0.5 rounded-full text-xs font-medium"
              style={{
                backgroundColor: statusPill.bg,
                color: statusPill.color,
              }}
            >
              {statusPill.label}
            </span>
            <a
              href={`https://github.com/${repo}`}
              target="_blank"
              rel="noreferrer"
              title="Open on GitHub"
              aria-label={`Open ${repo} on GitHub`}
              className="text-xs text-muted hover:text-text border border-border rounded-md px-2 py-1"
            >
              GitHub ↗
            </a>
          </div>
        </div>
      </div>

      <div className="space-y-5">
        {/* Section 1 — Agent behavior */}
        <Section title="Agent behavior">
          <ToggleRow
            checked={form.enabled}
            onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
            label="Enable reviews"
            hint="When off, the agent skips this repo on every run."
          />
          <ToggleRow
            checked={form.auto_close_all}
            onChange={(v) => setForm((f) => ({ ...f, auto_close_all: v }))}
            label="Auto-close all PRs"
            hint="Bypasses the severity gate. Use only on repos you want to drain."
            tone="danger"
          />

          {form.auto_close_all && (
            <div
              className="text-xs rounded-md px-3 py-2 border"
              style={{
                color: "#991b1b",
                backgroundColor: "#fef2f2",
                borderColor: "#fecaca",
              }}
              role="alert"
            >
              This will close every PR including good ones. Use with caution.
            </div>
          )}

          <div className="pt-1">
            <label className={LABEL} htmlFor="threshold">
              Auto-close severity threshold
            </label>
            <div className="flex items-center gap-3">
              <input
                id="threshold"
                type="number"
                min={1}
                max={10}
                placeholder="9"
                value={form.auto_close_severity_threshold}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    auto_close_severity_threshold: e.target.value,
                  }))
                }
                className={`${INPUT} w-24 text-center`}
              />
              <p className={SUBLABEL}>
                Severity ≥ this triggers auto-close. Blank = global default (9).
              </p>
            </div>
          </div>
        </Section>

        {/* Section 2 — Path filters */}
        <Section
          title="Path filters"
          description="Scope reviews by file path. Both lists accept one entry per line."
        >
          <div>
            <label className={LABEL} htmlFor="watch_paths">
              Watch paths
            </label>
            <textarea
              id="watch_paths"
              rows={3}
              value={form.watch_paths}
              onChange={(e) =>
                setForm((f) => ({ ...f, watch_paths: e.target.value }))
              }
              className={TEXTAREA}
              placeholder="src/&#10;api/"
            />
            <p className={`${SUBLABEL} mt-1.5`}>
              Empty reviews everything. Otherwise only PRs touching these
              paths are reviewed.
            </p>
          </div>

          <div>
            <label className={LABEL} htmlFor="skip_paths">
              Skip paths
            </label>
            <textarea
              id="skip_paths"
              rows={3}
              value={form.skip_paths}
              onChange={(e) =>
                setForm((f) => ({ ...f, skip_paths: e.target.value }))
              }
              className={TEXTAREA}
              placeholder="README.md&#10;docs/"
            />
            <p className={`${SUBLABEL} mt-1.5`}>
              PRs touching only these paths are auto-approved without review.
            </p>
          </div>
        </Section>

        {/* Section 3 — Custom instructions */}
        <Section
          title="Custom instructions"
          description="Free-form rules appended to the reviewer prompt for this repo."
        >
          <div>
            <textarea
              rows={5}
              value={form.custom_instructions}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  custom_instructions: e.target.value,
                }))
              }
              className={TEXTAREA}
              placeholder="e.g. Flag any PR that modifies authentication logic with severity 9 or higher."
            />
          </div>

          <div className="pt-1">
            <label className={LABEL}>Rules file</label>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="inline-flex items-center gap-2 px-3 py-1.5 border border-border rounded-md cursor-pointer hover:bg-bg text-sm transition-colors">
                <input
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                Choose file
              </label>
              {form.rules_file_name && (
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
                    style={{
                      backgroundColor: "#dcfce7",
                      color: "#15803d",
                    }}
                  >
                    <span className="font-mono">{form.rules_file_name}</span>
                    <span>· {form.rules_file_content.length} chars</span>
                  </span>
                  <button
                    type="button"
                    className="text-muted hover:text-text underline"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        rules_file_content: "",
                        rules_file_name: null,
                      }))
                    }
                  >
                    remove
                  </button>
                </div>
              )}
            </div>
            <p className={`${SUBLABEL} mt-1.5`}>
              Appended to the instructions above. .txt or .md, up to 200KB.
            </p>
          </div>
        </Section>

        {/* Section 4 — Repository structure */}
        <Section
          title="Repository structure"
          description="Read-only · populated by the agent from recent PR diffs."
        >
          {directoryTree ? (
            <pre className="font-mono text-xs leading-relaxed text-muted whitespace-pre-wrap overflow-x-auto bg-bg border border-border rounded-md p-3 max-h-64 overflow-y-auto">
              {directoryTree}
            </pre>
          ) : (
            <div className="text-sm text-muted bg-bg border border-border rounded-md p-3">
              Appears after the next agent run.
            </div>
          )}
        </Section>
      </div>

      {/* Sticky save bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-card/95 backdrop-blur border-t border-border">
        <div className="max-w-3xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
          <Link
            href={`/?repo=${encodeURIComponent(repo)}`}
            className="text-xs text-muted hover:text-text"
          >
            ← Back to reviews
          </Link>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: "#4338ca" }}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {toast && (
        <div
          className="fixed bottom-20 right-6 px-4 py-2 rounded-md shadow-lg text-sm font-medium"
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
