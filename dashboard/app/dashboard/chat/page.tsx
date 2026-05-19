"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// /dashboard/chat — three-column repo chat workspace.
//
// Columns:
//   ┌─ 220px left ─┬─ flex chat ─────────────────────┬─ 280px right ─┐
//   │ repo rooms   │ briefing + messages + composer  │ Repository    │
//   │ quick acts   │                                 │ Research      │
//   └──────────────┴─────────────────────────────────┴───────────────┘
//
// Responsive:
//   * < 768px (mobile)    : left sidebar collapses into a dropdown at
//                            the top of the chat pane. Right sidebar
//                            is hidden entirely (low information value
//                            vs vertical space cost on phones).
//   * 768–1023px (tablet) : both side panels visible, right sidebar
//                            sections start collapsed.
//   * >= 1024px (desktop) : both panels visible, both right-sidebar
//                            sections start expanded.
//
// Repo selection:
//   * No auto-selection on load — the user MUST pick a room. The chat
//     pane shows a large empty state with a dropdown (avatars + names)
//     and clicking a row in the left sidebar achieves the same thing.
//   * On selection: messages reset, the research briefing fires, the
//     right-sidebar stats fire, the right-sidebar research panel
//     fetches its cached articles.

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  // Reports render as a special full-width card with white background
  // and download/copy controls. Everything else is a regular bubble.
  kind?: "chat" | "report";
}

interface WatchedRepoLite {
  repo: string;
}

interface BriefingState {
  repo: string;
  content: string;
  loading: boolean;
  error: string | null;
  dismissed: boolean;
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
  articles: ResearchArticle[];
  updatedAt: string | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

const MAX_INPUT_CHARS = 2000;
const QUICK_ACTIONS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "Recent PRs", prompt: "Show me the open pull requests." },
  { label: "Recent activity", prompt: "Summarize recent activity (commits, PRs, contributors) in the last 30 days." },
  { label: "Merge latest PR", prompt: "Merge the most recent open PR." },
  { label: "Show repo stats", prompt: "Show repository statistics: open PRs, contributors, languages." },
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

function renderMarkdown(raw: string): string {
  let s = escapeHtml(raw);
  s = s.replace(/```([\s\S]*?)```/g, (_m, body: string) => {
    return `<pre class="code-block"><code>${body.replace(/^\n/, "")}</code></pre>`;
  });
  s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const lines = s.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const h1 = /^\s*#\s+(.+)$/.exec(line);
    const h3 = /^\s*###\s+(.+)$/.exec(line);
    const h2 = /^\s*##\s+(.+)$/.exec(line);
    if (h1) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<h1 class="md-h1">${h1[1]}</h1>`);
      continue;
    }
    if (h3) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<h3 class="md-h3">${h3[1]}</h3>`);
      continue;
    }
    if (h2) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<h2 class="md-h2">${h2[1]}</h2>`);
      continue;
    }
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) {
      if (!inList) {
        out.push('<ul class="md-list">');
        inList = true;
      }
      out.push(`<li>${m[1]}</li>`);
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(line);
    }
  }
  if (inList) out.push("</ul>");
  return out
    .join("\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, "<br/>"))
    .map((p) => (p.trim() ? `<p>${p}</p>` : ""))
    .join("");
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

// Per-language colors mirroring GitHub's linguist palette. Anything not
// in here falls back to neutral grey — Linguist's full list is huge and
// we'd rather underclaim color than mis-color.
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
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [loading, setLoading] = useState(true);
  const [repos, setRepos] = useState<WatchedRepoLite[]>([]);
  // CRITICAL: starts empty. No auto-selection on mount.
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [briefing, setBriefing] = useState<BriefingState | null>(null);
  const [roomTransition, setRoomTransition] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const [stats, setStats] = useState<RepoStatsState | null>(null);
  const [research, setResearch] = useState<ResearchState | null>(null);
  // Per-section collapse state. Default is "open on desktop, collapsed
  // on tablet" — we initialise to `null` (lit by an effect) so SSR
  // doesn't mismatch.
  const [repoPanelOpen, setRepoPanelOpen] = useState<boolean | null>(null);
  const [researchPanelOpen, setResearchPanelOpen] = useState<boolean | null>(
    null,
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const briefingAbortRef = useRef<AbortController | null>(null);
  const statsAbortRef = useRef<AbortController | null>(null);
  const researchAbortRef = useRef<AbortController | null>(null);

  // --- mount: fetch watched repos -----------------------------------------
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
          .from("watched_repos")
          .select("repo")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });
        if (cancelled) return;
        setRepos((data ?? []) as WatchedRepoLite[]);
        // NOTE: we deliberately do NOT auto-select repos[0]. The empty
        // state below shows a picker.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      briefingAbortRef.current?.abort();
      statsAbortRef.current?.abort();
      researchAbortRef.current?.abort();
    };
  }, [router, supabase]);

  // Initialize right-sidebar collapse defaults from viewport once on
  // mount. We re-listen via matchMedia so resizing across the lg
  // breakpoint feels natural.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    function sync() {
      // Only set defaults if the user hasn't manually toggled. We
      // approximate this with "set on initial mount, leave alone after".
      setRepoPanelOpen((v) => (v === null ? mq.matches : v));
      setResearchPanelOpen((v) => (v === null ? mq.matches : v));
    }
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Auto-scroll the message list as new tokens arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, briefing]);

  // --- briefing -----------------------------------------------------------
  const fetchBriefing = useCallback(async (repo: string) => {
    briefingAbortRef.current?.abort();
    const ac = new AbortController();
    briefingAbortRef.current = ac;
    setBriefing({
      repo,
      content: "",
      loading: true,
      error: null,
      dismissed: false,
    });
    setGlobalError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Generate a research briefing for this repository.",
          repo,
          history: [],
          isResearchBriefing: true,
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
        setBriefing((b) =>
          b && b.repo === repo ? { ...b, loading: false, error: detail } : b,
        );
        setGlobalError(
          "Some repository data unavailable — answers may be limited",
        );
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let content = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.startsWith("data: ") ? frame.slice(6) : frame;
          if (!line) continue;
          if (line === "[DONE]") {
            reader.cancel();
            setBriefing((b) =>
              b && b.repo === repo ? { ...b, content, loading: false } : b,
            );
            return;
          }
          content += line;
          setBriefing((b) => (b && b.repo === repo ? { ...b, content } : b));
        }
      }
      setBriefing((b) =>
        b && b.repo === repo ? { ...b, content, loading: false } : b,
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setBriefing((b) =>
        b && b.repo === repo
          ? { ...b, loading: false, error: (e as Error).message }
          : b,
      );
    }
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
  const fetchResearch = useCallback(
    async (repo: string, opts: { force?: boolean } = {}) => {
      researchAbortRef.current?.abort();
      const ac = new AbortController();
      researchAbortRef.current = ac;
      setResearch((r) => ({
        repo,
        articles: r && r.repo === repo ? r.articles : [],
        updatedAt: r && r.repo === repo ? r.updatedAt : null,
        loading: !(r && r.repo === repo && r.articles.length > 0),
        refreshing: !!opts.force,
        error: null,
      }));
      try {
        const url =
          `/api/repo-research?repo=${encodeURIComponent(repo)}` +
          (opts.force ? "&force=true" : "");
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setResearch((r) =>
            r && r.repo === repo
              ? {
                  ...r,
                  loading: false,
                  refreshing: false,
                  error: j.error ?? `HTTP ${res.status}`,
                }
              : r,
          );
          return;
        }
        const data = (await res.json()) as {
          articles: ResearchArticle[];
          updated_at: string;
        };
        setResearch((r) =>
          r && r.repo === repo
            ? {
                ...r,
                articles: data.articles ?? [],
                updatedAt: data.updated_at ?? null,
                loading: false,
                refreshing: false,
                error: null,
              }
            : r,
        );
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setResearch((r) =>
          r && r.repo === repo
            ? {
                ...r,
                loading: false,
                refreshing: false,
                error: (e as Error).message,
              }
            : r,
        );
      }
    },
    [],
  );

  // When the selected repo changes, fire all three "enter room"
  // side-effects (briefing, stats, research). When it clears, drop
  // everything so the empty state is pristine.
  useEffect(() => {
    if (!selectedRepo) {
      setBriefing(null);
      setStats(null);
      setResearch(null);
      setMessages([]);
      return;
    }
    abortRef.current?.abort();
    setMessages([]);
    setRoomTransition(true);
    setGlobalError(null);
    const t = setTimeout(() => {
      setRoomTransition(false);
      void fetchBriefing(selectedRepo);
      void fetchStats(selectedRepo);
      void fetchResearch(selectedRepo);
    }, 400);
    return () => clearTimeout(t);
  }, [selectedRepo, fetchBriefing, fetchStats, fetchResearch]);

  // --- send / report ------------------------------------------------------
  async function send(rawPrompt: string) {
    const prompt = rawPrompt.trim();
    if (!prompt || isStreaming || !selectedRepo) return;

    const now = Date.now();
    const userId = crypto.randomUUID();
    const asstId = crypto.randomUUID();
    const userMsg: ChatMessage = {
      id: userId,
      role: "user",
      content: prompt,
      ts: now,
    };
    const placeholder: ChatMessage = {
      id: asstId,
      role: "assistant",
      content: "",
      ts: now,
    };
    const history = messages
      .slice(-10)
      .filter((m) => m.kind !== "report")
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, userMsg, placeholder]);
    setInput("");
    setIsStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: prompt,
          repo: selectedRepo,
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
        appendToAssistant(asstId, `**Error.** ${detail}`);
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
          const line = frame.startsWith("data: ") ? frame.slice(6) : frame;
          if (!line) continue;
          if (line === "[DONE]") {
            reader.cancel();
            return;
          }
          if (line.startsWith("{")) {
            try {
              const parsed = JSON.parse(line) as { error?: string };
              if (parsed.error) {
                appendToAssistant(asstId, `\n\n**Error.** ${parsed.error}`);
                continue;
              }
            } catch {
              // fall through and treat as plain text
            }
          }
          appendToAssistant(asstId, line);
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      appendToAssistant(
        asstId,
        `\n\n**Error.** ${(e as Error).message || "Network error."}`,
      );
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  async function generateReport() {
    if (isStreaming || !selectedRepo) return;
    const now = Date.now();
    const reportId = crypto.randomUUID();
    const placeholder: ChatMessage = {
      id: reportId,
      role: "assistant",
      content: "",
      ts: now,
      kind: "report",
    };
    setMessages((m) => [...m, placeholder]);
    setIsStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isReport: true,
          repo: selectedRepo,
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
        appendToAssistant(reportId, `**Report failed.** ${detail}`);
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
          const line = frame.startsWith("data: ") ? frame.slice(6) : frame;
          if (!line) continue;
          if (line === "[DONE]") {
            reader.cancel();
            return;
          }
          appendToAssistant(reportId, line);
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      appendToAssistant(
        reportId,
        `\n\n**Report failed.** ${(e as Error).message || "Network error."}`,
      );
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  function appendToAssistant(id: string, chunk: string) {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === id ? { ...msg, content: msg.content + chunk } : msg,
      ),
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  function clearChat() {
    abortRef.current?.abort();
    setMessages([]);
  }

  // --- render: loading / empty repo list ----------------------------------
  if (loading) {
    return (
      <Container className="py-10">
        <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
      </Container>
    );
  }

  if (repos.length === 0) {
    return (
      <Container size="narrow" className="py-10">
        <Card className="p-8 space-y-4 text-center">
          <h1 className="text-lg font-semibold">No repositories yet</h1>
          <p className="text-sm text-muted">
            Connect a repository and the chat will answer questions about its
            PRs, branches, and activity — and act on your behalf (close,
            comment, merge).
          </p>
          <div className="flex justify-center">
            <Link
              href="/dashboard/connect-repo"
              className="inline-flex h-10 items-center justify-center bg-white text-black font-mono uppercase tracking-[0.08em] text-sm px-5 hover:bg-white/90 transition-colors"
            >
              Connect a repository →
            </Link>
          </div>
        </Card>
      </Container>
    );
  }

  const hasRepo = !!selectedRepo;

  // --- render: main 3-col layout ------------------------------------------
  return (
    <Container size="wide" className="py-6">
      <div className="flex flex-col gap-4 md:flex-row md:gap-4 md:h-[calc(100vh-7rem)] md:min-h-[560px]">
        {/* === LEFT: repo rooms + quick actions === */}
        <aside className="hidden w-full shrink-0 flex-col gap-4 overflow-y-auto pr-1 md:flex md:w-[220px]">
          <Card className="p-3" flush>
            <div className="px-1 pb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
              Repositories
            </div>
            <div className="flex flex-col gap-1 p-1">
              {repos.map((r) => {
                const active = r.repo === selectedRepo;
                return (
                  <button
                    key={r.repo}
                    type="button"
                    onClick={() => setSelectedRepo(r.repo)}
                    disabled={isStreaming}
                    className={
                      "flex items-center gap-2 rounded-sm border px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-50 " +
                      (active
                        ? "border-border-strong bg-bg-elev"
                        : "border-transparent hover:bg-bg-elev")
                    }
                    title={r.repo}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={repoAvatarUrl(r.repo)}
                      alt=""
                      className="h-5 w-5 shrink-0 rounded-full border border-border bg-card"
                    />
                    <span className="truncate font-mono">{r.repo}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card className="p-3" flush>
            <div className="px-1 pb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
              Quick actions
            </div>
            <div className="flex flex-col gap-1 p-1">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => void send(a.prompt)}
                  disabled={!hasRepo || isStreaming}
                  className="rounded-sm border border-transparent px-2 py-1.5 text-left text-xs font-mono text-muted transition-colors hover:bg-bg-elev hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
                  title={a.prompt}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </Card>
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
                  <div className="truncate text-sm font-semibold">
                    {hasRepo
                      ? `#${selectedRepo.split("/")[1] ?? selectedRepo}`
                      : "Chat"}
                  </div>
                  <div className="truncate text-[11px] font-mono text-muted">
                    {hasRepo ? selectedRepo : "no repository selected"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  onClick={generateReport}
                  disabled={!hasRepo || isStreaming}
                  title="Generate health report"
                >
                  Report
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  onClick={clearChat}
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
                <RepoSelect
                  repos={repos}
                  value={selectedRepo}
                  onChange={setSelectedRepo}
                  disabled={isStreaming}
                />
              </div>

              {globalError && (
                <div className="rounded-sm border border-[#ff9d4d]/40 bg-[#ff9d4d]/10 px-3 py-2 text-xs text-[#ff9d4d]">
                  {globalError}
                </div>
              )}

              {!hasRepo && <EmptyRoomState repos={repos} onPick={setSelectedRepo} />}

              {hasRepo && roomTransition && (
                <div className="py-6 text-center text-xs italic text-muted">
                  Entering #{selectedRepo.split("/")[1] ?? selectedRepo}{" "}
                  room…
                </div>
              )}

              {hasRepo &&
                !roomTransition &&
                briefing &&
                !briefing.dismissed &&
                briefing.repo === selectedRepo && (
                  <BriefingCard
                    briefing={briefing}
                    onDismiss={() =>
                      setBriefing(
                        briefing ? { ...briefing, dismissed: true } : null,
                      )
                    }
                    onRefresh={() => void fetchBriefing(selectedRepo)}
                  />
                )}

              {hasRepo &&
                !roomTransition &&
                messages.length === 0 &&
                briefing?.dismissed && (
                  <div className="space-y-3 py-12 text-center">
                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
                      Ready
                    </div>
                    <div className="text-sm text-muted">
                      Ask anything about {selectedRepo}.
                    </div>
                  </div>
                )}

              {messages.map((m) =>
                m.kind === "report" ? (
                  <ReportCard
                    key={m.id}
                    message={m}
                    repo={selectedRepo}
                    isStreaming={isStreaming}
                  />
                ) : (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    isStreaming={isStreaming}
                  />
                ),
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="flex items-end gap-2 border-t border-border bg-bg px-3 py-3"
            >
              <div className="flex flex-1 flex-col gap-1">
                <textarea
                  value={input}
                  onChange={(e) =>
                    setInput(e.target.value.slice(0, MAX_INPUT_CHARS))
                  }
                  onKeyDown={handleKeyDown}
                  placeholder={
                    !hasRepo
                      ? "Select a repository first…"
                      : isStreaming
                        ? "Waiting for response…"
                        : "Ask, review, or say 'close pr 42' / 'merge pr 7'…"
                  }
                  rows={1}
                  disabled={isStreaming || !hasRepo}
                  className="max-h-32 resize-none rounded-sm border border-border bg-card px-3 py-2 text-sm focus:border-white focus:outline-none disabled:opacity-60"
                  style={{ minHeight: 38 }}
                />
                <div className="flex items-center justify-end text-[10px] font-mono text-muted">
                  <span
                    className={
                      input.length >= MAX_INPUT_CHARS - 50
                        ? "text-[#ff9d4d]"
                        : ""
                    }
                  >
                    {input.length}/{MAX_INPUT_CHARS}
                  </span>
                </div>
              </div>
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={isStreaming || !input.trim() || !hasRepo}
                className="self-start"
              >
                {isStreaming ? "…" : "Send"}
              </Button>
            </form>
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
    </Container>
  );
}

// =========================================================================
// Components
// =========================================================================

function RepoSelect({
  repos,
  value,
  onChange,
  disabled,
}: {
  repos: WatchedRepoLite[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="w-full bg-bg border border-border rounded-sm px-2 py-2 text-xs font-mono focus:border-white focus:outline-none"
    >
      <option value="">— select a repository —</option>
      {repos.map((r) => (
        <option key={r.repo} value={r.repo}>
          {r.repo}
        </option>
      ))}
    </select>
  );
}

function EmptyRoomState({
  repos,
  onPick,
}: {
  repos: WatchedRepoLite[];
  onPick: (repo: string) => void;
}) {
  // Default-open dropdown with avatars beats a native <select> for
  // discoverability. We keep it keyboard-accessible (Enter / arrow
  // keys work because we use a <select> element underneath).
  return (
    <div className="flex flex-col items-center justify-center gap-5 py-16 text-center sm:py-24">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-full border border-border bg-bg-elev"
        aria-hidden
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-muted"
        >
          <path d="M3 3h12a3 3 0 0 1 3 3v15l-4-3-4 3-4-3-4 3V3z" />
        </svg>
      </div>
      <div className="space-y-1">
        <div className="text-base font-semibold">Select a repository to start</div>
        <div className="text-xs text-muted">
          Pick a room from the left sidebar — or use the dropdown below.
        </div>
      </div>

      <div className="w-full max-w-sm space-y-2">
        <RepoSelect
          repos={repos}
          value=""
          onChange={onPick}
          disabled={false}
        />
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          {repos.length} watched repo{repos.length === 1 ? "" : "s"}
        </div>
      </div>

      {/* Avatar grid: clickable shortcuts to the first ~8 repos. */}
      {repos.length > 0 && (
        <div className="flex max-w-md flex-wrap items-center justify-center gap-2">
          {repos.slice(0, 8).map((r) => (
            <button
              key={r.repo}
              type="button"
              onClick={() => onPick(r.repo)}
              className="flex items-center gap-1.5 rounded-sm border border-border bg-bg-elev px-2 py-1 text-xs font-mono hover:border-border-strong"
              title={r.repo}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={repoAvatarUrl(r.repo)}
                alt=""
                className="h-4 w-4 rounded-full border border-border bg-card"
              />
              <span className="truncate max-w-[160px]">{r.repo}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
              // Don't toggle the panel when clicking the action button.
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
      {/* Top-line numbers */}
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Stars" value={d.stars ?? "—"} />
        <StatTile label="Open PRs" value={d.open_prs ?? "—"} />
        <StatTile
          label="Updated"
          value={formatAgo(d.last_commit)}
          mono
        />
      </div>

      {/* Languages */}
      <div className="space-y-2">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Languages
        </div>
        {langs.length === 0 ? (
          <div className="text-[11px] text-muted">No language data</div>
        ) : (
          <>
            {/* Stacked progress bar */}
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

      {/* Contributors */}
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
  if (research.articles.length === 0) {
    return (
      <div className="text-[11px] text-muted">
        No suggestions yet. Try the refresh button above.
      </div>
    );
  }
  return (
    <div className="space-y-3">
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
// Briefing card
// =========================================================================

function BriefingCard({
  briefing,
  onDismiss,
  onRefresh,
}: {
  briefing: BriefingState;
  onDismiss: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(briefing.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }
  return (
    <div className="overflow-hidden rounded-sm border border-border bg-bg-elev border-l-2 border-l-[#60a5fa]">
      <div className="flex items-center justify-between border-b border-border bg-bg px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[#60a5fa]">
            Research briefing
          </span>
          <span className="text-[10px] font-mono text-muted">
            auto-generated on room enter
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            disabled={briefing.loading || !briefing.content}
            className="rounded-sm border border-border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em] text-muted hover:text-text disabled:opacity-40"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={briefing.loading}
            className="rounded-sm border border-border px-2 py-0.5 text-[11px] text-muted hover:text-text disabled:opacity-40"
            title="Regenerate briefing"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-sm border border-border px-2 py-0.5 text-[11px] text-muted hover:text-text"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="p-4 text-sm">
        {briefing.loading && !briefing.content ? (
          <BriefingSkeleton />
        ) : briefing.error ? (
          <div className="text-xs text-[#ff9d4d]">
            Could not generate briefing: {briefing.error}
          </div>
        ) : (
          <div
            className="md-content"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(briefing.content),
            }}
          />
        )}
      </div>
    </div>
  );
}

function BriefingSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-3 w-24 rounded bg-border" />
      <div className="space-y-1.5">
        <div className="h-2 w-full rounded bg-border/70" />
        <div className="h-2 w-5/6 rounded bg-border/70" />
      </div>
      <div className="mt-3 h-3 w-32 rounded bg-border" />
      <div className="space-y-1.5">
        <div className="h-2 w-4/6 rounded bg-border/70" />
        <div className="h-2 w-3/6 rounded bg-border/70" />
      </div>
    </div>
  );
}

// =========================================================================
// Report card (full-width, print-friendly, white background)
// =========================================================================

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
  const pending = isStreaming && !message.content;

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  function download() {
    // Use a one-shot anchor element. URL.createObjectURL keeps the
    // blob alive until we revoke it; the next tick is enough.
    const today = new Date().toISOString().slice(0, 10);
    const safeRepo = repo.replace(/[^A-Za-z0-9._-]+/g, "-");
    const filename = `${safeRepo}-health-report-${today}.md`;
    const blob = new Blob([message.content], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <article className="overflow-hidden rounded-sm border border-border bg-white text-black shadow-sm">
      <header className="flex items-center justify-between gap-2 border-b border-black/10 bg-black/[0.02] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-black/60">
            Report
          </span>
          <span className="text-[10px] font-mono text-black/40">
            {repo} · {formatTime(message.ts)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            disabled={pending || !message.content}
            className="rounded-sm border border-black/15 bg-white px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em] text-black/60 hover:text-black disabled:opacity-40"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={download}
            disabled={pending || !message.content}
            className="rounded-sm border border-black/15 bg-white px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em] text-black/60 hover:text-black disabled:opacity-40"
          >
            Download .md
          </button>
        </div>
      </header>
      <div className="report-content px-6 py-5 text-sm leading-relaxed">
        {pending ? (
          <div className="space-y-3 py-4">
            <div className="h-4 w-1/2 rounded bg-black/10" />
            <div className="space-y-1.5">
              <div className="h-2 w-full rounded bg-black/5" />
              <div className="h-2 w-11/12 rounded bg-black/5" />
              <div className="h-2 w-9/12 rounded bg-black/5" />
            </div>
            <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-black/40">
              Generating report…
            </div>
          </div>
        ) : (
          <div
            className="md-content"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(message.content),
            }}
          />
        )}
      </div>
      {/* Inline styles to flip the dark-mode markdown defaults to a
          print-friendly palette without polluting global CSS. */}
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

function MessageBubble({
  message,
  isStreaming,
}: {
  message: ChatMessage;
  isStreaming: boolean;
}) {
  const isUser = message.role === "user";
  const isPendingAssistant =
    !isUser && message.content === "" && isStreaming;
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

  return (
    <div className={"flex flex-col " + (isUser ? "items-end" : "items-start")}>
      <div
        className={
          "max-w-[85%] rounded-sm px-3.5 py-2 text-sm sm:max-w-[80%] " +
          (isUser
            ? "bg-white text-black"
            : "border border-border bg-bg-elev text-text")
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
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
          />
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 px-1">
        <span className="font-mono text-[10px] text-muted">
          {formatTime(message.ts)}
        </span>
        {!isUser && !isPendingAssistant && message.content && (
          <button
            type="button"
            onClick={copy}
            className="font-mono text-[10px] text-muted hover:text-text"
          >
            {copied ? "copied" : "copy"}
          </button>
        )}
      </div>
    </div>
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
