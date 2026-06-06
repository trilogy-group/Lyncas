import { NextResponse, type NextRequest } from "next/server";
import * as crypto from "crypto";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import type { RepoResearchArticle } from "@/lib/types";
import {
  getRepoFingerprintText,
  getRepoResearch,
  upsertRepoResearch,
} from "@/lib/queries";

// GET /api/repo-research?repo=owner/name[&force=true]
//
// Returns a list of suggested reading material for the chat page's
// right-sidebar Research panel.
//
// Caching:
//   * Cache key  = `repo`
//   * Cache hash = SHA-256 of the corresponding repo_fingerprints row.
//   * Hit  → fingerprint hash unchanged AND row exists AND not forced.
//   * Miss → ask Claude (Haiku — cost-sensitive endpoint) for fresh
//            suggestions, upsert, return.
//   * force=true bypasses the hash check unconditionally.
//
// When no fingerprint exists yet for this repo we still cache the row
// (so we don't re-ping Claude on every page view) and store
// fingerprint_hash=null — the NEXT fingerprint refresh will invalidate
// us automatically because the hash will differ.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RESEARCH_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1400;
const ARTICLE_COUNT = 5;

const RESEARCH_SYSTEM_PROMPT = `\
You are a product-minded engineer briefing a developer on the SPECIFIC application in a repository — not its generic tech stack.

You are given a compact REPOSITORY SUMMARY (purpose, stack, directories). First work out what this product actually IS and what it is FOR (its domain, its users, the problem it solves). Then suggest research that would help someone improve or extend THIS product.

Reply with ONLY a JSON object (no prose, no markdown fences) of this exact shape:

  {
    "summary": string,
    "articles": [ { "title": string, "url": string, "source": string, "description": string }, ... ]
  }

"summary":
  * 2-3 sentences, plain English, describing what this application is, who it's for, and the kind of problem it solves. Be concrete and specific to THIS repo (e.g. "An AI résumé builder that turns a user's work history into tailored, ATS-friendly résumés"), never generic ("a web application built with Next.js").
  * If the repo's purpose is genuinely unclear from the summary, say what it most likely is in one sentence and note the uncertainty.

"articles": exactly ${ARTICLE_COUNT} entries. Each is research aimed at the product's DOMAIN and FEATURES, not its boilerplate:
  * Prioritise: domain concepts, techniques/algorithms relevant to the product, specialised libraries/APIs/models for its problem space, UX patterns for its feature set, and concrete feature ideas with prior art. (For an AI résumé builder: ATS parsing, résumé scoring, prompt patterns for tailoring text, PDF generation, relevant datasets — NOT "the Next.js docs".)
  * AVOID generic framework/language documentation (Next.js, React, MDN, Python docs, "intro to TypeScript") UNLESS a feature genuinely hinges on a non-obvious capability of that tool. Assume the developer already knows their stack.
  * url MUST be a real URL you are confident exists (official docs of a specialised tool, well-known engineering blog posts, papers/arXiv, GitHub repos, RFCs). Do NOT invent URLs. If unsure of a deep link, point at a stable root rather than fabricate one.
  * source is a short readable name like "arXiv", "Stripe Docs", "GitHub", "Smashing Magazine", "Anthropic". Not a domain.
  * description is ONE sentence (max ~140 chars) explaining how it helps build or improve a feature of THIS product.
  * title is concise (max ~80 chars).

Return only the JSON object, starting with { and ending with }.`;

function hashFingerprint(text: string | null): string | null {
  if (!text) return null;
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sanitizeArticles(raw: unknown): RepoResearchArticle[] {
  if (!Array.isArray(raw)) return [];
  const out: RepoResearchArticle[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === "string" ? e.title.trim() : "";
    const url = typeof e.url === "string" ? e.url.trim() : "";
    const source = typeof e.source === "string" ? e.source.trim() : "";
    const description =
      typeof e.description === "string" ? e.description.trim() : "";
    if (!title || !url || !source) continue;
    // Cheap URL shape validation. We don't fetch the URL — even fully
    // valid URLs sometimes 404. The point is to reject obvious junk
    // (Claude hallucinating "see the docs" with no protocol).
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    } catch {
      continue;
    }
    out.push({ title, url, source, description });
    if (out.length >= ARTICLE_COUNT) break;
  }
  return out;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

interface ResearchResult {
  summary: string;
  articles: RepoResearchArticle[];
}

function sanitizeSummary(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Collapse whitespace and cap length so a runaway generation can't
  // bloat the cached row or the sidebar.
  return raw.replace(/\s+/g, " ").trim().slice(0, 600);
}

async function generateResearch(
  fingerprintText: string | null,
  repo: string,
  apiKey: string,
): Promise<ResearchResult> {
  // Prefer the real fingerprint summary; if we don't have one yet,
  // ship the bare repo slug so Claude can at least pattern-match the
  // owner/name. Both produce useful (if generic) suggestions.
  const summary =
    (fingerprintText && fingerprintText.trim()) ||
    `Repository slug: ${repo}. No detailed fingerprint available yet — infer what the product most likely is from the owner/name and suggest domain/feature research for that, noting the uncertainty.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: RESEARCH_MODEL,
      max_tokens: MAX_TOKENS,
      system: RESEARCH_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `REPOSITORY SUMMARY:\n${summary}\n\nReply with the JSON array now.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as AnthropicResponse;
      if (j.error?.message) detail = j.error.message;
    } catch {
      // non-json
    }
    throw new Error(`Anthropic ${detail}`);
  }

  const body = (await res.json()) as AnthropicResponse;
  const text = body.content?.find((c) => c.type === "text")?.text ?? "";
  // Claude sometimes wraps JSON in code fences despite instructions.
  // Tolerate ```json … ``` and ``` … ``` by stripping the outermost
  // pair before parsing.
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNL = cleaned.indexOf("\n");
    if (firstNL !== -1) cleaned = cleaned.slice(firstNL + 1);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();
  }
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    // New shape: { summary, articles }. Tolerate a bare array (old
    // shape / model regression) by treating it as articles-only.
    if (Array.isArray(parsed)) {
      return { summary: "", articles: sanitizeArticles(parsed) };
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        summary: sanitizeSummary(obj.summary),
        articles: sanitizeArticles(obj.articles),
      };
    }
    return { summary: "", articles: [] };
  } catch {
    return { summary: "", articles: [] };
  }
}

export async function GET(request: NextRequest) {
  const user = await getUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const repo = request.nextUrl.searchParams.get("repo")?.trim() ?? "";
  const force = request.nextUrl.searchParams.get("force") === "true";
  if (!repo || !REPO_PATTERN.test(repo)) {
    return NextResponse.json(
      { error: "`repo` must look like owner/name" },
      { status: 400 },
    );
  }

  // AuthZ — must be a connected repo.
  const supabase = await createSupabaseServerClient();
  const { data: ownership } = await supabase
    .from("watched_repos")
    .select("id")
    .eq("repo", repo)
    .maybeSingle();
  if (!ownership) {
    return NextResponse.json(
      { error: "Repository not connected" },
      { status: 403 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on this deploy" },
      { status: 503 },
    );
  }

  const fingerprint = await getRepoFingerprintText(repo);
  const currentHash = hashFingerprint(fingerprint);

  if (!force) {
    const cached = await getRepoResearch(repo);
    if (
      cached &&
      cached.articles.length > 0 &&
      cached.fingerprint_hash === currentHash
    ) {
      return NextResponse.json({
        repo,
        summary: cached.summary ?? "",
        articles: cached.articles,
        updated_at: cached.updated_at,
        cache: "hit",
      });
    }
  }

  let result: ResearchResult = { summary: "", articles: [] };
  try {
    result = await generateResearch(fingerprint, repo, apiKey);
  } catch (e) {
    // Hard failure on Claude side — surface a 502 so the UI can show
    // the "could not generate" state, but don't persist garbage.
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502 },
    );
  }

  // Even on an empty articles array we cache (with fingerprint_hash =
  // currentHash) — that way we won't re-burn Claude tokens on every
  // page view for a repo whose fingerprint genuinely produces nothing
  // good. A future fingerprint change will invalidate naturally.
  try {
    await upsertRepoResearch(repo, result.articles, currentHash, result.summary);
  } catch {
    // Cache write failed — return the live result anyway so the UI
    // isn't blocked.
  }

  return NextResponse.json({
    repo,
    summary: result.summary,
    articles: result.articles,
    updated_at: new Date().toISOString(),
    cache: force ? "forced" : "miss",
  });
}
