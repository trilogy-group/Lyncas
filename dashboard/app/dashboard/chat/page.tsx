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
import { DevPodPanel } from "@/components/devpod-panel";
import { SandboxTestCard } from "@/components/sandbox-test-card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// /dashboard/chat — three-column repo chat workspace.
//
// Columns:
//   ┌─ 220px left ─┬─ flex chat ─────────────────────┬─ 280px right ─┐
//   │ repo picker  │ briefing + messages + composer  │ Repository    │
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

interface InstallStatusState {
  healthy: number;
  stale: number;
  installUrl: string | null;
  loaded: boolean;
}

interface DirectoryTreeState {
  repo: string;
  text: string | null;
  loading: boolean;
}

const MAX_INPUT_CHARS = 2000;
const QUICK_ACTIONS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "Recent PRs", prompt: "Show me the open pull requests." },
  {
    label: "Recent activity",
    prompt:
      "Summarize recent activity (commits, PRs, contributors) in the last 30 days.",
  },
  { label: "Merge latest PR", prompt: "Merge the most recent open PR." },
  {
    label: "Show repo stats",
    prompt:
      "Show repository statistics: open PRs, contributors, languages.",
  },
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
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [briefing, setBriefing] = useState<BriefingState | null>(null);
  const [roomTransition, setRoomTransition] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const [stats, setStats] = useState<RepoStatsState | null>(null);
  const [research, setResearch] = useState<ResearchState | null>(null);

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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const briefingAbortRef = useRef<AbortController | null>(null);
  const statsAbortRef = useRef<AbortController | null>(null);
  const researchAbortRef = useRef<AbortController | null>(null);

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
      abortRef.current?.abort();
      briefingAbortRef.current?.abort();
      statsAbortRef.current?.abort();
      researchAbortRef.current?.abort();
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
  // Hit /api/repo-tree which calls GitHub's /contents endpoint server-
  // side. This replaces the old behaviour that pulled
  // repo_rules.repo_directory_tree (a per-PR snapshot that frequently
  // contained nothing more than "./" when the most recent reviewed PR
  // touched only root files).
  useEffect(() => {
    if (!selectedRepo) {
      setTree(null);
      return;
    }
    const ac = new AbortController();
    setTree({ repo: selectedRepo, text: null, loading: true });
    void (async () => {
      try {
        const res = await fetch(
          `/api/repo-tree?repo=${encodeURIComponent(selectedRepo)}`,
          { signal: ac.signal },
        );
        let text: string | null = null;
        if (res.ok) {
          const body = (await res.json()) as { tree?: string | null };
          text = body.tree ?? null;
        }
        if (ac.signal.aborted) return;
        setTree({ repo: selectedRepo, text, loading: false });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setTree({ repo: selectedRepo, text: null, loading: false });
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

  // --- render: loading ----------------------------------------------------
  if (loading) {
    return (
      <Container className="py-10">
        <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
      </Container>
    );
  }

  const hasRepo = !!selectedRepo;

  // --- render: main 3-col layout ------------------------------------------
  return (
    <Container size="wide" className="py-6">
      <div className="flex flex-col gap-4 md:flex-row md:gap-4 md:h-[calc(100vh-7rem)] md:min-h-[560px]">
        {/* === LEFT: repo dropdown + quick actions === */}
        <aside className="hidden w-full shrink-0 flex-col gap-4 overflow-y-auto pr-1 md:flex md:w-[220px]">
          <Card className="p-3" flush>
            <div className="px-1 pb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
              Active room
            </div>
            <RepoDropdown
              repos={repos}
              value={selectedRepo}
              onChange={setSelectedRepo}
              disabled={isStreaming}
              installUrl={installStatus.installUrl}
              onInstallClick={() => setShowInstallModal(true)}
            />
          </Card>

          <ProjectStructureCard
            tree={tree}
            hasRepo={hasRepo}
            open={treePanelOpen}
            onToggle={() => setTreePanelOpen((v) => !v)}
          />

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
                <RepoDropdown
                  repos={repos}
                  value={selectedRepo}
                  onChange={setSelectedRepo}
                  disabled={isStreaming}
                  installUrl={installStatus.installUrl}
                  onInstallClick={() => setShowInstallModal(true)}
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
                activePrNumber !== null && (
                  <SandboxTestCard
                    repo={selectedRepo}
                    prNumber={activePrNumber}
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

      {showInstallModal && (
        <InstallAppModal
          installUrl={installStatus.installUrl}
          installError={installError}
          onClose={() => setShowInstallModal(false)}
        />
      )}
    </Container>
  );
}

// =========================================================================
// Repo dropdown — left-sidebar picker (also reused on mobile).
// =========================================================================

function RepoDropdown({
  repos,
  value,
  onChange,
  disabled,
  installUrl,
  onInstallClick,
}: {
  repos: WatchedRepoLite[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  installUrl: string | null;
  onInstallClick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape. We attach the listener only while
  // open so we don't run a no-op handler on every render of the page.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const empty = repos.length === 0;
  // Show only the repo name (everything after the last "/") to keep
  // the dropdown readable in a 220px sidebar. Full owner/name is in
  // the tooltip + the chat header for context.
  function shortName(full: string): string {
    const slash = full.lastIndexOf("/");
    return slash >= 0 ? full.slice(slash + 1) : full;
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
        onClick={() => !disabled && !empty && setOpen((v) => !v)}
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
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="currentColor"
          className={"shrink-0 text-muted transition-transform " + (open ? "rotate-180" : "")}
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
          className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-sm border border-border bg-bg shadow-lg"
        >
          {repos.map((r) => {
            const active = r.repo === value;
            return (
              <button
                key={r.repo}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(r.repo);
                  setOpen(false);
                }}
                className={
                  "flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors " +
                  (active
                    ? "bg-bg-elev text-text"
                    : "text-muted hover:bg-bg-elev hover:text-text")
                }
                title={r.repo}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={repoAvatarUrl(r.repo)}
                  alt=""
                  className="h-5 w-5 shrink-0 rounded-full border border-border bg-card"
                />
                <span className="truncate font-mono">{shortName(r.repo)}</span>
                {active && (
                  <span className="ml-auto text-[9px] font-mono uppercase tracking-[0.14em] text-muted">
                    active
                  </span>
                )}
              </button>
            );
          })}
          {installUrl && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onInstallClick();
              }}
              className="block w-full border-t border-border px-2.5 py-2 text-left text-xs text-muted hover:bg-bg-elev hover:text-text"
            >
              + Add more via GitHub App
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

function ProjectStructureCard({
  tree,
  hasRepo,
  open,
  onToggle,
}: {
  tree: DirectoryTreeState | null;
  hasRepo: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const empty = !hasRepo;
  const ready = !!(tree && !tree.loading && tree.text && tree.text.trim());
  const lineCount = ready ? (tree!.text as string).split("\n").length : 0;
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
          <span className="font-mono text-[9px] text-muted">
            {lineCount} line{lineCount === 1 ? "" : "s"}
          </span>
        )}
      </button>
      {open && (
        <div className="p-2 text-[11px]">
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
            <pre className="max-h-72 overflow-auto whitespace-pre rounded-sm bg-bg-elev px-2 py-2 font-mono text-[10.5px] leading-relaxed text-text">
              {tree!.text}
            </pre>
          ) : (
            <p className="px-1 py-2 text-[11px] text-muted">
              No tree yet — the agent will populate this when it runs
              its next review.
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
      {repoCount === 0 ? (
        <div className="space-y-2">
          <div className="text-base font-semibold">
            No repositories connected
          </div>
          <p className="max-w-sm text-xs text-muted">
            Install the Night PR Reviewer GitHub App and pick the repos you
            want reviewed. We&apos;ll bring you back here automatically.
          </p>
          <button
            type="button"
            onClick={onInstall}
            className="mt-1 inline-flex items-center gap-2 rounded-sm bg-white px-4 py-2 font-mono text-xs uppercase tracking-[0.14em] text-black hover:bg-white/90"
          >
            Install GitHub App →
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-base font-semibold">
            Select a repository to start
          </div>
          <p className="text-xs text-muted">
            Pick a room from the dropdown in the sidebar.
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
              Night PR Reviewer for GitHub
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
              Install the Night PR Reviewer GitHub App to start reading
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
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className={"flex flex-col " + (isUser ? "items-end" : "items-start")}
    >
      <div
        className={
          "max-w-[85%] rounded-md px-3.5 py-2.5 text-sm sm:max-w-[80%] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] " +
          (isUser
            ? "bg-white text-black"
            : "border border-border bg-bg-elev text-white")
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
            className="font-mono text-[10px] text-muted hover:text-white transition-colors"
          >
            {copied ? "copied" : "copy"}
          </button>
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
