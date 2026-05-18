"use client";

// Per-repo configuration page. The only 'use client' page in the
// dashboard — everything else is a server component. We need client
// because: file upload (FileReader), local form state, optimistic
// save toasts, and direct Supabase writes from the browser through
// the anon key (RLS policy in 009_repo_rules.sql allows anon write).
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

const LABEL = "block text-xs font-mono uppercase tracking-wide text-muted mb-2";
const INPUT =
  "w-full bg-card border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent";
const TEXTAREA = `${INPUT} font-mono text-xs leading-relaxed`;
const HINT = "text-xs text-muted mt-1 font-serif italic";
const SECTION = "space-y-4";
const SECTION_TITLE = "text-base font-semibold border-b border-border pb-2";

function arrayToLines(arr: string[] | null | undefined): string {
  return (arr ?? []).join("\n");
}

function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
            rules_file_name: r.rules_file_content ? "(saved)" : null,
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
        message: `File ${file.name} is too large (${file.size} bytes; max 200KB).`,
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
      // Reset the input so re-selecting the same file fires onChange.
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
            message: "Severity threshold must be an integer 1-10.",
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
      setToast({ kind: "success", message: "Saved." });
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
      <main className="max-w-3xl mx-auto px-6 py-8">
        <Card className="p-8 text-center text-muted text-sm">Loading…</Card>
      </main>
    );
  }

  return (
    <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">
      <section className="space-y-2">
        <div className="text-xs font-mono text-muted">
          <Link
            href={`/?repo=${encodeURIComponent(repo)}`}
            className="hover:text-text"
          >
            ← Back to reviews
          </Link>
          {" · "}
          <Link href="/repos" className="hover:text-text">
            All repos
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold font-mono">{repo}</h1>
          <a
            href={`https://github.com/${repo}`}
            target="_blank"
            rel="noreferrer"
            title="Open on GitHub"
            className="text-muted hover:text-text"
            aria-label={`Open ${repo} on GitHub`}
          >
            ↗
          </a>
          <span className="text-muted">/</span>
          <span className="text-muted font-mono text-sm">Settings</span>
        </div>
        <p className="text-sm text-muted italic font-serif">
          Per-repo rules — read by the agent before each review.
        </p>
      </section>

      {/* Section 1 — Agent behavior */}
      <section className={SECTION}>
        <h2 className={SECTION_TITLE}>Agent behavior</h2>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) =>
              setForm((f) => ({ ...f, enabled: e.target.checked }))
            }
            className="mt-1"
          />
          <span>
            <span className="font-medium">Enable reviews for this repo</span>
            <span className={HINT.replace("mt-1 ", "ml-0 block ")}>
              When off, the agent skips this repo on every run (cron and
              webhook). Existing reviews stay visible in the dashboard.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.auto_close_all}
            onChange={(e) =>
              setForm((f) => ({ ...f, auto_close_all: e.target.checked }))
            }
            className="mt-1"
          />
          <span>
            <span className="font-medium">
              Auto-close ALL PRs regardless of severity
            </span>
            <span className={HINT.replace("mt-1 ", "ml-0 block ")}>
              Overrides the global three-gate check. Use only on moribund
              repos you want to drain.
            </span>
          </span>
        </label>

        {form.auto_close_all && (
          <Card
            className="p-3 border-2 text-sm"
            style={{ borderColor: "#dc2626", backgroundColor: "#fef2f2" }}
          >
            <span style={{ color: "#dc2626", fontWeight: 600 }}>⚠ Warning:</span>{" "}
            This will close every PR including good ones. Use with caution.
          </Card>
        )}

        <div>
          <label className={LABEL} htmlFor="threshold">
            Auto-close severity threshold (1-10)
          </label>
          <input
            id="threshold"
            type="number"
            min={1}
            max={10}
            placeholder="9 (default)"
            value={form.auto_close_severity_threshold}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                auto_close_severity_threshold: e.target.value,
              }))
            }
            className={`${INPUT} w-32`}
          />
          <p className={HINT}>
            Severity ≥ this number triggers auto-close (still requires
            verdict=request_changes and confidence=high). Leave blank to
            inherit the global default of 9.
          </p>
        </div>
      </section>

      {/* Section 2 — Path filters */}
      <section className={SECTION}>
        <h2 className={SECTION_TITLE}>Path filters</h2>

        <div>
          <label className={LABEL} htmlFor="watch_paths">
            Watch paths (one per line)
          </label>
          <textarea
            id="watch_paths"
            rows={4}
            value={form.watch_paths}
            onChange={(e) =>
              setForm((f) => ({ ...f, watch_paths: e.target.value }))
            }
            className={TEXTAREA}
            placeholder={"src/\napi/"}
          />
          <p className={HINT}>
            Leave empty to review all PRs. Example:{" "}
            <code className="font-mono">src/ api/</code> to only review PRs
            touching those directories.
          </p>
        </div>

        <div>
          <label className={LABEL} htmlFor="skip_paths">
            Skip paths (one per line)
          </label>
          <textarea
            id="skip_paths"
            rows={4}
            value={form.skip_paths}
            onChange={(e) =>
              setForm((f) => ({ ...f, skip_paths: e.target.value }))
            }
            className={TEXTAREA}
            placeholder={"README.md\ndocs/"}
          />
          <p className={HINT}>
            PRs touching ONLY these paths are auto-approved without review.
            Example: <code className="font-mono">README.md docs/</code>.
          </p>
        </div>
      </section>

      {/* Section 3 — Custom instructions */}
      <section className={SECTION}>
        <h2 className={SECTION_TITLE}>Custom instructions</h2>

        <div>
          <label className={LABEL} htmlFor="custom_instructions">
            Custom instructions for the agent
          </label>
          <textarea
            id="custom_instructions"
            rows={6}
            value={form.custom_instructions}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                custom_instructions: e.target.value,
              }))
            }
            className={TEXTAREA}
            placeholder={
              "e.g. Auto-close any PR that adds console.log statements. " +
              "Flag all PRs that modify authentication logic with severity " +
              "9 or higher."
            }
          />
          <p className={HINT}>
            Injected into the reviewer prompt with an{" "}
            <code className="font-mono">OPERATOR RULES:</code> header before
            the diff. Plain natural language.
          </p>
        </div>

        <div>
          <label className={LABEL}>Upload rules file (.txt or .md)</label>
          <div className="flex items-center gap-3">
            <label
              className="inline-flex items-center gap-2 px-3 py-1.5 border border-border rounded cursor-pointer hover:bg-bg text-sm"
            >
              <input
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                onChange={handleFileUpload}
                className="hidden"
              />
              Choose file…
            </label>
            {form.rules_file_name && (
              <span className="text-xs font-mono text-muted">
                <code>{form.rules_file_name}</code>{" "}
                <span
                  style={{
                    color: "#16a34a",
                    fontWeight: 600,
                  }}
                >
                  uploaded
                </span>{" "}
                ({form.rules_file_content.length} chars)
                <button
                  type="button"
                  className="ml-2 text-muted hover:text-text underline"
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
              </span>
            )}
          </div>
          <p className={HINT}>
            Appended to the custom instructions above when both are set.
            Max 200KB.
          </p>
        </div>
      </section>

      {/* Section 4 — Repository structure */}
      <section className={SECTION}>
        <h2 className={SECTION_TITLE}>Repository structure</h2>
        {directoryTree ? (
          <Card className="p-4">
            <pre className="font-mono text-xs leading-relaxed text-muted whitespace-pre-wrap overflow-x-auto">
              {directoryTree}
            </pre>
          </Card>
        ) : (
          <Card className="p-4 text-sm text-muted italic font-serif">
            Directory structure will appear after the next agent run.
          </Card>
        )}
      </section>

      {/* Save bar */}
      <section className="flex items-center justify-between sticky bottom-0 bg-bg border-t border-border py-4">
        <div className="text-xs font-mono text-muted">
          {saving ? "Saving…" : "Changes save only when you click Save."}
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={handleSave}
          className="px-4 py-2 rounded font-medium text-sm disabled:opacity-50"
          style={{
            backgroundColor: "#4338ca",
            color: "white",
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </section>

      {toast && (
        <div
          className="fixed bottom-6 right-6 px-4 py-2 rounded shadow-lg text-sm font-mono"
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
