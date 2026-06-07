"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { GridBackdrop } from "@/components/ui/grid-backdrop";
import { DevPodPanel } from "@/components/devpod-panel";
import { SandboxTestCard } from "@/components/sandbox-test-card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { downloadMarkdownDocx } from "@/lib/docx-report";

// /dashboard/chat — three-column repo chat workspace.
//
// Columns:
//   ┌─ 220px left ─┬─ flex chat ─────────────────────┬─ 280px right ─┐
//   │ repo picker  │ messages + composer             │ Repository    │
//   │ (dropdown)   │                                 │ Research      │
//   │ quick acts   │                                 │               │
//   └──────────────┴─────────────────────────────────┴───────────────┘
//
// Responsive:
//   * < 768px (mobile)    : left sidebar collapses into a dropdown at
//                            the top of the chat pane. Right sidebar
//                            is hidden entirely.
//   * 768–1023px (tablet) : both side panels visible, right sidebar
//                            sections start collapsed.
//   * >= 1024px (desktop) : both panels visible, both right-sidebar
//                            sections start expanded.
//
// Repo connection model: there is no /dashboard/connect-repo page any
// more. On mount we ping /api/github-app/status — if the user has zero
// healthy installations on GitHub, we surface a modal pointing to the
// App install URL. The modal is also shown when GitHub bounces back
// with an install error (?install_error=…).
//
// Repo selection: handled by a single dropdown in the left sidebar
// (desktop) or at the top of the chat pane (mobile). No auto-select.

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  // Reports render as a special full-width card with white background
  // and download/copy controls. Everything else is a regular bubble.
  kind?: "chat" | "report";
  // Only set on assistant messages whose stream errored before the
  // server finished. Drives the "Response interrupted. Try again."
  // affordance — a retry button re-issues the same prompt that
  // produced this message.
  streamError?: string | null;
  // The exact user prompt that produced this assistant message; let
  // the retry button replay without the user re-typing.
  retryPrompt?: string | null;
}

interface WatchedRepoLite {
  repo: string;
}

// Per-repo research cache. Same TTL pattern — an in-flight refresh
// flips `refreshing: true` while keeping the prior `articles` visible
// so the user doesn't see a flicker on the ↻ click.
interface ResearchCacheEntry {
  summary: string | null;
  articles: ResearchArticle[];
  fetchedAt: number;
  updatedAt: string | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

interface RepoStats {
  languages: Record<string, number>;
  open_prs: number | null;
  stars: number | null;
  last_commit: string | null;
  contributors: Array<{
    login: string;
    avatar_url: string | null;
    contributions: number;
  }>;
}

interface RepoStatsState {
  repo: string;
  data: RepoStats | null;
  loading: boolean;
  error: string | null;
}

interface ResearchArticle {
  title: string;
  url: string;
  source: string;
  description: string;
}

interface ResearchState {
  repo: string;
  summary: string | null;
  articles: ResearchArticle[];
  updatedAt: string | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

// Last review date per watched repo, surfaced in the repo selector.
// Populated lazily on first dropdown open + on bootstrap, cached in
// component state for the session.
interface LastReviewLookup {
  [repo: string]: string | null; // ISO timestamp or null
}

interface InstallStatusState {
  healthy: number;
  stale: number;
  installUrl: string | null;
  loaded: boolean;
}

interface TreeApiEntry {
  path: string;
  dir: boolean;
}

interface DirectoryTreeState {
  repo: string;
  entries: TreeApiEntry[] | null;
  defaultBranch: string;
  truncated: boolean;
  loading: boolean;
}

const MAX_INPUT_CHARS = 2000;
// Hide the live count below this length — it's only useful as a
// "are you about to hit the cap?" hint, not a constant nag.
const CHAR_COUNT_VISIBLE_THRESHOLD = 500;

// Persistence ----------------------------------------------------------------
// SessionStorage (NOT localStorage) — fresh tab = fresh state, which is
// the right contract for a chat workspace. localStorage would survive
// browser restart and confuse users who expect "I closed the tab, the
// agent forgot what we were talking about".
const STORAGE_KEY = "lyncas-chat-state";
// Bump when the persisted shape changes incompatibly. Stale blobs from
// older versions are dropped on read.
const STORAGE_VERSION = 1;
const RESEARCH_TTL_MS = 30 * 60 * 1000; // 30 min per spec

// Quick actions — three rows, three columns. The third row is the
// "actions" row; "Run tests" is shown ONLY when DevPod is connected.
// Each entry's `prompt` is what we send to /api/chat verbatim — keep
// them concrete so the model has a clear instruction.
type QuickActionIcon =
  | "prs"
  | "review"
  | "merge"
  | "health"
  | "branches"
  | "contributors"
  | "tests"
  | "report"
  | "bugs";

type QuickAction = {
  label: string;
  icon: QuickActionIcon;
  prompt: string;
  // When true, the button is hidden unless DevPod is live for the
  // current user. Used by "Run tests" — meaningless without a
  // sandbox tunnel to dispatch into.
  requiresDevpod?: boolean;
  // When set, the click triggers an in-app behaviour rather than
  // sending a chat prompt. Currently only "report" piggybacks on
  // generateReport().
  action?: "report";
};

const QUICK_ACTION_ROWS: ReadonlyArray<ReadonlyArray<QuickAction>> = [
  // Row 1 — PR actions
  [
    {
      label: "Open PRs",
      icon: "prs",
      prompt:
        "List all open pull requests with their status, author, and age",
    },
    {
      label: "Review latest PR",
      icon: "review",
      prompt:
        "Review the most recently opened PR. Give verdict, severity, and top 3 issues",
    },
    {
      label: "Recent merges",
      icon: "merge",
      prompt: "Show the last 5 merged PRs with what changed",
    },
  ],
  // Row 2 — Code intelligence
  [
    {
      label: "Repo health",
      icon: "health",
      prompt:
        "Give me a repo health summary: open PRs, recent activity, top contributors, and any concerns",
    },
    {
      label: "Branches",
      icon: "branches",
      prompt:
        "List all branches, their age, and which ones are stale (no commits in 14+ days)",
    },
    {
      label: "Contributors",
      icon: "contributors",
      prompt:
        "Who are the top contributors this month and what have they been working on",
    },
  ],
  // Row 3 — Actions
  [
    {
      label: "Run tests",
      icon: "tests",
      prompt:
        "Run the sandbox tests on the most recent open PR and tell me whether it's safe to merge",
      requiresDevpod: true,
    },
    {
      label: "Generate report",
      icon: "report",
      prompt: "",
      action: "report",
    },
    {
      label: "Find bugs",
      icon: "bugs",
      prompt:
        "Review the diff of all open PRs and list the top 5 most critical bugs found across all of them",
    },
  ],
];

// --- Tiny markdown subset -------------------------------------------------
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Render a small subset of Markdown to safe HTML. The output is
// dropped via dangerouslySetInnerHTML so every input is escapeHtml'd
// FIRST, then markup is reintroduced in a controlled way.
//
// Supported:
//   * **bold**
//   * *italic*
//   * `inline code`
//   * ```fenced code blocks```
//   * # / ## / ### headings
//   * - or * bullet lists
//   * 1. ordered lists
//   * GitHub-flavoured pipe tables (header | --- | row body)
//   * paragraph breaks on blank lines
//
// NOT supported (deliberately): inline links (turning user/agent
// markdown into clickable links is a phishing risk on a chat
// surface — keep raw text), images, blockquotes, strikethrough.
function renderMarkdown(raw: string): string {
  let s = escapeHtml(raw);
  s = s.replace(/```([\s\S]*?)```/g, (_m, body: string) => {
    return `<pre class="code-block"><code>${body.replace(/^\n/, "")}</code></pre>`;
  });
  s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const lines = s.split("\n");
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  function closeLists() {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ----- table block -----
    // GitHub-style: header row, separator row of |---|, body rows.
    // We require at least the separator to recognize a table — bare
    // `| key | val |` lines without a separator are common in chat
    // (e.g. "use | as a separator") and shouldn't all become tables.
    const isHeaderCandidate = /^\s*\|.+\|\s*$/.test(line);
    const sep = lines[i + 1];
    const isSeparator =
      typeof sep === "string" && /^\s*\|?\s*[:\-| ]+\|[:\-| ]+\s*\|?\s*$/.test(sep);
    if (isHeaderCandidate && isSeparator) {
      closeLists();
      const parseCells = (l: string): string[] =>
        l
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = parseCells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j])) {
        rows.push(parseCells(lines[j]));
        j++;
      }
      out.push('<table class="md-table"><thead><tr>');
      for (const h of headers) out.push(`<th>${h}</th>`);
      out.push("</tr></thead><tbody>");
      for (const row of rows) {
        out.push("<tr>");
        for (let k = 0; k < headers.length; k++) {
          out.push(`<td>${row[k] ?? ""}</td>`);
        }
        out.push("</tr>");
      }
      out.push("</tbody></table>");
      i = j - 1; // skip body lines we just consumed
      continue;
    }

    // ----- horizontal rule -----
    // A line of 3+ repeated -, * or _ (and nothing else) is a thematic
    // break. LLMs emit these constantly as section separators; without
    // this rule they render as a literal "---".
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeLists();
      out.push('<hr class="md-hr"/>');
      continue;
    }

    // ----- ATX headings (# … ######) -----
    // Generalised so ####/#####/###### no longer fall through and
    // render as literal hashes. Levels >3 collapse onto a compact h4
    // style. A trailing run of #'s (atx-closed headings) is trimmed.
    const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      closeLists();
      const level = Math.min(heading[1].length, 4);
      const tag = level <= 3 ? `h${level}` : "h4";
      out.push(`<${tag} class="md-h${level}">${heading[2]}</${tag}>`);
      continue;
    }

    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul) {
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul class="md-list">');
        inUl = true;
      }
      out.push(`<li>${ul[1]}</li>`);
      continue;
    }
    if (ol) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol class="md-list md-list-ordered">');
        inOl = true;
      }
      out.push(`<li>${ol[1]}</li>`);
      continue;
    }

    // ----- blank line inside a list -----
    // When the model emits `- one\n\n- two\n\n- three`, the naive
    // parser would close the <ul> on every blank line and reopen it
    // on the next bullet, producing three sibling <ul> blocks each
    // wrapped in its own <p> by the post-processor — i.e. a full
    // paragraph margin between bullets. Detect "blank line followed
    // by another bullet" and stay inside the list. We push the
    // blank as a literal line so the surrounding `<br>` collapse
    // logic still works for non-list contexts.
    if ((inUl || inOl) && line.trim() === "") {
      let k = i + 1;
      while (k < lines.length && lines[k].trim() === "") k++;
      const next = lines[k] ?? "";
      const nextIsUl = /^\s*[-*]\s+/.test(next);
      const nextIsOl = /^\s*\d+\.\s+/.test(next);
      if ((inUl && nextIsUl) || (inOl && nextIsOl)) {
        // Skip the blank — we're still in the same list. Don't
        // jump `i`; the blank line itself produces nothing.
        continue;
      }
    }

    closeLists();
    out.push(line);
  }
  closeLists();

  // Post-processing:
  //   1. Split into paragraphs on blank lines.
  //   2. For chunks that are block-level (start with <ul>, <ol>,
  //      <table>, <pre>, <h{1,2,3}>): emit the chunk verbatim with
  //      newlines collapsed (NOT converted to <br/> — that would
  //      inject invalid `<br>` between `<li>` siblings, rendering as
  //      extra vertical space in every browser we care about).
  //   3. For text chunks: convert intra-paragraph newlines to <br/>
  //      and wrap in <p>.
  //
  // The old version wrapped every chunk in <p> and br-substituted
  // newlines globally; that produced both a paragraph margin around
  // every list AND spurious <br>s inside the list, which together
  // looked like "an empty line after every bullet".
  const BLOCK_PREFIX_RE =
    /^\s*<(ul|ol|table|pre|h1|h2|h3|h4|hr|blockquote|div)\b/i;
  return out
    .join("\n")
    .split(/\n{2,}/)
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";
      if (BLOCK_PREFIX_RE.test(trimmed)) {
        // Strip the layout newlines we inserted while assembling —
        // they have no semantic value once the block-level tags are
        // there to do the spacing for us.
        return trimmed.replace(/\n+/g, "");
      }
      return `<p>${trimmed.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("");
}

// Append a blinking caret to streaming assistant content. We render
// it as a span so the caret can animate independently of the
// surrounding text. Placed AFTER renderMarkdown so the caret never
// gets swallowed by an in-progress code fence / list / table.
function appendCaret(html: string): string {
  return html + '<span class="stream-caret" aria-hidden>▌</span>';
}

// SessionStorage helpers — single point that owns the JSON shape, so
// a future schema bump only touches this block.
function safeReadStorage<T>(): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; data?: T };
    if (!parsed || parsed.v !== STORAGE_VERSION) return null;
    return (parsed.data ?? null) as T | null;
  } catch {
    return null;
  }
}

function safeWriteStorage<T>(data: T): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: STORAGE_VERSION, data }),
    );
  } catch {
    // Quota errors / private mode — silently drop. The page still
    // works without persistence.
  }
}

// --- Display helpers ------------------------------------------------------
function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function repoOwner(repo: string): string {
  return repo.split("/")[0] || "";
}

function repoAvatarUrl(repo: string): string {
  return `https://github.com/${repoOwner(repo)}.png?size=40`;
}

function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Go: "#00ADD8",
  Rust: "#dea584",
  Java: "#b07219",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  Ruby: "#701516",
  PHP: "#4F5D95",
  "C++": "#f34b7d",
  C: "#555555",
  "C#": "#178600",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Dockerfile: "#384d54",
  SQL: "#336791",
  Markdown: "#083fa1",
};

function languageColor(name: string): string {
  return LANG_COLORS[name] ?? "#888";
}

function urlHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function faviconUrl(url: string): string | null {
  const host = urlHostname(url);
  if (!host) return null;
  return `https://www.google.com/s2/favicons?sz=32&domain=${host}`;
}

// =========================================================================

export default function ChatPage() {
  // useSearchParams must be wrapped in <Suspense>. Splitting into an
  // inner component keeps the Next.js build happy.
  return (
    <Suspense
      fallback={
        <Container className="py-10">
          <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
        </Container>
      }
    >
      <ChatPageInner />
    </Suspense>
  );
}

function ChatPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [loading, setLoading] = useState(true);
  const [repos, setRepos] = useState<WatchedRepoLite[]>([]);

  // --- Persistence-backed state ----------------------------------------
  //
  // These are read once on mount from sessionStorage and then
  // mirrored back on every change. The blob is key=STORAGE_KEY,
  // shape={selectedRepo, messagesByRepo, researchByRepo}. See
  // PersistedState below.
  //
  // We pre-read the initializer eagerly inside the useState callback
  // so the first paint already shows the restored repo + messages
  // (no flicker). Subsequent reads come from React state, never
  // touching storage.
  const [hydrated, setHydrated] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [messagesByRepo, setMessagesByRepo] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [researchByRepo, setResearchByRepo] = useState<
    Record<string, ResearchCacheEntry>
  >({});

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [roomTransition, setRoomTransition] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  // Stats are not persisted (cheap to refetch, GitHub rate limit is
  // generous, no UX value in surviving a tab switch).
  const [stats, setStats] = useState<RepoStatsState | null>(null);
  const [lastReviewByRepo, setLastReviewByRepo] = useState<LastReviewLookup>(
    {},
  );

  // Derived per-repo views — these replace the old `messages` /
  // `research` flat-state. Empty/null defaults so the existing
  // renderers don't have to special-case "no entry yet".
  const messages = useMemo<ChatMessage[]>(
    () => messagesByRepo[selectedRepo] ?? [],
    [messagesByRepo, selectedRepo],
  );
  const researchEntry = researchByRepo[selectedRepo] ?? null;

  // Adapt the cache shape back to the legacy "ResearchState" the
  // existing render code reads from. We wrap rather than refactor every
  // consumer because the consumer JSX is long and stable; only the
  // store shape changed.
  const research: ResearchState | null = useMemo(
    () =>
      researchEntry
        ? {
            repo: selectedRepo,
            summary: researchEntry.summary ?? null,
            articles: researchEntry.articles,
            updatedAt: researchEntry.updatedAt,
            loading: researchEntry.loading,
            refreshing: researchEntry.refreshing,
            error: researchEntry.error,
          }
        : null,
    [researchEntry, selectedRepo],
  );

  // Most recently referenced PR number across the chat history +
  // the in-progress input. Updates as the conversation moves so the
  // SandboxTestCard always targets the PR the user is currently
  // talking about, not the first one mentioned.
  const activePrNumber = useMemo<number | null>(() => {
    const sources: string[] = [input];
    for (let i = messages.length - 1; i >= 0; i--) {
      sources.push(messages[i].content);
    }
    for (const text of sources) {
      const m =
        /#(\d{1,6})/.exec(text) ||
        /\b(?:pr|pull\s+request)\s*#?(\d{1,6})/i.exec(text);
      if (m) {
        const n = Number(m[1]);
        if (n > 0 && n < 1_000_000) return n;
      }
    }
    return null;
  }, [messages, input]);
  const [repoPanelOpen, setRepoPanelOpen] = useState<boolean | null>(null);
  const [researchPanelOpen, setResearchPanelOpen] = useState<boolean | null>(
    null,
  );

  // Whether DevPod is currently live for the signed-in user. Surfaced
  // in the header (green/grey dot), the repo dropdown (green dot per
  // row), and the quick-action gating (the "Run tests" button is
  // hidden when offline). Polled every 30s alongside the existing
  // DevPodPanel poll, but we keep our own state so the header doesn't
  // depend on the panel rendering.
  const [devpodLive, setDevpodLive] = useState(false);

  // Repo-dropdown open state lifted up so the global Cmd+K / Ctrl+K
  // shortcut can toggle it from anywhere on the page.
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);

  // Confirmation modal for "Clear chat" — never wipe a conversation
  // without an explicit confirm; it's surprisingly easy to lose 20
  // turns of context to a misclick.
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const [installStatus, setInstallStatus] = useState<InstallStatusState>({
    healthy: 0,
    stale: 0,
    installUrl: null,
    loaded: false,
  });
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [tree, setTree] = useState<DirectoryTreeState | null>(null);
  const [treePanelOpen, setTreePanelOpen] = useState(false);
  // GitHub login for the signed-in user (Supabase OAuth metadata).
  // The DevPod panel polls /api/devpod/status?username=… so we need
  // to surface it here rather than re-querying auth on every poll.
  const [githubUsername, setGithubUsername] = useState<string | null>(null);
  // Avatar shown next to the user's chat bubbles. Same provenance as
  // `githubUsername` — Supabase OAuth metadata at sign-in. Falls back
  // to https://github.com/{login}.png so we never block the bubble
  // on a missing field.
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const statsAbortRef = useRef<AbortController | null>(null);
  // Per-repo research aborts — when the user switches repos we want to
  // keep the in-flight research fetch for the OLD repo running (so when
  // they switch back, the cache is already populated). The
  // bootstrap-cleanup path doesn't try to walk this map; it gets
  // GC'd with the page.
  const researchAbortByRepoRef = useRef<Record<string, AbortController>>({});

  // ----- Mount-time hydrate from sessionStorage -----
  // We read once before any other effect so the first paint already
  // shows the restored repo + messages. After hydration, every state
  // mutation flushes back to storage via the persistence effect below.
  useEffect(() => {
    type Persisted = {
      selectedRepo?: string;
      messagesByRepo?: Record<string, ChatMessage[]>;
      researchByRepo?: Record<string, ResearchCacheEntry>;
    };
    const restored = safeReadStorage<Persisted>();
    if (restored) {
      if (typeof restored.selectedRepo === "string") {
        setSelectedRepo(restored.selectedRepo);
      }
      if (restored.messagesByRepo && typeof restored.messagesByRepo === "object") {
        setMessagesByRepo(restored.messagesByRepo);
      }
      if (restored.researchByRepo && typeof restored.researchByRepo === "object") {
        const sane: Record<string, ResearchCacheEntry> = {};
        for (const [k, v] of Object.entries(restored.researchByRepo)) {
          sane[k] = { ...v, loading: false, refreshing: false };
        }
        setResearchByRepo(sane);
      }
    }
    setHydrated(true);
  }, []);

  // ----- Persist on change -----
  // Skipped until hydration completes so the first effect run doesn't
  // overwrite the just-restored blob with the empty initial state.
  useEffect(() => {
    if (!hydrated) return;
    safeWriteStorage({
      selectedRepo,
      messagesByRepo,
      researchByRepo,
    });
  }, [
    hydrated,
    selectedRepo,
    messagesByRepo,
    researchByRepo,
  ]);

  // ----- Per-repo mutators -----
  // All stream-write helpers funnel through these so a stream that
  // started in repo A doesn't accidentally land in repo B's history
  // if the user switches mid-stream. The repo to write to is captured
  // at stream-start, not read from React state at flush time.
  const setMessagesForRepo = useCallback(
    (repo: string, updater: (prev: ChatMessage[]) => ChatMessage[]): void => {
      setMessagesByRepo((prev) => ({
        ...prev,
        [repo]: updater(prev[repo] ?? []),
      }));
    },
    [],
  );
  const updateResearchForRepo = useCallback(
    (repo: string, patch: Partial<ResearchCacheEntry>): void => {
      setResearchByRepo((prev) => {
        const cur = prev[repo] ?? {
          summary: null,
          articles: [],
          fetchedAt: 0,
          updatedAt: null,
          loading: false,
          refreshing: false,
          error: null,
        };
        return { ...prev, [repo]: { ...cur, ...patch } };
      });
    },
    [],
  );

  // Single helper for "read watched_repos for the signed-in user". We
  // call it on mount AND again after /api/github-app/status runs
  // reconciliation, because that endpoint may have deleted rows the
  // first read picked up (stale rows from a prior install).
  const refreshRepos = useCallback(async (): Promise<void> => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.replace("/login");
      return;
    }
    // Capture the GitHub login on every refresh — it's the lookup
    // key for /api/devpod/status. Falls back through the common
    // metadata fields different OAuth providers use.
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const gh =
      typeof meta.user_name === "string" && meta.user_name.trim()
        ? meta.user_name.trim()
        : typeof meta.preferred_username === "string" &&
            meta.preferred_username.trim()
          ? meta.preferred_username.trim()
          : null;
    setGithubUsername(gh);
    const avatar =
      typeof meta.avatar_url === "string" && meta.avatar_url.trim()
        ? meta.avatar_url.trim()
        : gh
          ? `https://github.com/${gh}.png?size=64`
          : null;
    setUserAvatarUrl(avatar);

    const { data } = await supabase
      .from("watched_repos")
      .select("repo")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    // If the currently selected repo got reconciled away the parent
    // bootstrap effect handles clearing it via `removed_repos`. Here
    // we just replace the list — the visual "active repo no longer
    // appears" is enough to nudge the user to pick again.
    setRepos((data ?? []) as WatchedRepoLite[]);
  }, [router, supabase]);

  // --- mount: fetch watched repos + probe install status -----------------
  // Order matters: probe runs reconciliation server-side; once that
  // finishes we re-read the repo list so the UI never displays a
  // count that disagrees with what's in the DB.
  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        await refreshRepos();
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Probe live GitHub App installation status. The route does a
      // full reconcile as a side effect — when it returns we re-read
      // watched_repos so any deleted rows disappear from the sidebar.
      try {
        const res = await fetch("/api/github-app/status");
        if (cancelled) return;
        if (!res.ok) {
          setInstallStatus((s) => ({ ...s, loaded: true }));
          return;
        }
        const data = (await res.json()) as {
          healthy: number;
          stale: number;
          removed_repos?: string[];
          install_url: string | null;
        };
        setInstallStatus({
          healthy: data.healthy ?? 0,
          stale: data.stale ?? 0,
          installUrl: data.install_url ?? null,
          loaded: true,
        });
        // Reconciliation either kept the row list intact or trimmed
        // it. Re-read either way; cheap select.
        await refreshRepos();
        // If selectedRepo got removed by reconciliation, clear it so
        // the room doesn't 403 silently when the user types.
        if (cancelled) return;
        if ((data.removed_repos ?? []).length > 0) {
          setSelectedRepo((cur) =>
            cur && (data.removed_repos ?? []).includes(cur) ? "" : cur,
          );
        }
        if ((data.healthy ?? 0) === 0) {
          setShowInstallModal(true);
        }
      } catch {
        if (!cancelled) setInstallStatus((s) => ({ ...s, loaded: true }));
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
      // Snapshot refs at cleanup time — the values may have changed
      // since the effect ran but for unmount/abort it doesn't matter
      // which controller we abort, only that we abort the current
      // one.
      const stream = abortRef.current;
      const stats = statsAbortRef.current;
      stream?.abort();
      stats?.abort();
    };
  }, [refreshRepos]);

  // --- query-string hand-offs from /auth/github-app/callback -------------
  useEffect(() => {
    const err = searchParams.get("install_error");
    const connected = searchParams.get("connected");
    if (err) {
      setInstallError(err);
      setShowInstallModal(true);
    }
    if (connected) {
      // Successful install — auto-refresh status (also reconciles) and
      // pick up the new repo list. We re-read watched_repos so the
      // sidebar shows the freshly-selected repos.
      void (async () => {
        try {
          const r = await fetch("/api/github-app/status");
          if (!r.ok) return;
          const data = (await r.json()) as {
            healthy: number;
            stale: number;
            install_url: string | null;
          };
          setInstallStatus({
            healthy: data.healthy ?? 0,
            stale: data.stale ?? 0,
            installUrl: data.install_url ?? null,
            loaded: true,
          });
          await refreshRepos();
          if ((data.healthy ?? 0) > 0) setShowInstallModal(false);
        } catch {
          // Best effort. The empty-room state handles missing repos.
        }
      })();
    }
  }, [searchParams, refreshRepos]);

  // --- fetch directory tree when selected repo changes -------------------
  // Hit /api/repo-tree which calls GitHub's recursive git-trees endpoint
  // server-side and returns the FULL repo structure as a flat
  // { path, dir } list. The Project structure panel builds an expandable
  // explorer from it (folders expand in place rather than linking out).
  useEffect(() => {
    if (!selectedRepo) {
      setTree(null);
      return;
    }
    const ac = new AbortController();
    setTree({
      repo: selectedRepo,
      entries: null,
      defaultBranch: "HEAD",
      truncated: false,
      loading: true,
    });
    void (async () => {
      try {
        const res = await fetch(
          `/api/repo-tree?repo=${encodeURIComponent(selectedRepo)}`,
          { signal: ac.signal },
        );
        let entries: TreeApiEntry[] | null = null;
        let defaultBranch = "HEAD";
        let truncated = false;
        if (res.ok) {
          const body = (await res.json()) as {
            entries?: TreeApiEntry[] | null;
            defaultBranch?: string;
            truncated?: boolean;
          };
          entries = Array.isArray(body.entries) ? body.entries : null;
          defaultBranch = body.defaultBranch ?? "HEAD";
          truncated = !!body.truncated;
        }
        if (ac.signal.aborted) return;
        setTree({
          repo: selectedRepo,
          entries,
          defaultBranch,
          truncated,
          loading: false,
        });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setTree({
          repo: selectedRepo,
          entries: null,
          defaultBranch: "HEAD",
          truncated: false,
          loading: false,
        });
      }
    })();
    return () => {
      ac.abort();
    };
  }, [selectedRepo]);

  // Initialize right-sidebar collapse defaults from viewport once.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    function sync() {
      setRepoPanelOpen((v) => (v === null ? mq.matches : v));
      setResearchPanelOpen((v) => (v === null ? mq.matches : v));
    }
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ----- DevPod liveness polling -----
  // Used by:
  //   * the chat header (green/grey dot next to "DevPod"),
  //   * the repo dropdown rows (per-repo green dot),
  //   * the quick-action gating (hide "Run tests" when offline).
  // 30s cadence matches DevPodPanel's existing poll so we don't pile
  // requests onto the small status endpoint.
  useEffect(() => {
    if (!githubUsername) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(
          `/api/devpod/status?username=${encodeURIComponent(githubUsername!)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          if (!cancelled) setDevpodLive(false);
          return;
        }
        const data = (await res.json()) as { active?: boolean };
        if (!cancelled) setDevpodLive(!!data.active);
      } catch {
        if (!cancelled) setDevpodLive(false);
      }
    }
    void poll();
    const id = window.setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [githubUsername]);

  // ----- Last review date per repo (for the dropdown) -----
  // Fetched lazily once per session — not persisted. Cheap query
  // (anon-readable reviews table); we only read created_at on the
  // most recent row per repo. Filter is OR'd at the table level so a
  // single round-trip covers every watched repo.
  useEffect(() => {
    if (repos.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const repoSet = repos.map((r) => r.repo);
        const { data } = await supabase
          .from("reviews")
          .select("repo, created_at")
          .in("repo", repoSet)
          .order("created_at", { ascending: false });
        if (cancelled || !data) return;
        const out: LastReviewLookup = {};
        for (const row of data as Array<{ repo: string; created_at: string }>) {
          if (!(row.repo in out)) out[row.repo] = row.created_at;
        }
        setLastReviewByRepo(out);
      } catch {
        // best effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repos, supabase]);

  // ----- Global Cmd+K / Ctrl+K to open the repo dropdown -----
  // Skip when a textarea/input is focused so the user doesn't lose
  // typing flow. Always preventDefault on hit so Chrome's "search
  // tabs" UI on macOS Cmd+K doesn't intercept.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "k") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          (t as HTMLElement).isContentEditable)
      ) {
        // Only intercept if the user isn't actively typing.
        return;
      }
      e.preventDefault();
      setRepoDropdownOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- stats --------------------------------------------------------------
  const fetchStats = useCallback(async (repo: string) => {
    statsAbortRef.current?.abort();
    const ac = new AbortController();
    statsAbortRef.current = ac;
    setStats({ repo, data: null, loading: true, error: null });
    try {
      const res = await fetch(
        `/api/repo-stats?repo=${encodeURIComponent(repo)}`,
        { signal: ac.signal },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setStats((s) =>
          s && s.repo === repo
            ? {
                ...s,
                loading: false,
                error: j.error ?? `HTTP ${res.status}`,
              }
            : s,
        );
        return;
      }
      const data = (await res.json()) as RepoStats;
      setStats((s) =>
        s && s.repo === repo ? { ...s, data, loading: false } : s,
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setStats((s) =>
        s && s.repo === repo
          ? { ...s, loading: false, error: (e as Error).message }
          : s,
      );
    }
  }, []);

  // --- research ------------------------------------------------------------
  // Per-repo: keeps any prior `articles` visible while a forced
  // refresh is in flight (avoids a flicker on the ↻ click). TTL
  // (RESEARCH_TTL_MS) is enforced by the caller — this function
  // always hits the API.
  const fetchResearch = useCallback(
    async (repo: string, opts: { force?: boolean } = {}) => {
      researchAbortByRepoRef.current[repo]?.abort();
      const ac = new AbortController();
      researchAbortByRepoRef.current[repo] = ac;

      setResearchByRepo((prev) => {
        const cur = prev[repo];
        return {
          ...prev,
          [repo]: {
            summary: cur?.summary ?? null,
            articles: cur?.articles ?? [],
            updatedAt: cur?.updatedAt ?? null,
            fetchedAt: cur?.fetchedAt ?? 0,
            loading: !(cur && cur.articles.length > 0),
            refreshing: !!opts.force,
            error: null,
          },
        };
      });

      try {
        const url =
          `/api/repo-research?repo=${encodeURIComponent(repo)}` +
          (opts.force ? "&force=true" : "");
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          updateResearchForRepo(repo, {
            loading: false,
            refreshing: false,
            error: j.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        const data = (await res.json()) as {
          summary?: string | null;
          articles: ResearchArticle[];
          updated_at: string;
        };
        updateResearchForRepo(repo, {
          summary: data.summary ?? null,
          articles: data.articles ?? [],
          updatedAt: data.updated_at ?? null,
          fetchedAt: Date.now(),
          loading: false,
          refreshing: false,
          error: null,
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        updateResearchForRepo(repo, {
          loading: false,
          refreshing: false,
          error: (e as Error).message,
        });
      }
    },
    [updateResearchForRepo],
  );

  // ----- selectedRepo room transition + cache-aware fetches -----
  //
  // When switching repos:
  //   * Stats are not persisted, so always refetch (cheap, no TTL).
  //   * Research is cached for RESEARCH_TTL_MS — only fetch on
  //     cache miss / staleness.
  //   * Messages are NEVER cleared on switch — the per-repo map
  //     preserves them. Only an explicit "Clear chat" wipes them.
  //
  // The 400ms `roomTransition` overlay is preserved as a visual
  // affordance ("Entering #{repo} room…") — it's a small cost for a
  // significant UX improvement on slower networks.
  useEffect(() => {
    if (!selectedRepo) {
      setStats(null);
      return;
    }
    // Don't abort: in-flight streams continue writing into the
    // captured-repo bucket. Only the visible "I'm streaming RIGHT
    // NOW into the visible repo" indicator is room-local — which
    // we reset by NOT touching isStreaming here. The correctness
    // contract is: messagesByRepo[oldRepo] keeps growing until the
    // stream finishes, then user can switch back to see it.
    setRoomTransition(true);
    setGlobalError(null);
    const t = setTimeout(() => {
      setRoomTransition(false);

      // Stats: always.
      void fetchStats(selectedRepo);

      // Research: cache check.
      const r = researchByRepo[selectedRepo];
      const researchFresh =
        r &&
        !r.error &&
        r.articles.length > 0 &&
        Date.now() - r.fetchedAt < RESEARCH_TTL_MS;
      if (!researchFresh && !(r && (r.loading || r.refreshing))) {
        void fetchResearch(selectedRepo);
      }
    }, 400);
    return () => clearTimeout(t);
    // researchByRepo intentionally NOT in deps: we only want the cache
    // check on explicit selectedRepo change, not on every cache write
    // (which would fire infinitely).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo, fetchStats, fetchResearch]);

  // --- send / report ------------------------------------------------------

  // Per-repo append. The repo argument is captured at stream-start
  // and never read from the latest selectedRepo, so a tab switch
  // mid-stream still lands the chunks in the right room's history.
  const appendToAssistantInRepo = useCallback(
    (repo: string, id: string, chunk: string) => {
      setMessagesForRepo(repo, (prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, content: m.content + chunk } : m,
        ),
      );
    },
    [setMessagesForRepo],
  );

  // The repo to write to is captured at the call site and threaded
  // through so a stream that started in repo A still lands in
  // messagesByRepo[A] even if the user has since switched to repo B.
  // The visible message bubble in repo B won't update, but as soon as
  // the user switches back the full history is intact.
  const send = useCallback(
    async (rawPrompt: string) => {
      const prompt = rawPrompt.trim();
      const repo = selectedRepo;
      if (!prompt || isStreaming || !repo) return;

      const now = Date.now();
      const userMsgId = crypto.randomUUID();
      const asstId = crypto.randomUUID();
      const userMsg: ChatMessage = {
        id: userMsgId,
        role: "user",
        content: prompt,
        ts: now,
      };
      const placeholder: ChatMessage = {
        id: asstId,
        role: "assistant",
        content: "",
        ts: now,
        retryPrompt: prompt,
      };
      const currentMessages = messagesByRepo[repo] ?? [];
      const history = currentMessages
        .slice(-10)
        .filter((m) => m.kind !== "report")
        .map((m) => ({ role: m.role, content: m.content }));
      setMessagesForRepo(repo, (prev) => [...prev, userMsg, placeholder]);
      setInput("");
      setIsStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;
      // Helper: mark this assistant message as interrupted so the
      // bubble can render a retry button. Called from any catch path.
      function flagInterrupted(reason: string) {
        setMessagesForRepo(repo, (prev) =>
          prev.map((m) =>
            m.id === asstId
              ? { ...m, streamError: reason }
              : m,
          ),
        );
      }
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: prompt,
            repo,
            history,
          }),
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          let detail = `HTTP ${res.status}`;
          try {
            const j = (await res.json()) as { error?: string };
            if (j.error) detail = j.error;
          } catch {
            // non-json
          }
          flagInterrupted(detail);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const payload = frame.startsWith("data: ")
              ? frame.slice(6)
              : frame;
            if (!payload) continue;
            if (payload === "[DONE]") {
              reader.cancel();
              return;
            }
            // Text frames are JSON-encoded ({ "t": "..." }) so embedded
            // newlines survive the SSE transport intact. Errors arrive
            // as { "error": "..." }. Anything else is treated as legacy
            // plain text for backward compatibility.
            if (payload.startsWith("{")) {
              try {
                const parsed = JSON.parse(payload) as {
                  t?: string;
                  error?: string;
                };
                if (parsed.error) {
                  flagInterrupted(parsed.error);
                  continue;
                }
                if (typeof parsed.t === "string") {
                  appendToAssistantInRepo(repo, asstId, parsed.t);
                  continue;
                }
              } catch {
                // fall through and treat as plain text
              }
            }
            appendToAssistantInRepo(repo, asstId, payload);
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        flagInterrupted((e as Error).message || "Network error.");
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [
      appendToAssistantInRepo,
      isStreaming,
      messagesByRepo,
      selectedRepo,
      setMessagesForRepo,
    ],
  );

  const generateReport = useCallback(async () => {
    const repo = selectedRepo;
    if (isStreaming || !repo) return;
    const now = Date.now();
    const reportId = crypto.randomUUID();
    const placeholder: ChatMessage = {
      id: reportId,
      role: "assistant",
      content: "",
      ts: now,
      kind: "report",
    };
    setMessagesForRepo(repo, (prev) => [...prev, placeholder]);
    setIsStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    function flagReportError(detail: string) {
      setMessagesForRepo(repo, (prev) =>
        prev.map((m) =>
          m.id === reportId ? { ...m, streamError: detail } : m,
        ),
      );
    }
    try {
      // Reports are a single non-streaming JSON call now: the full
      // markdown comes back intact (no SSE newline corruption) and we
      // render a compact download card rather than a live preview.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isReport: true,
          repo,
        }),
        signal: ac.signal,
      });
      const j = (await res.json().catch(() => ({}))) as {
        markdown?: string;
        error?: string;
      };
      if (!res.ok) {
        flagReportError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      const markdown = (j.markdown ?? "").trim();
      if (!markdown) {
        flagReportError("The model returned an empty report.");
        return;
      }
      setMessagesForRepo(repo, (prev) =>
        prev.map((m) => (m.id === reportId ? { ...m, content: markdown } : m)),
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      flagReportError((e as Error).message || "Network error.");
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [isStreaming, selectedRepo, setMessagesForRepo]);

  // Replays an interrupted stream by deleting the failed assistant
  // message and re-issuing send() with the same prompt.
  const retryAssistantMessage = useCallback(
    (msg: ChatMessage) => {
      if (!msg.retryPrompt) return;
      const repo = selectedRepo;
      // Drop the failed bubble from this repo's history before
      // re-sending so the user doesn't see two interleaved attempts.
      setMessagesForRepo(repo, (prev) =>
        prev.filter((m) => m.id !== msg.id),
      );
      void send(msg.retryPrompt);
    },
    [selectedRepo, send, setMessagesForRepo],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  // Confirmation-gated. The actual wipe runs from the confirm modal,
  // not directly from the header button.
  function clearChat() {
    abortRef.current?.abort();
    if (selectedRepo) {
      setMessagesForRepo(selectedRepo, () => []);
    }
    setClearConfirmOpen(false);
  }

  // --- render: loading ----------------------------------------------------
  if (loading) {
    return (
      <div className="relative">
        <GridBackdrop tone="cool" />
        <Container className="relative py-10">
          <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
        </Container>
      </div>
    );
  }

  const hasRepo = !!selectedRepo;

  // --- render: main 3-col layout ------------------------------------------
  return (
    <div className="relative">
      <GridBackdrop tone="cool" />
      <Container size="wide" className="relative py-6">
      <div className="flex flex-col gap-4 md:flex-row md:gap-4 md:h-[calc(100vh-7rem)] md:min-h-[560px]">
        {/* === LEFT: repo dropdown + quick actions === */}
        <aside className="hidden w-full shrink-0 flex-col gap-4 overflow-y-auto pr-1 md:flex md:w-[220px]">
          <Card className="p-3" flush>
            <div className="flex items-center justify-between px-1 pb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="text-muted/50">
                  ☰ ✕
                </span>
                Active room
              </span>
              <kbd
                className="rounded-sm border border-border bg-bg-elev px-1 text-[9px] uppercase tracking-[0.14em] text-muted"
                aria-hidden
              >
                ⌘K
              </kbd>
            </div>
            <RepoDropdown
              repos={repos}
              value={selectedRepo}
              onChange={(r) => {
                setSelectedRepo(r);
                setRepoDropdownOpen(false);
              }}
              disabled={isStreaming}
              installUrl={installStatus.installUrl}
              onInstallClick={() => setShowInstallModal(true)}
              open={repoDropdownOpen}
              onOpenChange={setRepoDropdownOpen}
              devpodLive={devpodLive}
              lastReviewByRepo={lastReviewByRepo}
            />
            {hasRepo && (
              <div className="mt-2 flex items-center gap-2 rounded-sm border border-border bg-bg-elev px-2 py-1.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={repoAvatarUrl(selectedRepo)}
                  alt=""
                  className="h-5 w-5 shrink-0 rounded-full border border-border bg-card"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text">
                  {selectedRepo}
                </span>
                <span className="flex shrink-0 items-center gap-1 font-mono text-[8.5px] uppercase tracking-[0.14em] text-muted">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-[#4ade80]"
                    aria-hidden
                  />
                  Watching
                </span>
              </div>
            )}
          </Card>

          <ProjectStructureCard
            tree={tree}
            repo={selectedRepo}
            hasRepo={hasRepo}
            open={treePanelOpen}
            onToggle={() => setTreePanelOpen((v) => !v)}
          />

          <Card className="p-3" flush>
            <div className="flex items-center gap-1.5 px-1 pb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
              <span aria-hidden className="text-muted/50">
                ☰ ✕
              </span>
              Quick actions
            </div>
            <QuickActionGrid
              hasRepo={hasRepo}
              isStreaming={isStreaming}
              devpodLive={devpodLive}
              onAction={(a) => {
                if (a.action === "report") void generateReport();
                else void send(a.prompt);
              }}
              compact
            />
          </Card>

          {githubUsername && <DevPodPanel githubUsername={githubUsername} />}
        </aside>

        {/* === MIDDLE: chat pane === */}
        <section className="min-w-0 flex-1">
          <Card flush className="flex h-full flex-col overflow-hidden">
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                {hasRepo && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={repoAvatarUrl(selectedRepo)}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded-full border border-border bg-card"
                  />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate text-sm font-semibold">
                    {hasRepo
                      ? selectedRepo.split("/")[1] ?? selectedRepo
                      : "Chat"}
                    {hasRepo && (
                      <a
                        href={`https://github.com/${selectedRepo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted hover:text-text"
                        title="Open on GitHub"
                        aria-label="Open repository on GitHub"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="11"
                          height="11"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden
                        >
                          <path d="M9 2h5v5h-1V3.7L7.7 9 7 8.3 12.3 3H9V2z" />
                          <path d="M3 4h4v1H4v7h7V9h1v4H3V4z" />
                        </svg>
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-2 truncate text-[11px] font-mono text-muted">
                    {hasRepo ? selectedRepo : "no repository selected"}
                    {hasRepo && (
                      <span
                        title={
                          devpodLive
                            ? "DevPod connected"
                            : "DevPod not connected"
                        }
                        className="flex items-center gap-1"
                      >
                        <span
                          className={
                            "inline-block h-1.5 w-1.5 rounded-full " +
                            (devpodLive ? "bg-[#4ade80]" : "bg-border")
                          }
                          aria-hidden
                        />
                        <span className="text-[10px] uppercase tracking-[0.14em]">
                          DevPod
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={generateReport}
                  disabled={!hasRepo || isStreaming}
                  title="Generate health report"
                >
                  Generate report
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => setClearConfirmOpen(true)}
                  disabled={messages.length === 0 && !isStreaming}
                >
                  Clear
                </Button>
              </div>
            </header>

            <div
              ref={scrollRef}
              className="flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5"
            >
              {/* Mobile-only repo picker — sidebar is hidden < md. */}
              <div className="md:hidden mb-2">
                <RepoDropdown
                  repos={repos}
                  value={selectedRepo}
                  onChange={setSelectedRepo}
                  disabled={isStreaming}
                  installUrl={installStatus.installUrl}
                  onInstallClick={() => setShowInstallModal(true)}
                  open={repoDropdownOpen}
                  onOpenChange={setRepoDropdownOpen}
                  devpodLive={devpodLive}
                  lastReviewByRepo={lastReviewByRepo}
                />
              </div>

              {globalError && (
                <div className="rounded-sm border border-[#ff9d4d]/40 bg-[#ff9d4d]/10 px-3 py-2 text-xs text-[#ff9d4d]">
                  {globalError}
                </div>
              )}

              {!hasRepo && (
                <NoRoomState
                  repoCount={repos.length}
                  installLoaded={installStatus.loaded}
                  healthy={installStatus.healthy}
                  stale={installStatus.stale}
                  onInstall={() => setShowInstallModal(true)}
                />
              )}

              {hasRepo && roomTransition && (
                <div className="py-6 text-center text-xs italic text-muted">
                  Entering #{selectedRepo.split("/")[1] ?? selectedRepo}{" "}
                  room…
                </div>
              )}

              {hasRepo &&
                !roomTransition &&
                activePrNumber !== null && (
                  <SandboxTestCard
                    repo={selectedRepo}
                    prNumber={activePrNumber}
                  />
                )}

              {hasRepo &&
                !roomTransition &&
                messages.length === 0 && (
                  <EmptyRoomQuickStart repo={selectedRepo} />
                )}

              {messages.map((m, idx) => {
                const isLast = idx === messages.length - 1;
                if (m.kind === "report") {
                  return (
                    <ReportCard
                      key={m.id}
                      message={m}
                      repo={selectedRepo}
                      isStreaming={isStreaming && isLast}
                    />
                  );
                }
                return (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    isStreaming={isStreaming && isLast}
                    onRetry={() => retryAssistantMessage(m)}
                    userAvatarUrl={userAvatarUrl}
                    userLabel={githubUsername ?? "You"}
                  />
                );
              })}
            </div>

            <ChatComposer
              hasRepo={hasRepo}
              repo={selectedRepo}
              isStreaming={isStreaming}
              input={input}
              onChange={setInput}
              onSubmit={() => void send(input)}
              onKeyDown={handleKeyDown}
            />
          </Card>
        </section>

        {/* === RIGHT: stats + research === */}
        <aside className="hidden w-full shrink-0 flex-col gap-4 overflow-y-auto pl-1 md:flex md:w-[280px]">
          <CollapsibleCard
            title="Repository"
            open={repoPanelOpen ?? false}
            onToggle={() => setRepoPanelOpen((v) => !v)}
          >
            {hasRepo ? (
              <RepoStatsPanel stats={stats} />
            ) : (
              <EmptyPanelHint text="Select a repository to see stats." />
            )}
          </CollapsibleCard>

          <CollapsibleCard
            title="Research"
            open={researchPanelOpen ?? false}
            onToggle={() => setResearchPanelOpen((v) => !v)}
            headerExtra={
              hasRepo && research && !research.loading ? (
                <button
                  type="button"
                  onClick={() =>
                    void fetchResearch(selectedRepo, { force: true })
                  }
                  disabled={research.refreshing}
                  className="rounded-sm border border-border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em] text-muted hover:text-text disabled:opacity-40"
                  title="Force refresh"
                >
                  {research.refreshing ? "…" : "↻"}
                </button>
              ) : null
            }
          >
            {hasRepo ? (
              <ResearchPanel research={research} />
            ) : (
              <EmptyPanelHint text="Select a repository to see suggested reading." />
            )}
          </CollapsibleCard>
        </aside>
      </div>

      {showInstallModal && (
        <InstallAppModal
          installUrl={installStatus.installUrl}
          installError={installError}
          onClose={() => setShowInstallModal(false)}
        />
      )}

      {clearConfirmOpen && hasRepo && (
        <ConfirmModal
          title="Clear conversation"
          body={
            <>
              Clear conversation for{" "}
              <code className="font-mono text-text">{selectedRepo}</code>? This
              cannot be undone.
            </>
          }
          confirmLabel="Clear chat"
          onCancel={() => setClearConfirmOpen(false)}
          onConfirm={clearChat}
        />
      )}

      {/* Markup that lands inside dangerouslySetInnerHTML can't be
          touched by Tailwind classes or styled-jsx component scopes.
          The pieces below are global by necessity:
            * .stream-caret — appended by appendCaret() to streaming
              assistant content.
            * .md-table     — rendered by renderMarkdown for pipe
              tables (existing globals.css covers the .md-* heading
              / list / code rules; tables and ordered lists are new
              this commit and live here so we don't churn the global
              stylesheet for a single page's surface). */}
      <style jsx global>{`
        @keyframes lyncas-caret-blink {
          50% {
            opacity: 0;
          }
        }
        .stream-caret {
          display: inline-block;
          margin-left: 2px;
          color: currentColor;
          opacity: 0.7;
          animation: lyncas-caret-blink 1s steps(2, end) infinite;
          vertical-align: baseline;
        }
        /* ----- Chat bubble markdown overrides ------------------------ */
        /* The bubbles set .font-mono so the cumulative inherited font   */
        /* is IBM Plex Mono. We also tighten a few of the .md-content    */
        /* defaults from globals.css because mono at 13px reads dense    */
        /* and the legacy 1.5 line-height + 0.35rem paragraph margins    */
        /* opened up too much vertical space between bullets and prose.  */
        .md-content {
          line-height: 1.55;
        }
        .md-content p {
          margin: 0 0 0.25rem 0;
        }
        .md-content p:last-child {
          margin-bottom: 0;
        }
        .md-content .md-list {
          margin: 0.15rem 0;
          padding-left: 1.1rem;
        }
        .md-content .md-list li {
          margin: 0.02rem 0;
          line-height: 1.4;
        }
        /* Adjacent lists (e.g. when a fence interrupts the flow) sit  */
        /* flush rather than each one inheriting the paragraph margin. */
        .md-content .md-list + .md-list {
          margin-top: 0;
        }
        .md-content .md-h1,
        .md-content .md-h2,
        .md-content .md-h3,
        .md-content .md-h4 {
          margin-top: 0.7rem;
          margin-bottom: 0.3rem;
          font-weight: 700;
          line-height: 1.3;
        }
        .md-content .md-h1:first-child,
        .md-content .md-h2:first-child,
        .md-content .md-h3:first-child,
        .md-content .md-h4:first-child {
          margin-top: 0;
        }
        /* Keep headings only marginally larger than body text — a chat
           bubble shouldn't shout a 2em <h1>. */
        .md-content .md-h1 {
          font-size: 1.14em;
        }
        .md-content .md-h2 {
          font-size: 1.02em;
        }
        .md-content .md-h3 {
          font-size: 0.95em;
        }
        .md-content .md-h4 {
          font-size: 0.85em;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          opacity: 0.8;
        }
        .md-content .md-hr {
          border: 0;
          border-top: 1px solid var(--color-border);
          margin: 0.7rem 0;
        }
        .md-content .md-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.9em;
          margin: 0.4rem 0;
        }
        .md-content .md-table th,
        .md-content .md-table td {
          border: 1px solid var(--color-border);
          padding: 0.3rem 0.5rem;
          text-align: left;
        }
        .md-content .md-table thead {
          background: rgba(255, 255, 255, 0.04);
          color: var(--color-text);
        }
        .md-content .md-list-ordered {
          list-style: decimal;
        }
        .report-content .md-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.9em;
          margin: 0.5rem 0;
        }
        .report-content .md-table th,
        .report-content .md-table td {
          border: 1px solid rgba(0, 0, 0, 0.12);
          padding: 0.4rem 0.6rem;
          text-align: left;
        }
        .report-content .md-table thead {
          background: rgba(0, 0, 0, 0.04);
        }
      `}</style>
      </Container>
    </div>
  );
}

// =========================================================================
// Repo dropdown — left-sidebar picker (also reused on mobile).
// =========================================================================

// Searchable repo picker.
//
// Controlled `open` so a global Cmd+K can pop it open from anywhere
// on the page (the parent owns the open state).
//
// Each row shows: 32px owner avatar · repo name · owner · last
// review date · DevPod dot. The DevPod dot is a single boolean for
// the *current user* — we don't track per-repo DevPod sessions
// (DevPod sessions belong to a user, not a repo, so the dot is
// shown next to whichever repo the user has selected to imply
// "this is the room your DevPod will execute against").
//
// Search is purely client-side over the watched_repos list (which is
// already a small, in-memory array). Matches against full repo path
// case-insensitively.
function RepoDropdown({
  repos,
  value,
  onChange,
  disabled,
  installUrl,
  onInstallClick,
  open,
  onOpenChange,
  devpodLive = false,
  lastReviewByRepo = {},
}: {
  repos: WatchedRepoLite[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  installUrl: string | null;
  onInstallClick: () => void;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  devpodLive?: boolean;
  lastReviewByRepo?: LastReviewLookup;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Tracks the prior `open` value so we can reset query/activeIdx
  // ONLY on the open->closed->open transition, not on every render.
  // Resetting via useState initializer + key-rotation would be
  // cleaner but would also remount the search input on every Cmd+K,
  // losing focus mid-keystroke. Tracking via ref keeps focus stable.
  const wasOpenRef = useRef(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  // Auto-focus search on open. We don't reset query in the effect —
  // doing so triggers the React 19 set-state-in-effect rule. Instead,
  // when the dropdown is closed externally and reopened, the parent
  // owns the lifecycle: the controlled state already snaps back to
  // false, then to true; we only auto-focus the input on the
  // transition, leaving the existing query alone (which is what the
  // user expects on Cmd+K → close → Cmd+K).
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      // Defer to next tick so the input has been rendered.
      const t = window.setTimeout(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      }, 0);
      return () => window.clearTimeout(t);
    }
    if (!open) {
      wasOpenRef.current = false;
    }
  }, [open]);

  // Close on outside click / Escape — only while open. The Escape
  // handler is also tied to query: pressing Escape with a non-empty
  // query clears it before closing, which is the convention for
  // every other "search inside dropdown" UI.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) onOpenChange(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (query) {
          setQuery("");
        } else {
          onOpenChange(false);
        }
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, query, onOpenChange]);

  const empty = repos.length === 0;
  function shortName(full: string): string {
    const slash = full.lastIndexOf("/");
    return slash >= 0 ? full.slice(slash + 1) : full;
  }

  const filtered = useMemo(() => {
    if (!query.trim()) return repos;
    const q = query.trim().toLowerCase();
    return repos.filter((r) => r.repo.toLowerCase().includes(q));
  }, [repos, query]);

  function commit(repo: string) {
    onChange(repo);
    onOpenChange(false);
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[activeIdx];
      if (target) commit(target.repo);
    }
  }

  const label = value
    ? shortName(value)
    : empty
      ? "No repos connected"
      : "Select a repo";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && !empty && onOpenChange(!open)}
        disabled={disabled || empty}
        className="flex w-full items-center gap-2 rounded-sm border border-border bg-bg px-2.5 py-2 text-left text-xs transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
        title={label}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={repoAvatarUrl(value)}
            alt=""
            className="h-5 w-5 shrink-0 rounded-full border border-border bg-card"
          />
        ) : (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[10px] text-muted"
            aria-hidden
          >
            ?
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
        {value && devpodLive && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#4ade80]"
            title="DevPod connected"
            aria-label="DevPod connected"
          />
        )}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="currentColor"
          className={
            "shrink-0 text-muted transition-transform " +
            (open ? "rotate-180" : "")
          }
        >
          <path d="M3 6l5 5 5-5H3z" />
        </svg>
      </button>

      {empty && (
        <div className="mt-2 space-y-1 text-[11px] text-muted">
          <p>No repositories connected.</p>
          {installUrl ? (
            <button
              type="button"
              onClick={onInstallClick}
              className="inline-flex items-center gap-1 text-text underline underline-offset-2"
            >
              Install GitHub App →
            </button>
          ) : null}
        </div>
      )}

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-sm border border-border bg-bg shadow-lg"
        >
          <div className="border-b border-border bg-bg-elev p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(0);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search repositories…"
              className="w-full rounded-sm border border-border bg-bg px-2 py-1.5 text-xs focus:border-white focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2.5 py-3 text-center text-[11px] text-muted">
                No repositories match
                <span className="font-mono"> &ldquo;{query}&rdquo;</span>
              </div>
            ) : (
              filtered.map((r, idx) => {
                const active = r.repo === value;
                const isHighlight = idx === activeIdx;
                const owner = repoOwner(r.repo);
                const name = shortName(r.repo);
                const lastReview = lastReviewByRepo[r.repo] ?? null;
                return (
                  <button
                    key={r.repo}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => commit(r.repo)}
                    className={
                      "flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-xs transition-colors " +
                      (isHighlight
                        ? "bg-bg-elev text-text"
                        : active
                          ? "bg-bg-elev/60 text-text"
                          : "text-muted hover:bg-bg-elev hover:text-text")
                    }
                    title={r.repo}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`https://github.com/${owner}.png?size=32`}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded-full border border-border bg-card"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-text">
                          {name}
                        </span>
                        {active && devpodLive && (
                          <span
                            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#4ade80]"
                            title="DevPod connected"
                            aria-hidden
                          />
                        )}
                      </div>
                      <div className="truncate text-[10px] font-mono text-muted">
                        {owner}
                        {lastReview ? (
                          <span> · last review {formatAgo(lastReview)}</span>
                        ) : null}
                      </div>
                    </div>
                    {active && (
                      <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-muted">
                        active
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
          {installUrl && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onInstallClick();
              }}
              className="block w-full border-t border-border px-2.5 py-2 text-left text-xs text-muted hover:bg-bg-elev hover:text-text"
            >
              + Connect more repos
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// Project structure card — left sidebar, above Quick actions.
// Reads repo_rules.repo_directory_tree (anon-select per migration 009).
// =========================================================================

// Project-structure tree icons. Monochrome, currentColor-driven so the
// row controls tone (muted at rest, brighter on hover / when a folder is
// open) — a calm, professional file explorer rather than a color grid.

// Open vs. closed folder — the open variant signals an expanded folder
// the way a desktop file explorer does, so we don't need a chevron.
function TreeFolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {open ? (
        <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6A2 2 0 0 1 18.45 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      )}
    </svg>
  );
}

function TreeFileIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function ArrowOutIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M9 2h5v5h-1V3.7L7.7 9 7 8.3 12.3 3H9V2z" />
      <path d="M3 4h4v1H4v7h7V9h1v4H3V4z" />
    </svg>
  );
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

// Build a nested tree from the flat { path, dir } list the API returns.
// Intermediate directories are created on demand so the structure is
// correct even if GitHub omits a parent entry.
function buildTree(entries: TreeApiEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  const dirMap = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = dirMap.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parent = ensureDir(parentPath);
    const node: TreeNode = { name, path, isDir: true, children: [] };
    parent.children.push(node);
    dirMap.set(path, node);
    return node;
  };

  for (const e of entries) {
    if (e.dir) {
      ensureDir(e.path);
      continue;
    }
    const slash = e.path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : e.path.slice(0, slash);
    const name = slash === -1 ? e.path : e.path.slice(slash + 1);
    ensureDir(parentPath).children.push({
      name,
      path: e.path,
      isDir: false,
      children: [],
    });
  }

  const sortRec = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

// Vertical indent guides — one faint rail per ancestor level, stretched
// to the row's full height so consecutive rows read as continuous lines
// (the VS Code / Finder "tree guide" affordance from the reference).
function IndentGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          className="w-[16px] shrink-0 self-stretch border-l border-border"
          aria-hidden
        />
      ))}
    </>
  );
}

// One row in the explorer. Folders toggle their children in place (open
// vs. closed folder icon signals state — no chevron); files and the
// on-hover icon link out to GitHub.
function TreeNodeRow({
  node,
  depth,
  expanded,
  onToggleDir,
  repo,
  branch,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  repo: string;
  branch: string;
}) {
  const isOpen = node.isDir && expanded.has(node.path);
  const ghUrl = `https://github.com/${repo}/${
    node.isDir ? "tree" : "blob"
  }/${branch}/${node.path}`;

  if (!node.isDir) {
    return (
      <a
        href={ghUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="group/row flex items-stretch pl-1"
        title={`Open ${node.path} on GitHub`}
      >
        <IndentGuides depth={depth} />
        <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-[5px] text-muted transition-colors group-hover/row:bg-bg-elev group-hover/row:text-text">
          <span className="shrink-0 text-muted/80 transition-colors group-hover/row:text-text">
            <TreeFileIcon />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text/85 transition-colors group-hover/row:text-text">
            {node.name}
          </span>
          <span className="shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100">
            <ArrowOutIcon />
          </span>
        </span>
      </a>
    );
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onToggleDir(node.path)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleDir(node.path);
          }
        }}
        className="group/row flex cursor-pointer items-stretch pl-1"
        title={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
      >
        <IndentGuides depth={depth} />
        <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-[5px] transition-colors group-hover/row:bg-bg-elev">
          <span
            className={
              "shrink-0 transition-colors " +
              (isOpen ? "text-text" : "text-muted/90 group-hover/row:text-text")
            }
          >
            <TreeFolderIcon open={isOpen} />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-text/90">
            {node.name}
          </span>
          <a
            href={ghUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`Open ${node.path} on GitHub`}
            className="shrink-0 text-muted opacity-0 transition-opacity hover:text-text group-hover/row:opacity-100"
          >
            <ArrowOutIcon />
          </a>
        </span>
      </div>
      {isOpen &&
        node.children.map((child) => (
          <TreeNodeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggleDir={onToggleDir}
            repo={repo}
            branch={branch}
          />
        ))}
    </>
  );
}

function ProjectStructureCard({
  tree,
  repo,
  hasRepo,
  open,
  onToggle,
}: {
  tree: DirectoryTreeState | null;
  repo: string;
  hasRepo: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const empty = !hasRepo;
  const ready = !!(
    tree &&
    !tree.loading &&
    tree.entries &&
    tree.entries.length > 0
  );

  const apiEntries = tree?.entries ?? null;
  const nodes = useMemo(
    () => (ready && apiEntries ? buildTree(apiEntries) : []),
    [ready, apiEntries],
  );
  const folderCount = useMemo(
    () => (apiEntries ?? []).filter((e) => e.dir).length,
    [apiEntries],
  );
  const fileCount = (apiEntries?.length ?? 0) - folderCount;
  const branch = tree?.defaultBranch ?? "HEAD";

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Reset expansion whenever we switch repos so we never carry one
  // repo's open folders into another's tree.
  useEffect(() => {
    setExpanded(new Set());
  }, [repo]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return (
    <Card flush>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left transition-colors hover:bg-bg-elev"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="currentColor"
            className={
              "transition-transform " + (open ? "rotate-90" : "rotate-0")
            }
          >
            <path d="M5 3l6 5-6 5V3z" />
          </svg>
          Project structure
        </span>
        {ready && (
          <span className="flex items-center gap-1.5 font-mono text-[9px] text-muted">
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-[1px] bg-text/70"
                aria-hidden
              />
              {folderCount}
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-[1px] bg-muted"
                aria-hidden
              />
              {fileCount}
            </span>
          </span>
        )}
      </button>
      {open && (
        <div className="p-2">
          {empty ? (
            <p className="px-1 py-2 text-[11px] text-muted">
              Select a repository to see its tree.
            </p>
          ) : tree?.loading ? (
            <div className="animate-pulse space-y-1.5 px-1 py-1">
              <div className="h-2 w-3/4 rounded bg-border/50" />
              <div className="h-2 w-2/3 rounded bg-border/50" />
              <div className="h-2 w-5/6 rounded bg-border/50" />
              <div className="h-2 w-1/2 rounded bg-border/50" />
            </div>
          ) : ready ? (
            <div className="space-y-1.5">
              <div className="px-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
                  {repo.split("/")[1] ?? repo}
                </span>
              </div>
              <div className="max-h-[420px] overflow-auto pr-0.5">
                {nodes.map((node) => (
                  <TreeNodeRow
                    key={node.path}
                    node={node}
                    depth={0}
                    expanded={expanded}
                    onToggleDir={toggleDir}
                    repo={repo}
                    branch={branch}
                  />
                ))}
              </div>
              {tree?.truncated && (
                <p className="px-1 pt-1 text-[9.5px] leading-relaxed text-muted">
                  Large repo — showing a partial tree. Open on GitHub for
                  the full structure.
                </p>
              )}
            </div>
          ) : (
            <p className="px-1 py-2 text-[11px] text-muted">
              Couldn&apos;t load the tree for this repo. It may be empty or
              access may be restricted.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// =========================================================================
// Empty room state — shown in the middle pane when no repo is selected.
// Doesn't include a picker any more (the user picks from the sidebar).
// =========================================================================

function NoRoomState({
  repoCount,
  installLoaded,
  healthy,
  stale,
  onInstall,
}: {
  repoCount: number;
  installLoaded: boolean;
  healthy: number;
  stale: number;
  onInstall: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-8 py-12 text-center sm:py-16">
      <div className="space-y-3">
        <div className="flex justify-center text-text">
          <LyncasGlyph size={34} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Lyncas
        </h1>
        <p className="text-xs text-muted sm:text-sm">
          Your autonomous code review agent
        </p>
      </div>

      {repoCount === 0 ? (
        <div className="space-y-2">
          <div className="text-sm font-semibold">
            No repositories connected
          </div>
          <p className="max-w-sm text-xs text-muted">
            Install the Lyncas GitHub App and pick the repos you
            want reviewed. We&apos;ll bring you back here automatically.
          </p>
          <button
            type="button"
            onClick={onInstall}
            className="mt-1 inline-flex items-center gap-2 rounded-sm bg-white px-4 py-2 font-mono text-xs uppercase tracking-[0.14em] text-black hover:bg-white/90"
          >
            Connect a repo →
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-sm font-semibold">
            Select a repository to start
          </div>
          <p className="text-xs text-muted">
            Pick a room from the dropdown in the sidebar (or press
            <kbd className="mx-1 rounded-sm border border-border bg-bg-elev px-1 font-mono text-[10px] tracking-wide">⌘K</kbd>
            ).
          </p>
          {installLoaded && healthy === 0 && stale > 0 && (
            <button
              type="button"
              onClick={onInstall}
              className="mt-1 inline-flex items-center gap-1.5 rounded-sm border border-[#ff9d4d]/40 bg-[#ff9d4d]/10 px-3 py-1 text-[11px] font-mono text-[#ff9d4d]"
            >
              GitHub App not detected — reinstall →
            </button>
          )}
        </div>
      )}

      {/* Three product-pillar cards. Pure marketing copy — they
          don't link anywhere because the relevant CTA (install /
          select a repo) is right above. */}
      <div className="grid w-full max-w-2xl grid-cols-1 gap-3 px-2 sm:grid-cols-3 sm:px-0">
        <FeatureCard
          icon={
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
              <path d="M9 1.5L3.5 9H7.5l-1 5.5L12.5 7H8.5z" />
            </svg>
          }
          title="Instant reviews"
          body="Reviews land in ~30 seconds of opening a pull request."
        />
        <FeatureCard
          icon={
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
              <circle cx="4" cy="4" r="1.6" />
              <circle cx="12" cy="4" r="1.6" />
              <circle cx="8" cy="12" r="1.6" />
              <path d="M5.4 4.6L7 10.6M10.6 4.6L9 10.6M5.5 4h5" />
            </svg>
          }
          title="AI-powered"
          body="A 4-node LangGraph pipeline cross-checks every verdict."
        />
        <FeatureCard
          icon={<ActionIcon name="tests" />}
          title="Sandbox testing"
          body="Live preview URLs and real test runs from your DevPod."
        />
      </div>
    </div>
  );
}

// Brand starburst glyph (mirrors components/ui/brand.tsx) — used in
// place of the old moon emoji for the agent avatar and empty-state hero.
function LyncasGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <g
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={0.5}
        strokeLinejoin="round"
      >
        <polygon points="12,1 13.3,9 12,12 10.7,9" />
        <polygon points="12,23 13.3,15 12,12 10.7,15" />
        <polygon points="1,12 9,10.7 12,12 9,13.3" />
        <polygon points="23,12 15,10.7 12,12 15,13.3" />
        <polygon points="4.2,4.2 10,9.2 12,12 9.2,10" />
        <polygon points="19.8,19.8 14,14.8 12,12 14.8,14" />
        <polygon points="4.2,19.8 9.2,14 12,12 10,14.8" />
        <polygon points="19.8,4.2 14.8,9.2 12,12 14,10" />
      </g>
    </svg>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-start gap-1.5 rounded-md border border-border bg-bg-elev p-3 text-left">
      <div
        className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-border bg-bg text-text"
        aria-hidden
      >
        {icon}
      </div>
      <div className="text-sm font-semibold">{title}</div>
      <p className="text-[11px] leading-relaxed text-muted">{body}</p>
    </div>
  );
}

// =========================================================================
// Install-app modal
// =========================================================================

function InstallAppModal({
  installUrl,
  installError,
  onClose,
}: {
  installUrl: string | null;
  installError: string | null;
  onClose: () => void;
}) {
  // Lock body scroll while the modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Copy is intentionally neutral. We don't reference the number of
  // repos in the user's stale watched_repos cache — that count
  // confused early testers ("why does it say 51 when I'm trying to
  // install fresh?"). The reconciliation step on the server takes
  // care of cleaning that up; the UI just needs to ask for a fresh
  // install.
  const title = installError
    ? "Couldn't finish installing"
    : "Connect GitHub to continue";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-md border border-border bg-bg shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2
              id="install-modal-title"
              className="text-base font-semibold leading-tight"
            >
              {title}
            </h2>
            <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.14em] text-muted">
              Lyncas for GitHub
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-text"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="space-y-4 px-5 py-5">
          {installError ? (
            <div className="rounded-sm border border-[#ff5252]/40 bg-[#ff5252]/10 px-3 py-2 text-xs text-[#ff5252]">
              {installError}
            </div>
          ) : null}

          <div className="space-y-2 text-sm leading-relaxed">
            <p>
              Install the Lyncas GitHub App to start reading
              your pull requests. If you&apos;ve installed it before but
              recently changed it on GitHub, re-install here to refresh
              the connection.
            </p>
            <p className="text-xs text-muted">
              GitHub will ask which repositories to grant access to — pick
              any subset you&apos;d like reviewed. You can adjust the
              selection any time.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            {installUrl ? (
              <a
                href={installUrl}
                className="inline-flex h-10 w-full items-center justify-center gap-2 bg-white font-mono text-sm uppercase tracking-[0.08em] text-black hover:bg-white/90"
              >
                <GitHubGlyph />
                Continue with GitHub
              </a>
            ) : (
              <div className="rounded-sm border border-[#ff5252]/40 bg-[#ff5252]/10 px-3 py-2 text-xs text-[#ff5252]">
                The GitHub App slug isn&apos;t configured on this deploy
                (set <code>NEXT_PUBLIC_GITHUB_APP_SLUG</code>). Ask your
                administrator to finish setup.
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted hover:text-text"
            >
              Manage on GitHub →
            </a>
            <button
              type="button"
              onClick={onClose}
              className="text-[11px] font-mono uppercase tracking-[0.14em] text-muted hover:text-text"
            >
              Maybe later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GitHubGlyph() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.65 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.17a11 11 0 0 1 5.78 0c2.21-1.48 3.18-1.17 3.18-1.17.62 1.59.23 2.77.11 3.06.73.8 1.18 1.82 1.18 3.07 0 4.39-2.69 5.36-5.25 5.64.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.55C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

// =========================================================================
// Collapsible card + stats / research panels
// =========================================================================

function CollapsibleCard({
  title,
  open,
  onToggle,
  headerExtra,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card flush>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left transition-colors hover:bg-bg-elev"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="currentColor"
            className={
              "transition-transform " + (open ? "rotate-90" : "rotate-0")
            }
          >
            <path d="M5 3l6 5-6 5V3z" />
          </svg>
          {title}
        </span>
        {headerExtra && (
          <span
            onClick={(e) => {
              e.stopPropagation();
            }}
            className="flex items-center gap-1"
          >
            {headerExtra}
          </span>
        )}
      </button>
      {open && <div className="p-3 text-xs">{children}</div>}
    </Card>
  );
}

function EmptyPanelHint({ text }: { text: string }) {
  return <div className="py-2 text-center text-[11px] text-muted">{text}</div>;
}

function RepoStatsPanel({ stats }: { stats: RepoStatsState | null }) {
  if (!stats || stats.loading) return <StatsSkeleton />;
  if (stats.error) {
    return (
      <div className="text-[11px] text-[#ff9d4d]">
        Could not fetch stats: {stats.error}
      </div>
    );
  }
  const d = stats.data;
  if (!d) return <StatsSkeleton />;

  const langs = Object.entries(d.languages ?? {});
  const langTotal = langs.reduce((acc, [, n]) => acc + n, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Stars" value={d.stars ?? "—"} />
        <StatTile label="Open PRs" value={d.open_prs ?? "—"} />
        <StatTile label="Updated" value={formatAgo(d.last_commit)} mono />
      </div>

      <div className="space-y-2">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Languages
        </div>
        {langs.length === 0 ? (
          <div className="text-[11px] text-muted">No language data</div>
        ) : (
          <>
            <div className="flex h-1.5 w-full overflow-hidden rounded-sm bg-border/40">
              {langs.map(([name, n]) => (
                <div
                  key={name}
                  style={{
                    width: `${(n / langTotal) * 100}%`,
                    backgroundColor: languageColor(name),
                  }}
                  title={`${name} ${((n / langTotal) * 100).toFixed(1)}%`}
                />
              ))}
            </div>
            <ul className="space-y-1">
              {langs.slice(0, 5).map(([name, n]) => (
                <li
                  key={name}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: languageColor(name) }}
                    />
                    <span className="truncate">{name}</span>
                  </span>
                  <span className="font-mono text-muted">
                    {((n / langTotal) * 100).toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Top contributors
        </div>
        {d.contributors.length === 0 ? (
          <div className="text-[11px] text-muted">No contributor data</div>
        ) : (
          <ul className="space-y-1.5">
            {d.contributors.map((c) => (
              <li
                key={c.login}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <a
                  href={`https://github.com/${c.login}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 min-w-0 hover:text-text"
                >
                  {c.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.avatar_url}
                      alt=""
                      className="h-4 w-4 rounded-full border border-border bg-card"
                    />
                  ) : (
                    <span className="h-4 w-4 rounded-full bg-border" />
                  )}
                  <span className="truncate font-mono">{c.login}</span>
                </a>
                <span className="font-mono text-muted">{c.contributions}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
}) {
  return (
    <div className="rounded-sm border border-border bg-bg-elev px-2 py-1.5">
      <div className="text-[9px] font-mono uppercase tracking-[0.14em] text-muted">
        {label}
      </div>
      <div className={"text-sm " + (mono ? "font-mono" : "font-semibold")}>
        {value}
      </div>
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <div className="h-10 rounded-sm bg-border/40" />
        <div className="h-10 rounded-sm bg-border/40" />
        <div className="h-10 rounded-sm bg-border/40" />
      </div>
      <div className="space-y-2">
        <div className="h-2 w-20 rounded bg-border/60" />
        <div className="h-1.5 w-full rounded bg-border/40" />
        <div className="space-y-1">
          <div className="h-2 w-3/4 rounded bg-border/40" />
          <div className="h-2 w-2/3 rounded bg-border/40" />
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-2 w-24 rounded bg-border/60" />
        <div className="h-3 w-full rounded bg-border/40" />
        <div className="h-3 w-full rounded bg-border/40" />
      </div>
    </div>
  );
}

function ResearchPanel({ research }: { research: ResearchState | null }) {
  if (!research || research.loading) return <ResearchSkeleton />;
  if (research.error) {
    return (
      <div className="text-[11px] text-[#ff9d4d]">
        Could not fetch articles: {research.error}
      </div>
    );
  }
  const summary = research.summary?.trim() ?? "";
  const hasArticles = research.articles.length > 0;
  if (!summary && !hasArticles) {
    return (
      <div className="text-[11px] text-muted">
        No suggestions yet. Try the refresh button above.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {summary && (
        <div className="space-y-1.5 rounded-sm border border-border bg-bg-elev p-2.5">
          <div className="text-[9px] font-mono uppercase tracking-[0.16em] text-muted">
            About this project
          </div>
          <p className="text-[11.5px] leading-relaxed text-text">{summary}</p>
        </div>
      )}
      {hasArticles && (
        <div className="text-[9px] font-mono uppercase tracking-[0.16em] text-muted">
          Suggested research
        </div>
      )}
      <ul className="space-y-2.5">
        {research.articles.map((a, idx) => {
          const favicon = faviconUrl(a.url);
          return (
            <li
              key={`${a.url}-${idx}`}
              className="space-y-1 rounded-sm border border-border bg-bg-elev p-2"
            >
              <div className="flex items-start gap-2">
                {favicon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={favicon}
                    alt=""
                    className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border border-border bg-card"
                  />
                ) : (
                  <span className="mt-0.5 h-4 w-4 shrink-0 rounded-sm bg-border" />
                )}
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[12px] font-medium leading-snug hover:underline"
                >
                  {a.title}
                </a>
              </div>
              <p className="text-[11px] leading-relaxed text-muted">
                {a.description}
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center rounded-sm border border-border bg-card px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.14em] text-muted">
                  {a.source}
                </span>
                <span className="font-mono text-[9px] text-muted">
                  {formatAgo(research.updatedAt)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ResearchSkeleton() {
  return (
    <ul className="animate-pulse space-y-2">
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          className="space-y-1.5 rounded-sm border border-border p-2"
        >
          <div className="flex items-start gap-2">
            <div className="h-4 w-4 rounded-sm bg-border/60" />
            <div className="h-2.5 w-3/4 rounded bg-border/60" />
          </div>
          <div className="h-2 w-full rounded bg-border/40" />
          <div className="h-2 w-2/3 rounded bg-border/40" />
        </li>
      ))}
    </ul>
  );
}

// =========================================================================
// Report card — download-first. The report is NOT rendered inline as a
// big preview; it's offered as a downloadable document (.docx / .md)
// with an optional collapsible preview for those who want a quick look.
// =========================================================================

function DocGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  );
}

function ReportCard({
  message,
  repo,
  isStreaming,
}: {
  message: ChatMessage;
  repo: string;
  isStreaming: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [docxBusy, setDocxBusy] = useState(false);
  const [docxError, setDocxError] = useState<string | null>(null);
  const pending = isStreaming && !message.content;
  const ready = !pending && !!message.content && !message.streamError;

  const today = new Date().toISOString().slice(0, 10);
  const safeRepo = repo.replace(/[^A-Za-z0-9._-]+/g, "-");

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  function downloadMd() {
    const blob = new Blob([message.content], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeRepo}-health-report-${today}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function downloadDocx() {
    if (docxBusy) return;
    setDocxBusy(true);
    setDocxError(null);
    try {
      await downloadMarkdownDocx(
        message.content,
        `${safeRepo}-health-report-${today}.docx`,
        `Repository Health Report — ${repo}`,
      );
    } catch (e) {
      setDocxError((e as Error).message || "Could not build .docx");
    } finally {
      setDocxBusy(false);
    }
  }

  if (message.streamError && !message.content) {
    return (
      <article className="rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3">
        <p className="text-[12px] font-mono text-red-300">
          Report failed. {message.streamError}
        </p>
      </article>
    );
  }

  return (
    <article className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${
            ready
              ? "border-accent/30 bg-accent/10 text-accent"
              : "border-border bg-bg text-muted"
          }`}
        >
          <DocGlyph />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
              Report
            </span>
            <span className="truncate text-[10px] font-mono text-muted/70">
              {repo} · {formatTime(message.ts)}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] font-medium text-text">
            {pending
              ? "Generating repository health report…"
              : "Repository health report is ready."}
          </p>
          {pending ? (
            <div className="mt-2 flex items-center gap-2 text-[11px] font-mono text-muted">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted/30 border-t-accent" />
              Crunching PRs, commits & review history…
            </div>
          ) : (
            <>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={downloadDocx}
                  disabled={!ready || docxBusy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-black transition hover:opacity-90 disabled:opacity-40"
                >
                  {docxBusy ? "Building .docx…" : "Download .docx"}
                </button>
                <button
                  type="button"
                  onClick={downloadMd}
                  disabled={!ready}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg px-3 py-1.5 text-[11px] font-medium text-text transition hover:border-accent/40 disabled:opacity-40"
                >
                  Download .md
                </button>
                <button
                  type="button"
                  onClick={copy}
                  disabled={!ready}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg px-3 py-1.5 text-[11px] font-medium text-muted transition hover:text-text disabled:opacity-40"
                >
                  {copied ? "Copied" : "Copy markdown"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  disabled={!ready}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted transition hover:text-text disabled:opacity-40"
                >
                  {showPreview ? "Hide preview" : "Show preview"}
                </button>
              </div>
              {docxError && (
                <p className="mt-2 text-[11px] font-mono text-red-300">
                  {docxError}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {ready && showPreview && (
        <div className="report-content border-t border-border bg-white px-6 py-5 text-sm leading-relaxed text-black">
          <div
            className="md-content"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(message.content),
            }}
          />
        </div>
      )}

      <style jsx>{`
        :global(.report-content .md-h1) {
          font-size: 1.4rem;
          font-weight: 700;
          margin: 0 0 0.75rem 0;
          color: #111;
        }
        :global(.report-content .md-h2) {
          font-size: 1.05rem;
          font-weight: 600;
          margin: 1.2rem 0 0.4rem 0;
          color: #111;
          border-bottom: 1px solid rgba(0, 0, 0, 0.08);
          padding-bottom: 0.25rem;
        }
        :global(.report-content .md-h3) {
          font-size: 0.95rem;
          font-weight: 600;
          margin: 1rem 0 0.3rem 0;
          color: #222;
        }
        :global(.report-content p) {
          margin: 0.4rem 0;
          color: #222;
        }
        :global(.report-content .md-list) {
          list-style: disc;
          padding-left: 1.2rem;
          margin: 0.4rem 0;
          color: #222;
        }
        :global(.report-content .inline-code) {
          background: rgba(0, 0, 0, 0.06);
          padding: 0 0.3em;
          border-radius: 2px;
        }
        :global(.report-content .code-block) {
          background: rgba(0, 0, 0, 0.04);
          padding: 0.75rem;
          border-radius: 4px;
          overflow-x: auto;
        }
      `}</style>
    </article>
  );
}

// =========================================================================
// Message bubble
// =========================================================================

// Renders a single chat turn. The render contract:
//   * User turns are right-aligned, white bubble, "You" label.
//   * Assistant turns are left-aligned, dark bubble, brand glyph + "Agent" label.
//   * `isStreaming` only applies to the LAST message — the parent
//     gates this so older messages don't flash a cursor.
//   * `streamError` (set by the parent on stream failure) renders an
//     in-bubble "Response interrupted. Try again." banner with a
//     retry button that re-issues `retryPrompt`.
function MessageBubble({
  message,
  isStreaming,
  onRetry,
  userAvatarUrl,
  userLabel,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  onRetry?: () => void;
  userAvatarUrl?: string | null;
  userLabel?: string;
}) {
  const isUser = message.role === "user";
  const isPendingAssistant =
    !isUser && message.content === "" && isStreaming && !message.streamError;
  const isStreamingThis = !isUser && isStreaming && !message.streamError;
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  // Render markdown plus an optional streaming caret. Always re-runs
  // on every chunk because `message.content` changes — partial
  // markdown therefore renders progressively.
  const html = useMemo(() => {
    const rendered = renderMarkdown(message.content);
    return isStreamingThis && message.content
      ? appendCaret(rendered)
      : rendered;
  }, [message.content, isStreamingThis]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className={
        "flex gap-2 " +
        (isUser ? "flex-row-reverse items-start" : "flex-row items-start")
      }
    >
      {/* Avatar */}
      {isUser ? (
        userAvatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={userAvatarUrl}
            alt=""
            className="mt-0.5 h-7 w-7 shrink-0 rounded-full border border-border bg-card"
          />
        ) : (
          <span
            aria-hidden
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-bg-elev text-[10px] font-mono text-muted"
          >
            {(userLabel ?? "Y").slice(0, 1).toUpperCase()}
          </span>
        )
      ) : (
        <span
          aria-hidden
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-bg-elev text-text"
          title="Lyncas"
        >
          <LyncasGlyph size={13} />
        </span>
      )}

      <div
        className={
          "group relative flex min-w-0 flex-col " +
          (isUser ? "items-end" : "items-start")
        }
      >
        <div
          className={
            "flex items-center gap-2 px-1 pb-1 text-[10px] font-mono uppercase tracking-[0.14em] text-muted " +
            (isUser ? "flex-row-reverse" : "")
          }
        >
          <span>{isUser ? userLabel ?? "You" : "Agent"}</span>
          <span aria-hidden>·</span>
          <span>{formatTime(message.ts)}</span>
        </div>

        <div
          className={
            "relative max-w-[85%] rounded-md px-3.5 py-2.5 font-mono text-[12px] leading-relaxed sm:max-w-[80%] " +
            (isUser
              ? "bg-white text-black"
              : "border border-border bg-bg-elev text-white") +
            " shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]"
          }
        >
          {isPendingAssistant ? (
            <TypingDots />
          ) : isUser ? (
            <div className="whitespace-pre-wrap break-words">
              {message.content}
            </div>
          ) : (
            <div
              className="md-content break-words"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          {/* Copy on hover (assistant only). Anchors to the bubble
              corner so user messages stay aligned. */}
          {!isUser && !isPendingAssistant && message.content && (
            <button
              type="button"
              onClick={copy}
              className="absolute right-1 top-1 rounded-sm border border-border bg-bg/80 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.14em] text-muted opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
              aria-label={copied ? "Copied" : "Copy"}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>

        {message.streamError && (
          <div
            className="mt-1.5 flex items-center gap-2 rounded-sm border border-[#ff9d4d]/40 bg-[#ff9d4d]/10 px-2.5 py-1 text-[11px] text-[#ff9d4d]"
            role="alert"
          >
            <span>Response interrupted. Try again.</span>
            {onRetry && message.retryPrompt && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-sm border border-[#ff9d4d]/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] hover:bg-[#ff9d4d]/15"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1" aria-label="Thinking">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
      <style jsx>{`
        .dot {
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background-color: currentColor;
          opacity: 0.4;
          animation: blink 1.2s infinite ease-in-out;
        }
        .dot:nth-child(2) {
          animation-delay: 0.2s;
        }
        .dot:nth-child(3) {
          animation-delay: 0.4s;
        }
        @keyframes blink {
          0%,
          80%,
          100% {
            opacity: 0.25;
          }
          40% {
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

// =========================================================================
// Quick action grid — 3 rows × 3 columns (compact mode collapses to a
// single column of buttons for the 220px sidebar). The "Run tests"
// action is filtered out unless DevPod is connected.
// =========================================================================

// Monochrome 16×16 line icons for the quick actions. Stroke-based so
// they inherit `currentColor` and stay crisp at small sizes — no
// emoji, no color noise.
function ActionIcon({ name }: { name: QuickActionIcon }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "prs":
      return (
        <svg {...common}>
          <circle cx="4" cy="4" r="1.6" />
          <circle cx="4" cy="12" r="1.6" />
          <path d="M4 5.6v4.8" />
          <path d="M11.5 4h-3l1.2-1.2M8.5 4l1.2 1.2" />
          <circle cx="12" cy="6" r="1.6" />
          <path d="M12 7.6c0 2-1 2.8-3 3.2" />
        </svg>
      );
    case "review":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4" />
          <path d="M10 10l3 3" />
          <path d="M5.5 7l1.2 1.2L9 5.8" />
        </svg>
      );
    case "merge":
      return (
        <svg {...common}>
          <circle cx="4" cy="4" r="1.6" />
          <circle cx="4" cy="12" r="1.6" />
          <circle cx="12" cy="9" r="1.6" />
          <path d="M4 5.6v4.8" />
          <path d="M4 8c0-2.4 3.5-1.4 6.4-1.4" />
        </svg>
      );
    case "health":
      return (
        <svg {...common}>
          <path d="M1.5 8h3l1.5-4 2.5 8 1.5-4h4.5" />
        </svg>
      );
    case "branches":
      return (
        <svg {...common}>
          <circle cx="4" cy="3.5" r="1.6" />
          <circle cx="4" cy="12.5" r="1.6" />
          <circle cx="12" cy="3.5" r="1.6" />
          <path d="M4 5.1v5.8" />
          <path d="M12 5.1c0 3.4-3 3.6-6 4.2" />
        </svg>
      );
    case "contributors":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="2.2" />
          <path d="M2.5 13c.5-2.2 2-3.2 3.5-3.2s3 1 3.5 3.2" />
          <path d="M11 4.2a2 2 0 0 1 0 3.8" />
          <path d="M11.5 9.8c1.3.3 2.2 1.3 2.6 3" />
        </svg>
      );
    case "tests":
      return (
        <svg {...common}>
          <path d="M6.5 2v4L3.5 12a1.3 1.3 0 0 0 1.2 2h6.6a1.3 1.3 0 0 0 1.2-2L9.5 6V2" />
          <path d="M5.5 2h5" />
          <path d="M5.8 9.5h4.4" />
        </svg>
      );
    case "report":
      return (
        <svg {...common}>
          <path d="M4 1.8h5L12 4.8v9.4H4z" />
          <path d="M8.6 1.8v3.2H12" />
          <path d="M6 8.5h4M6 11h2.5" />
        </svg>
      );
    case "bugs":
      return (
        <svg {...common}>
          <rect x="5" y="6" width="6" height="6.5" rx="3" />
          <path d="M6 4.5l1 1.5M10 4.5L9 6" />
          <path d="M2.5 8H5M11 8h2.5M2.8 11H5M11 11h2.2M3.2 5.5L5 6.7M11 6.7l1.8-1.2" />
        </svg>
      );
    default:
      return null;
  }
}

function QuickActionGrid({
  hasRepo,
  isStreaming,
  devpodLive,
  onAction,
  compact = false,
}: {
  hasRepo: boolean;
  isStreaming: boolean;
  devpodLive: boolean;
  onAction: (a: QuickAction) => void;
  compact?: boolean;
}) {
  // Flatten + filter the rows so the compact (sidebar) mode renders
  // a vertical list while the wide (empty-room) mode keeps the
  // 3×3 grid.
  const visible = QUICK_ACTION_ROWS.flatMap((row) =>
    row.filter((a) => !a.requiresDevpod || devpodLive),
  );
  if (compact) {
    return (
      <div className="flex flex-col gap-0.5 p-1">
        {visible.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={() => onAction(a)}
            disabled={!hasRepo || isStreaming}
            className="group/qa flex items-center gap-2.5 rounded-sm border border-transparent px-2 py-1.5 text-left text-xs font-mono text-muted transition-colors hover:border-border hover:bg-bg-elev hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-muted"
            title={a.action === "report" ? "Generate health report" : a.prompt}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border border-border bg-bg text-muted transition-colors group-hover/qa:border-border-strong group-hover/qa:text-text">
              <ActionIcon name={a.icon} />
            </span>
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            <span className="shrink-0 text-muted opacity-0 transition-opacity group-hover/qa:opacity-100">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="M6 4l4 4-4 4" />
              </svg>
            </span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {visible.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={() => onAction(a)}
          disabled={!hasRepo || isStreaming}
          className="group/qa flex h-full flex-col gap-2 rounded-md border border-border bg-bg-elev px-3 py-3 text-left text-xs font-mono text-text transition-all hover:-translate-y-px hover:border-border-strong hover:bg-card disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
          title={a.action === "report" ? "Generate health report" : a.prompt}
        >
          <span className="flex items-center justify-between">
            <span className="flex h-7 w-7 items-center justify-center rounded-[5px] border border-border bg-bg text-text transition-colors group-hover/qa:border-border-strong">
              <ActionIcon name={a.icon} />
            </span>
            <span className="text-muted opacity-0 transition-opacity group-hover/qa:opacity-100">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="M6 4l4 4-4 4" />
              </svg>
            </span>
          </span>
          <span className="text-[13px] font-semibold leading-tight">
            {a.label}
          </span>
          {a.action !== "report" && (
            <span className="line-clamp-2 text-[10px] font-normal leading-snug text-muted">
              {a.prompt}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// =========================================================================
// Empty-room state — shown when a repo IS selected but has no messages
// yet. Quick actions intentionally live ONLY in the left sidebar, so
// this is a calm prompt to start typing rather than a duplicate grid.
// =========================================================================

function EmptyRoomQuickStart({ repo }: { repo: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={repoAvatarUrl(repo)}
        alt=""
        className="h-12 w-12 rounded-full border border-border bg-card"
      />
      <div className="space-y-1">
        <div className="text-[13px] font-semibold">
          Ask me anything about{" "}
          <span className="font-mono">{repo.split("/")[1] ?? repo}</span>
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          Type a question below, or use a{" "}
          <span className="text-text">Quick action</span> from the
          sidebar.
        </p>
      </div>
    </div>
  );
}

// =========================================================================
// ChatComposer — the input area at the bottom of the chat pane.
// Auto-resizes up to 5 lines, surfaces a character count only past
// CHAR_COUNT_VISIBLE_THRESHOLD, swaps the Send button copy for a
// spinner while a stream is running.
// =========================================================================

function ChatComposer({
  hasRepo,
  repo,
  isStreaming,
  input,
  onChange,
  onSubmit,
  onKeyDown,
}: {
  hasRepo: boolean;
  repo: string;
  isStreaming: boolean;
  input: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize: re-measure on every value change. We cap at ~5 lines
  // (~120px); past that the textarea scrolls. Reset to "auto" first
  // so shrinking works when the user deletes text.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 120);
    el.style.height = `${next}px`;
  }, [input]);

  const placeholder = !hasRepo
    ? "Select a repository first"
    : isStreaming
      ? "Waiting for response…"
      : `Ask anything about ${repo} or type a command…`;

  const showCharCount = input.length > CHAR_COUNT_VISIBLE_THRESHOLD;
  const nearLimit = input.length >= MAX_INPUT_CHARS - 50;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex items-end gap-2 border-t border-border bg-bg px-3 py-3"
    >
      <div className="flex flex-1 flex-col gap-1">
        <textarea
          ref={ref}
          value={input}
          onChange={(e) => onChange(e.target.value.slice(0, MAX_INPUT_CHARS))}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={isStreaming || !hasRepo}
          className="resize-none rounded-sm border border-border bg-card px-3 py-2 font-mono text-[12px] leading-relaxed focus:border-white focus:outline-none disabled:opacity-60"
          style={{ minHeight: 38, maxHeight: 120 }}
        />
        {showCharCount && (
          <div className="flex items-center justify-end text-[10px] font-mono text-muted">
            <span className={nearLimit ? "text-[#ff9d4d]" : ""}>
              {input.length}/{MAX_INPUT_CHARS}
            </span>
          </div>
        )}
      </div>
      <Button
        type="submit"
        variant="primary"
        size="md"
        disabled={isStreaming || !input.trim() || !hasRepo}
        className="self-start"
        title={isStreaming ? "Streaming…" : "Send (Enter)"}
      >
        {isStreaming ? <ButtonSpinner /> : "Send"}
      </Button>
    </form>
  );
}

function ButtonSpinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

// =========================================================================
// Confirmation modal — used by the "Clear chat" button. Shares the
// chrome of InstallAppModal but leaner; an InstallAppModal is too
// heavy for an OK/Cancel.
// =========================================================================

function ConfirmModal({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onCancel, onConfirm]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-md border border-border bg-bg shadow-2xl">
        <header className="border-b border-border px-5 py-4">
          <h2
            id="confirm-modal-title"
            className="text-base font-semibold leading-tight"
          >
            {title}
          </h2>
        </header>
        <div className="px-5 py-4 text-sm leading-relaxed">{body}</div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </footer>
      </div>
    </div>
  );
}
