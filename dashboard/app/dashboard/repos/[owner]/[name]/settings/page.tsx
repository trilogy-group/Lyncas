"use client";

// Per-repo configuration page. v3 black/E2B aesthetic, rebuilt to match
// the dashboard settings vocabulary: panel header bars (☰ ✕ TITLE +
// right meta), orange pill toggles, a severity slider, path "chips" with
// inline add/remove, and a parsed repo file tree. The page carries its
// own rose grid backdrop so it reads as a distinct surface.

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { GridBackdrop } from "@/components/ui/grid-backdrop";
import {
  SettingsPanel,
  SettingsRow,
  SettingsRows,
  Toggle,
} from "@/components/ui/settings-panel";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { RepoRule } from "@/lib/types";

interface PageProps {
  params: Promise<{ owner: string; name: string }>;
}

interface FormState {
  enabled: boolean;
  auto_close_all: boolean;
  auto_close_severity_threshold: string;
  watch_paths: string[];
  skip_paths: string[];
  custom_instructions: string;
  rules_file_content: string;
  rules_file_name: string | null;
}

const DEFAULT_FORM: FormState = {
  enabled: true,
  auto_close_all: false,
  auto_close_severity_threshold: "",
  watch_paths: [],
  skip_paths: [],
  custom_instructions: "",
  rules_file_content: "",
  rules_file_name: null,
};

// Page theme accent — emerald green, matching this surface's grid
// backdrop. Threaded through toggles, the severity slider, the file-tree
// folders, and the save pill so the page reads as a single green-accented
// surface (the third color beyond black + white).
const ACCENT = "#34d399";
const DANGER = "#ff5a5a";
const DEFAULT_SEVERITY = 9;

function cleanPaths(arr: string[] | null | undefined): string[] {
  return (arr ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---- Small inline icons ------------------------------------------------

function FolderIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    </svg>
  );
}

// ---- Path chip list ----------------------------------------------------

function PathList({
  items,
  onAdd,
  onRemove,
  placeholder,
  inputId,
}: {
  items: string[];
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  placeholder: string;
  inputId: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft("");
  }

  return (
    <div className="space-y-2">
      {items.length > 0 ? (
        <div className="space-y-1.5">
          {items.map((p, i) => (
            <div
              key={`${p}-${i}`}
              className="group flex items-center gap-2.5 rounded-sm border border-border bg-bg px-3 py-2"
            >
              <span className="text-muted/70">
                <FolderIcon />
              </span>
              <span className="flex-1 truncate font-mono text-xs text-text">
                {p}
              </span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label={`Remove ${p}`}
                className="text-muted transition-colors hover:text-[#ff5a5a]"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-sm border border-dashed border-border px-3 py-2 text-[11px] text-muted">
          No paths yet — leave empty to apply to the whole repo.
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          id={inputId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          className="h-9 flex-1 rounded-sm border border-border bg-bg px-3 font-mono text-xs text-white transition-colors focus:border-border-strong focus:outline-none"
        />
        <button
          type="button"
          onClick={commit}
          disabled={!draft.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-border px-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted transition-colors hover:border-border-strong hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Add
        </button>
      </div>
    </div>
  );
}

// ---- Repo file tree ----------------------------------------------------

function FileTree({ tree }: { tree: string }) {
  const lines = tree
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  return (
    <div className="max-h-72 overflow-auto rounded-sm border border-border bg-bg p-3 font-mono text-xs">
      {lines.map((raw, i) => {
        // Strip vertical guides, then measure the remaining lead (spaces +
        // branch glyphs) to approximate the nesting depth.
        const stripped = raw.replace(/[│|]/g, " ");
        const lead = stripped.match(/^[\s├└─]*/)?.[0].length ?? 0;
        const name = stripped.replace(/^[\s├└─]*/, "").trim();
        if (!name) return null;
        const isDir = name.endsWith("/") || !name.includes(".");
        const depth = Math.min(6, Math.round(lead / 2));
        return (
          <div
            key={i}
            className="flex items-center gap-2 py-[3px]"
            style={{ paddingLeft: depth * 14 }}
          >
            <span style={{ color: isDir ? ACCENT : undefined }} className={isDir ? "" : "text-muted"}>
              {isDir ? <FolderIcon /> : <FileIcon />}
            </span>
            <span className={isDir ? "text-text" : "text-muted"}>
              {name.replace(/\/$/, "")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---- Page --------------------------------------------------------------

export default function RepoSettingsPage({ params }: PageProps) {
  const { owner, name } = use(params);
  const repo = `${owner}/${name}`;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [directoryTree, setDirectoryTree] = useState<string | null>(null);

  // Centralized updater so any edit flips the dirty flag.
  function update(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  }

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
        if (error || !data) {
          setForm(DEFAULT_FORM);
          setDirectoryTree(null);
        } else {
          const r = data as RepoRule;
          setForm({
            enabled: r.enabled,
            auto_close_all: r.auto_close_all,
            auto_close_severity_threshold:
              r.auto_close_severity_threshold !== null
                ? String(r.auto_close_severity_threshold)
                : "",
            watch_paths: cleanPaths(r.watch_paths),
            skip_paths: cleanPaths(r.skip_paths),
            custom_instructions: r.custom_instructions ?? "",
            rules_file_content: r.rules_file_content ?? "",
            rules_file_name: r.rules_file_content ? "saved file" : null,
          });
          setDirectoryTree(r.repo_directory_tree ?? null);
        }
        setDirty(false);
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

  const severity = useMemo(() => {
    const n = Number(form.auto_close_severity_threshold);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? n : DEFAULT_SEVERITY;
  }, [form.auto_close_severity_threshold]);

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
      update({ rules_file_content: text, rules_file_name: file.name });
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
      const { error } = await supabase.from("repo_rules").upsert(
        {
          repo,
          enabled: form.enabled,
          auto_close_all: form.auto_close_all,
          auto_close_severity_threshold: threshold,
          watch_paths: cleanPaths(form.watch_paths),
          skip_paths: cleanPaths(form.skip_paths),
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
      setDirty(false);
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
      <div className="relative">
        <GridBackdrop tone="emerald" />
        <Container size="narrow" className="relative py-10">
          <div className="rounded-md border border-border bg-card p-10 text-center text-sm text-muted">
            Loading…
          </div>
        </Container>
      </div>
    );
  }

  // Top-right save state pill.
  const saveState = saving
    ? { label: "Saving…", color: "#f5c63a" }
    : dirty
      ? { label: "Unsaved", color: "#9a9a9a" }
      : { label: "✓ Saved", color: ACCENT };

  return (
    <div className="relative">
      <GridBackdrop tone="emerald" />
      <Container size="wide" className="relative py-10 pb-28">
        {/* ---- Header ----------------------------------------------------- */}
        <header className="mb-8 space-y-3">
          <nav className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            <Link href="/dashboard/repos" className="hover:text-white">
              ‹ Repos
            </Link>
            <span className="text-muted/40">/</span>
            <span className="text-muted-strong">{repo}</span>
            <span className="text-muted/40">/</span>
            <span className="text-muted/60">Settings</span>
          </nav>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <h1 className="flex items-center gap-2.5 truncate font-mono text-[26px] font-semibold tracking-tight text-white">
                <span style={{ color: ACCENT }} aria-hidden>
                  ⑂
                </span>
                {/* {repo} */}
                CONFIGURE REPO RULES
              </h1>
              <p className="text-xs text-muted">
                Configure how the agent reviews this repository.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="inline-flex items-center rounded-sm border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em]"
                style={{ color: saveState.color, borderColor: `${saveState.color}55` }}
              >
                {saveState.label}
              </span>
              <a
                href={`https://github.com/${repo}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-sm border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted transition-colors hover:border-border-strong hover:text-white"
              >
                GitHub ↗
              </a>
            </div>
          </div>
        </header>

        <div className="space-y-6">
          {/* ---- Status --------------------------------------------------- */}
          <SettingsPanel title="Status" meta={form.enabled ? "Active" : "Paused"}>
            <SettingsRow
              className="py-0"
              title="Reviews enabled"
              description="When off, the agent ignores new PRs on this repo."
              control={
                <Toggle
                  label="Reviews enabled"
                  checked={form.enabled}
                  onChange={(v) => update({ enabled: v })}
                  color={ACCENT}
                />
              }
            />
          </SettingsPanel>

          {/* ---- Auto-close ----------------------------------------------- */}
          <SettingsPanel title="Auto-close" meta="3 gates">
            <p className="mb-4 text-xs leading-relaxed text-muted">
              Auto-close fires only when confidence, severity, and verdict all
              pass — the three gates.
            </p>

            <div className="border-t border-border">
              <SettingsRows>
                <SettingsRow
                  title="Auto-close all PRs"
                  description="Bypasses the severity gate and closes every PR. Use only on repos you want to drain."
                  control={
                    <Toggle
                      label="Auto-close all PRs"
                      checked={form.auto_close_all}
                      onChange={(v) => update({ auto_close_all: v })}
                      color={DANGER}
                    />
                  }
                />
              </SettingsRows>
            </div>

            {form.auto_close_all && (
              <div
                className="mt-3 rounded-sm border border-[#ff5a5a]/40 bg-[#ff5a5a]/10 px-3 py-2 text-xs text-[#ff5a5a]"
                role="alert"
              >
                This closes every PR including good ones. Use with caution.
              </div>
            )}

            {/* Severity slider */}
            <div
              className={
                "mt-5 space-y-3" + (form.auto_close_all ? " opacity-40" : "")
              }
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                  Severity threshold
                </span>
                <span
                  className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums"
                  style={{ color: ACCENT }}
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ACCENT }} aria-hidden />
                  {severity}
                  <span className="text-muted">/10</span>
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={severity}
                disabled={form.auto_close_all}
                onChange={(e) =>
                  update({ auto_close_severity_threshold: e.target.value })
                }
                aria-label="Severity threshold"
                className="w-full cursor-pointer"
                style={{ accentColor: ACCENT }}
              />
              <p className="text-xs text-muted">
                Only PRs at or above severity{" "}
                <span className="font-mono text-muted-strong">{severity}</span>{" "}
                are eligible for auto-close.
              </p>
            </div>
          </SettingsPanel>

          {/* ---- Path filters --------------------------------------------- */}
          <div className="grid gap-6 md:grid-cols-2">
            <SettingsPanel title="Watch paths" meta="Reviewed">
              <p className="mb-3 text-xs text-muted">
                Empty reviews everything. Otherwise only PRs touching these
                paths are reviewed.
              </p>
              <PathList
                inputId="watch_paths"
                items={form.watch_paths}
                placeholder="src/**"
                onAdd={(v) =>
                  update({ watch_paths: [...form.watch_paths, v] })
                }
                onRemove={(i) =>
                  update({
                    watch_paths: form.watch_paths.filter((_, idx) => idx !== i),
                  })
                }
              />
            </SettingsPanel>

            <SettingsPanel title="Skip paths" meta="Ignored">
              <p className="mb-3 text-xs text-muted">
                PRs touching only these paths are auto-approved without review.
              </p>
              <PathList
                inputId="skip_paths"
                items={form.skip_paths}
                placeholder="**/*.test.ts"
                onAdd={(v) => update({ skip_paths: [...form.skip_paths, v] })}
                onRemove={(i) =>
                  update({
                    skip_paths: form.skip_paths.filter((_, idx) => idx !== i),
                  })
                }
              />
            </SettingsPanel>
          </div>

          {/* ---- Custom instructions -------------------------------------- */}
          <SettingsPanel title="Custom instructions" meta="Free text">
            <p className="mb-3 text-xs text-muted">
              Natural-language guidance the reviewer reads on every PR.
            </p>
            <textarea
              rows={5}
              value={form.custom_instructions}
              onChange={(e) => update({ custom_instructions: e.target.value })}
              placeholder="e.g. Prefer named exports. Flag any direct DB calls outside the data layer. Our team uses conventional commits."
              className="w-full rounded-sm border border-border bg-bg px-3 py-2.5 font-mono text-xs leading-relaxed text-white transition-colors focus:border-border-strong focus:outline-none"
            />
          </SettingsPanel>

          {/* ---- Rules file + file tree ----------------------------------- */}
          <div className="grid gap-6 md:grid-cols-2">
            <SettingsPanel title="Rules file" meta=".lyncas/rules.md">
              {form.rules_file_content ? (
                <pre className="mb-3 max-h-64 overflow-auto rounded-sm border border-border bg-bg p-3 font-mono text-xs leading-relaxed text-muted-strong">
                  {form.rules_file_content}
                </pre>
              ) : (
                <p className="mb-3 rounded-sm border border-dashed border-border px-3 py-6 text-center text-xs text-muted">
                  No rules file. Upload a .md or .txt to append repo-specific
                  rules to the reviewer.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-sm border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted transition-colors hover:border-border-strong hover:text-white">
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
                    <span className="inline-flex items-center gap-1.5 rounded-sm bg-[#58e684]/15 px-2 py-0.5 text-[#58e684]">
                      <span className="font-mono">{form.rules_file_name}</span>
                      <span>· {form.rules_file_content.length} chars</span>
                    </span>
                    <button
                      type="button"
                      className="text-muted underline underline-offset-4 hover:text-white"
                      onClick={() =>
                        update({ rules_file_content: "", rules_file_name: null })
                      }
                    >
                      remove
                    </button>
                  </div>
                )}
              </div>
            </SettingsPanel>

            <SettingsPanel title="Repo file tree" meta="Read-only">
              {directoryTree ? (
                <FileTree tree={directoryTree} />
              ) : (
                <p className="rounded-sm border border-dashed border-border px-3 py-6 text-center text-xs text-muted">
                  Appears after the next agent run.
                </p>
              )}
            </SettingsPanel>
          </div>
        </div>
      </Container>

      {/* ---- Sticky save bar --------------------------------------------- */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-end gap-3 px-4 py-3 sm:px-6">
          <Link
            href="/dashboard/repos"
            className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-white"
          >
            Cancel
          </Link>
          <Button
            type="button"
            disabled={saving || !dirty}
            onClick={handleSave}
            variant="primary"
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "✓ Saved"}
          </Button>
        </div>
      </div>

      {toast && (
        <div
          className={
            "fixed bottom-20 right-6 z-40 rounded-sm px-4 py-2 text-sm font-medium shadow-lg " +
            (toast.kind === "success"
              ? "bg-[#58e684] text-black"
              : "bg-[#ff5a5a] text-black")
          }
          role="status"
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
