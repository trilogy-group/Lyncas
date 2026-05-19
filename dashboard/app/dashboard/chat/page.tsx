"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// /dashboard/chat — multi-tenant repo chat with rooms + research briefings.
//
// Post-v3 redesign:
//   * dark-mode chrome to match the rest of the app
//   * the "Quick actions" rail and the in-line floating-chat launcher
//     were both removed per product brief (was: 7 canned prompts +
//     a fixed bottom-right launcher on /dashboard/overview)
//   * Send button styled as the primary CTA (white-on-black)
//
// Layout:
//   ┌─ 260px sidebar ────┬─ chat pane ──────────────────────────┐
//   │ repo list (rooms)  │ research briefing card (if any)      │
//   │                    │ messages…                            │
//   │                    │ ───────────────────────────────────  │
//   │                    │ textarea + Send                      │
//   └────────────────────┴──────────────────────────────────────┘
//
// On mobile (<768px) the sidebar collapses to a dropdown at the top of
// the chat pane.

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
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

// Tiny markdown subset — bold, italic, inline code, fenced code,
// bullet lists, headings, paragraphs. No react-markdown.
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
  }, []);

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

  return (
    <Container className="py-6">
      <div className="flex flex-col gap-4 md:flex-row md:gap-6 md:h-[calc(100vh-7rem)] md:min-h-[560px]">
        {/* Sidebar — repo list as rooms. */}
        <aside className="hidden w-full shrink-0 flex-col gap-4 overflow-y-auto pr-1 md:flex md:w-[260px]">
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

          <Card className="p-4">
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
              Tips
            </div>
            <ul className="mt-2 space-y-1.5 text-xs text-muted leading-relaxed">
              <li>Press Enter to send.</li>
              <li>Shift+Enter for a new line.</li>
              <li>Briefings refresh on room enter.</li>
            </ul>
          </Card>
        </aside>

        {/* Chat pane */}
        <section className="min-w-0 flex-1">
          <Card flush className="flex h-full flex-col overflow-hidden">
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                {selectedRepo && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={repoAvatarUrl(selectedRepo)}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded-full border border-border bg-card"
                  />
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {selectedRepo
                      ? `#${selectedRepo.split("/")[1] ?? selectedRepo}`
                      : "Chat"}
                  </div>
                  <div className="truncate text-[11px] font-mono text-muted">
                    {selectedRepo || "no repo selected"}
                  </div>
                </div>
              </div>
              <Button
                size="sm"
                variant="default"
                onClick={clearChat}
                disabled={messages.length === 0 && !isStreaming}
              >
                Clear
              </Button>
            </header>

            <div
              ref={scrollRef}
              className="flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5"
            >
              {/* Mobile-only repo picker */}
              <div className="md:hidden mb-2">
                <select
                  value={selectedRepo}
                  onChange={(e) => setSelectedRepo(e.target.value)}
                  disabled={isStreaming}
                  className="w-full bg-bg border border-border rounded-sm px-2 py-1.5 text-xs font-mono"
                >
                  {repos.map((r) => (
                    <option key={r.repo} value={r.repo}>
                      {r.repo}
                    </option>
                  ))}
                </select>
              </div>

              {globalError && (
                <div className="rounded-sm border border-[#ff9d4d]/40 bg-[#ff9d4d]/10 px-3 py-2 text-xs text-[#ff9d4d]">
                  {globalError}
                </div>
              )}

              {roomTransition && (
                <div className="py-6 text-center text-xs italic text-muted">
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
                <div className="space-y-3 py-12 text-center">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
                    {selectedRepo ? "Ready" : "Select a room"}
                  </div>
                  <div className="text-sm text-muted">
                    {selectedRepo
                      ? `Ask anything about ${selectedRepo}.`
                      : "Pick a repository from the sidebar to start chatting."}
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
                    isStreaming
                      ? "Waiting for response…"
                      : "Ask, review, or say 'close pr 42' / 'merge pr 7'…"
                  }
                  rows={1}
                  disabled={isStreaming}
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
                disabled={isStreaming || !input.trim()}
                className="self-start"
              >
                {isStreaming ? "…" : "Send"}
              </Button>
            </form>
          </Card>
        </section>
      </div>
    </Container>
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
            dangerouslySetInnerHTML={{ __html: renderMarkdown(briefing.content) }}
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
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
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
