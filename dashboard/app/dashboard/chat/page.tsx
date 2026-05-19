"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// /dashboard/chat — streaming chat against a single connected repo.
//
// Layout:
//   ┌─ 260px sidebar ────┬─ chat pane ──────────────────────────┐
//   │ repo picker        │ messages…                            │
//   │ quick actions      │ ───────────────────────────────────  │
//   │                    │ textarea + Send                      │
//   └────────────────────┴──────────────────────────────────────┘
//
// State is intentionally minimal: useState for everything, no
// Context / Redux / SWR. Streaming uses native fetch + ReadableStream
// reading a `text/event-stream` body from /api/chat. Each `data:` line
// is appended to the in-flight assistant message; an empty `data: [DONE]`
// frame terminates the stream.
//
// The page is render-blocked on watched_repos so the picker can default
// to the user's first repo. While loading we render a spinner card so
// the chrome doesn't pop in mid-conversation.

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface WatchedRepoLite {
  repo: string;
}

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
];

// Very small markdown subset — bold, italic, inline code, fenced code,
// bullet lists, and paragraphs. We deliberately do NOT pull in
// react-markdown (the project rule is "no new packages") but we also
// don't want to render raw ** characters in the chat. Everything is
// HTML-escaped first, so the markdown transforms apply to the escaped
// string — dangerouslySetInnerHTML is safe here because no original
// HTML can survive the escape.
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
  // Fenced code blocks first — they take precedence over inline rules.
  s = s.replace(/```([\s\S]*?)```/g, (_m, body: string) => {
    return `<pre class="code-block"><code>${body.replace(/^\n/, "")}</code></pre>`;
  });
  // Inline code.
  s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  // Bold + italic. Order matters: bold (** **) before italic (* *).
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Bullet lists. Lines starting with "- " or "* " become <li>s,
  // grouped into a single <ul>. Process line-by-line.
  const lines = s.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
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
  // Paragraph-break on double newlines, single newlines become <br>.
  return out
    .join("\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, "<br/>"))
    .map((p) => (p.trim() ? `<p>${p}</p>` : ""))
    .join("");
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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    };
  }, [router, supabase]);

  // Auto-scroll the message list as new tokens arrive. We scroll the
  // inner div, not the window, because the chat pane has its own
  // scrolling region.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(rawPrompt: string) {
    const prompt = rawPrompt.trim();
    if (!prompt || isStreaming || !selectedRepo) return;

    const userId = crypto.randomUUID();
    const asstId = crypto.randomUUID();
    const userMsg: ChatMessage = { id: userId, role: "user", content: prompt };
    const placeholder: ChatMessage = {
      id: asstId,
      role: "assistant",
      content: "",
    };
    // Snapshot the last 10 messages BEFORE we add the new user message,
    // so the history we send is exactly what the assistant has seen so
    // far. The new user prompt rides in its own `message` field.
    const history = messages.slice(-10);
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
          // non-json body — leave detail as the status code
        }
        appendToAssistant(asstId, `**Error.** ${detail}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // SSE wire format: `data: <chunk>\n\n` repeated, terminated by
      // `data: [DONE]\n\n`. We split on \n\n and forward `data:` lines.
      // The server only emits `data: <delta>` and `data: [DONE]`; no
      // other event types.
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
          // The server may emit `data: {"error":"…"}` for streamed
          // failures. Treat that as an inline assistant message tagged
          // with a clear marker rather than crashing the stream.
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
    // Enter -> send, Shift+Enter -> newline. matches the conventional
    // chat-app UX so muscle memory carries over from ChatGPT/Claude.
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
            questions about its PRs, branches, and activity.
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
      <div className="flex gap-6 h-[calc(100vh-7rem)] min-h-[520px]">
        {/* Sidebar */}
        <aside className="w-[260px] shrink-0 hidden md:flex flex-col gap-4">
          <Card className="p-4 space-y-3">
            <div>
              <label
                htmlFor="repo-select"
                className="block text-xs font-medium text-muted mb-1.5"
              >
                Repository
              </label>
              <select
                id="repo-select"
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value)}
                disabled={isStreaming}
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-60"
              >
                {repos.map((r) => (
                  <option key={r.repo} value={r.repo}>
                    {r.repo}
                  </option>
                ))}
              </select>
            </div>
          </Card>

          <Card className="p-4 space-y-2">
            <div className="text-xs font-medium text-muted mb-1">
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
            <header className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">Chat</div>
                <div className="text-[11px] font-mono text-muted truncate">
                  {selectedRepo || "no repo selected"}
                </div>
              </div>
              <button
                type="button"
                onClick={clearChat}
                disabled={messages.length === 0 && !isStreaming}
                className="text-xs text-muted hover:text-text border border-border rounded-md px-2 py-1 disabled:opacity-40"
              >
                Clear chat
              </button>
            </header>

            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-5 py-4 space-y-3"
            >
              {/* Mobile-only repo picker — duplicates the sidebar select
                  so the page works under 768px without horizontal scroll. */}
              <div className="md:hidden mb-2">
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
              </div>

              {messages.length === 0 && (
                <div className="text-center text-muted text-sm py-12">
                  Ask anything about{" "}
                  <span className="font-mono">{selectedRepo}</span> — open PRs,
                  branches, collaborators, recent commits, or ask for a review.
                </div>
              )}

              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} isStreaming={isStreaming} />
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="border-t border-border px-3 py-2 flex items-end gap-2 bg-card"
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  isStreaming
                    ? "Waiting for response…"
                    : "Ask about open PRs, branches, or paste a PR number to review…"
                }
                rows={1}
                disabled={isStreaming}
                className="flex-1 resize-none bg-bg border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-60 max-h-32"
                style={{ minHeight: 38 }}
              />
              <button
                type="submit"
                disabled={isStreaming || !input.trim()}
                className="px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: "#4338ca" }}
              >
                {isStreaming ? "…" : "Send"}
              </button>
            </form>
          </Card>
        </section>
      </div>

      {/* Inline styles for markdown output. Scoped via a class so the
          rules don't bleed into the rest of the dashboard. */}
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

  return (
    <div
      className={
        "flex " + (isUser ? "justify-end" : "justify-start")
      }
    >
      <div
        className={
          "max-w-[80%] rounded-lg px-3.5 py-2 text-sm " +
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
