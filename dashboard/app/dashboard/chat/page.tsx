"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// /dashboard/chat — multi-tenant repo chat with rooms + research briefings.
//
// Layout:
//   ┌─ 260px sidebar ────┬─ chat pane ──────────────────────────┐
//   │ repo list (rooms)  │ research briefing card (if any)      │
//   │ quick actions      │ messages…                            │
//   │                    │ ───────────────────────────────────  │
//   │                    │ textarea + Send                      │
//   └────────────────────┴──────────────────────────────────────┘
//
// On mobile (<768px) the sidebar collapses to a dropdown at the top of
// the chat pane. Quick actions move into a horizontal scroller below
// the dropdown.

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  // Stamped client-side when the message enters state. Used for the
  // HH:MM timestamp under each bubble. Not persisted.
  ts: number;
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

const MAX_INPUT_CHARS = 2000;
const QUICK_ACTIONS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "Show open PRs", prompt: "Show me the open pull requests." },
  { label: "Show all branches", prompt: "List all branches in this repo." },
  {
    label: "Review latest PR",
    prompt:
      "Review the most recent open pull request — give verdict, severity, and the top issues.",
  },
  {
    label: "Show recent activity",
    prompt: "What's the recent commit activity look like?",
  },
  {
    label: "Show collaborators",
    prompt: "Who are the collaborators on this repo?",
  },
  {
    label: "Merge latest PR",
    prompt:
      "Merge the most recent open pull request. (You should ask me to confirm first.)",
  },
  { label: "Show repo stats", prompt: "Show me an overview of repo stats." },
];

// Very small markdown subset — bold, italic, inline code, fenced code,
// bullet lists, headings, and paragraphs. We deliberately do NOT pull in
// react-markdown (project rule: no new packages). Everything is
// HTML-escaped first so the markdown transforms apply to escaped text —
// dangerouslySetInnerHTML is safe because no raw HTML can survive escape.
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
    // ### / ## headings — handy for the research briefing layout.
    const h3 = /^\s*###\s+(.+)$/.exec(line);
    const h2 = /^\s*##\s+(.+)$/.exec(line);
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

export default function ChatPage() {
  const router = useRouter();
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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const briefingAbortRef = useRef<AbortController | null>(null);

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
        const rows = (data ?? []) as WatchedRepoLite[];
        setRepos(rows);
        setSelectedRepo(rows[0]?.repo ?? "");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      briefingAbortRef.current?.abort();
    };
  }, [router, supabase]);

  // Auto-scroll the message list as new tokens arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, briefing]);

  // Fetch the research briefing whenever the selected repo changes (and
  // when the page first loads with a repo). We keep the briefing scoped
  // per-repo: switching away clears it; switching back re-fetches.
  const fetchBriefing = useCallback(
    async (repo: string) => {
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
            // The message is the literal trigger for keyword routing,
            // but the briefing flag overrides classification entirely
            // server-side. Still, we send a clear text so logs stay
            // readable.
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
            b && b.repo === repo
              ? { ...b, loading: false, error: detail }
              : b,
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
            const line = frame.startsWith("data: ")
              ? frame.slice(6)
              : frame;
            if (!line) continue;
            if (line === "[DONE]") {
              reader.cancel();
              setBriefing((b) =>
                b && b.repo === repo
                  ? { ...b, content, loading: false }
                  : b,
              );
              return;
            }
            content += line;
            setBriefing((b) =>
              b && b.repo === repo ? { ...b, content } : b,
            );
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
    },
    [],
  );

  // Room enter — clear messages, show transition state, then trigger
  // the briefing fetch. The 500ms delay is a deliberate UX beat so the
  // sidebar selection feels like "entering a room" rather than a noisy
  // re-render.
  useEffect(() => {
    if (!selectedRepo) return;
    abortRef.current?.abort();
    setMessages([]);
    setRoomTransition(true);
    setGlobalError(null);
    const t = setTimeout(() => {
      setRoomTransition(false);
      void fetchBriefing(selectedRepo);
    }, 500);
    return () => clearTimeout(t);
  }, [selectedRepo, fetchBriefing]);

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
    const history = messages.slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    }));
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

  if (loading) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <Card className="p-10 text-center text-muted text-sm">Loading…</Card>
      </main>
    );
  }

  if (repos.length === 0) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-10">
        <Card className="p-8 space-y-4 text-center">
          <h1 className="text-lg font-semibold">No repos to chat with yet</h1>
          <p className="text-sm text-muted">
            Connect a repository and the chat will be able to answer
            questions about its PRs, branches, and activity — and act on
            your behalf (close, comment, merge).
          </p>
          <Link
            href="/dashboard/connect-repo"
            className="inline-block px-4 py-2 rounded-md text-sm font-medium text-white"
            style={{ backgroundColor: "#4338ca" }}
          >
            Connect a repository →
          </Link>
        </Card>
      </main>
    );
  }

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
      <div className="flex flex-col md:flex-row gap-4 md:gap-6 md:h-[calc(100vh-7rem)] md:min-h-[520px]">
        {/* Sidebar — full repo list with avatars + quick actions.
            Hidden on mobile; a dropdown picker takes its place inside
            the chat pane (see below). */}
        <aside className="w-full md:w-[260px] shrink-0 hidden md:flex flex-col gap-4 overflow-y-auto pr-1">
          <Card className="p-3">
            <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2 px-1">
              Repositories
            </div>
            <div className="flex flex-col gap-1">
              {repos.map((r) => {
                const active = r.repo === selectedRepo;
                return (
                  <button
                    key={r.repo}
                    type="button"
                    onClick={() => setSelectedRepo(r.repo)}
                    disabled={isStreaming}
                    className={
                      "flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs disabled:opacity-50 transition-colors " +
                      (active
                        ? "bg-bg border border-border"
                        : "hover:bg-bg border border-transparent")
                    }
                    title={r.repo}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={repoAvatarUrl(r.repo)}
                      alt=""
                      className="w-5 h-5 rounded-full bg-bg border border-border shrink-0"
                    />
                    <span className="font-mono truncate">{r.repo}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card className="p-3 space-y-2">
            <div className="text-[11px] font-medium text-muted uppercase tracking-wider px-1">
              Quick actions
            </div>
            <div className="flex flex-col gap-1.5">
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => void send(q.prompt)}
                  disabled={isStreaming}
                  className="text-left text-xs px-2.5 py-1.5 rounded-md border border-border bg-card hover:bg-bg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {q.label}
                </button>
              ))}
            </div>
          </Card>
        </aside>

        {/* Chat pane */}
        <section className="flex-1 min-w-0">
          <Card className="h-full flex flex-col p-0 overflow-hidden">
            <header className="px-4 sm:px-5 py-3 border-b border-border flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {selectedRepo && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={repoAvatarUrl(selectedRepo)}
                    alt=""
                    className="w-7 h-7 rounded-full bg-bg border border-border shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">
                    {selectedRepo
                      ? `#${selectedRepo.split("/")[1] ?? selectedRepo}`
                      : "Chat"}
                  </div>
                  <div className="text-[11px] font-mono text-muted truncate">
                    {selectedRepo || "no repo selected"}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={clearChat}
                disabled={messages.length === 0 && !isStreaming}
                className="text-xs text-muted hover:text-text border border-border rounded-md px-2 py-1 disabled:opacity-40"
              >
                Clear
              </button>
            </header>

            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-3"
            >
              {/* Mobile-only repo picker + quick actions */}
              <div className="md:hidden mb-2 space-y-2">
                <select
                  value={selectedRepo}
                  onChange={(e) => setSelectedRepo(e.target.value)}
                  disabled={isStreaming}
                  className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                >
                  {repos.map((r) => (
                    <option key={r.repo} value={r.repo}>
                      {r.repo}
                    </option>
                  ))}
                </select>
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {QUICK_ACTIONS.map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      onClick={() => void send(q.prompt)}
                      disabled={isStreaming}
                      className="shrink-0 text-xs px-2.5 py-1 rounded-md border border-border bg-card hover:bg-bg disabled:opacity-50 whitespace-nowrap"
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>

              {globalError && (
                <div className="px-3 py-2 rounded-md text-xs border border-amber-300 bg-amber-50 text-amber-800">
                  {globalError}
                </div>
              )}

              {roomTransition && (
                <div className="text-center text-muted text-xs py-6 italic">
                  Entering #{selectedRepo.split("/")[1] ?? selectedRepo}{" "}
                  room…
                </div>
              )}

              {!roomTransition &&
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

              {!roomTransition && messages.length === 0 && !briefing && (
                <div className="text-center py-12 space-y-2">
                  <div className="text-3xl">{selectedRepo ? "💬" : "📁"}</div>
                  <div className="text-sm text-muted">
                    {selectedRepo
                      ? `Ask anything about ${selectedRepo}`
                      : "Select a repository from the sidebar to start chatting"}
                  </div>
                </div>
              )}

              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  isStreaming={isStreaming}
                />
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="border-t border-border px-3 py-2 flex items-end gap-2 bg-card"
            >
              <div className="flex-1 flex flex-col gap-1">
                <textarea
                  value={input}
                  onChange={(e) =>
                    setInput(e.target.value.slice(0, MAX_INPUT_CHARS))
                  }
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isStreaming
                      ? "Waiting for response…"
                      : "Ask, review, or say 'close pr 42' / 'merge pr 7'…"
                  }
                  rows={1}
                  disabled={isStreaming}
                  className="resize-none bg-bg border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-60 max-h-32"
                  style={{ minHeight: 38 }}
                />
                <div className="flex items-center justify-end text-[10px] font-mono text-muted">
                  <span
                    className={
                      input.length >= MAX_INPUT_CHARS - 50
                        ? "text-amber-600"
                        : ""
                    }
                  >
                    {input.length}/{MAX_INPUT_CHARS}
                  </span>
                </div>
              </div>
              <button
                type="submit"
                disabled={isStreaming || !input.trim()}
                className="px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50 self-start"
                style={{ backgroundColor: "#4338ca" }}
              >
                {isStreaming ? "…" : "Send"}
              </button>
            </form>
          </Card>
        </section>
      </div>

      <style jsx global>{`
        .md-content p {
          margin: 0 0 0.5rem 0;
        }
        .md-content p:last-child {
          margin-bottom: 0;
        }
        .md-content .md-list {
          list-style: disc;
          padding-left: 1.25rem;
          margin: 0.25rem 0 0.5rem 0;
        }
        .md-content .md-list li {
          margin: 0.15rem 0;
        }
        .md-content .md-h3 {
          font-size: 0.85rem;
          font-weight: 600;
          margin: 0.6rem 0 0.3rem 0;
          color: var(--text);
        }
        .md-content .md-h2 {
          font-size: 0.95rem;
          font-weight: 600;
          margin: 0.8rem 0 0.4rem 0;
          color: var(--text);
        }
        .md-content .inline-code {
          background: rgba(127, 127, 127, 0.15);
          padding: 0.05rem 0.3rem;
          border-radius: 0.25rem;
          font-size: 0.85em;
        }
        .md-content .code-block {
          background: rgba(127, 127, 127, 0.1);
          border: 1px solid var(--border);
          border-radius: 0.375rem;
          padding: 0.6rem 0.75rem;
          margin: 0.4rem 0;
          font-size: 0.8rem;
          overflow-x: auto;
          white-space: pre;
        }
        .md-content strong {
          font-weight: 600;
        }
      `}</style>
    </main>
  );
}

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
      // ignore — Safari permission denied, etc.
    }
  }
  return (
    <div
      className="rounded-lg border-l-4 border border-border bg-card overflow-hidden"
      style={{ borderLeftColor: "#2563eb" }}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-blue-50/60 dark:bg-blue-950/20">
        <div className="flex items-center gap-2">
          <span className="text-base" aria-hidden>
            📚
          </span>
          <span className="text-xs font-semibold tracking-tight">
            Research briefing
          </span>
          <span className="text-[10px] text-muted font-mono">
            auto-generated on room enter
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            disabled={briefing.loading || !briefing.content}
            className="text-[11px] text-muted hover:text-text border border-border rounded px-2 py-0.5 disabled:opacity-40"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={briefing.loading}
            className="text-[11px] text-muted hover:text-text border border-border rounded px-2 py-0.5 disabled:opacity-40"
            title="Regenerate briefing"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="text-[11px] text-muted hover:text-text border border-border rounded px-2 py-0.5"
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
          <div className="text-amber-700 text-xs">
            Could not generate briefing: {briefing.error}
          </div>
        ) : (
          <div
            className="md-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(briefing.content) }}
          />
        )}
      </div>
    </div>
  );
}

function BriefingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-3 w-24 bg-border rounded" />
      <div className="space-y-1.5">
        <div className="h-2 w-full bg-border/70 rounded" />
        <div className="h-2 w-5/6 bg-border/70 rounded" />
      </div>
      <div className="h-3 w-32 bg-border rounded mt-3" />
      <div className="space-y-1.5">
        <div className="h-2 w-4/6 bg-border/70 rounded" />
        <div className="h-2 w-3/6 bg-border/70 rounded" />
      </div>
    </div>
  );
}

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
    <div
      className={
        "flex flex-col " + (isUser ? "items-end" : "items-start")
      }
    >
      <div
        className={
          "max-w-[85%] sm:max-w-[80%] rounded-lg px-3.5 py-2 text-sm " +
          (isUser
            ? "bg-[#4338ca] text-white"
            : "border border-border bg-card text-text")
        }
      >
        {isPendingAssistant ? (
          <TypingDots />
        ) : isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <div
            className="md-content break-words"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
          />
        )}
      </div>
      <div className="flex items-center gap-2 mt-1 px-1">
        <span className="text-[10px] font-mono text-muted">
          {formatTime(message.ts)}
        </span>
        {!isUser && !isPendingAssistant && message.content && (
          <button
            type="button"
            onClick={copy}
            className="text-[10px] text-muted hover:text-text"
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
