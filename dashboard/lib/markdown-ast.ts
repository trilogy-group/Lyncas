// Markdown AST.
//
// Single source of truth for the markdown subset Claude's prompt in
// agent/report_generator.py actually emits. Two consumers ride on
// top of this AST:
//
//   * lib/markdown.tsx        — React renderer for in-app display.
//   * lib/docx-report.ts      — docx exporter for the "Download
//                               Report" buttons on the reports page
//                               and the chat sandbox card's modal.
//
// Why a shared AST instead of duplicated parsers in each consumer:
// the original implementation had the React renderer's block scan
// interleaved with JSX construction (~250 lines), and adding a
// second consumer would have meant 150-200 lines of duplicated
// parsing logic — including the subtle bits (pipe-table separator
// row detection, double-`*` bold vs single-`*` italic, code-fence
// vs paragraph priority). With a shared AST, a future change to
// the supported syntax — say, adding nested lists — only has to
// land in one place, and both renderers stay in sync by
// construction.
//
// Supported subset (what the agent's prompt produces, intersected
// with what we can faithfully render in both React and OOXML):
//
//   * ATX headings (1-6, but only 1-4 are visually distinguished).
//   * Paragraphs.
//   * Bold (**text**), italic (*text* / _text_), inline code
//     (`code`), links ([label](url)), bare http(s) URLs.
//   * Fenced code blocks (``` optionally with a language tag).
//   * Bullet lists (- / *) and numbered lists (1. 2.).
//   * Pipe tables — requires a separator row of dashes
//     immediately under the header. A pipe-prose line without a
//     separator falls through to paragraph rendering.
//   * Blockquotes (> ).
//   * Horizontal rules (--- on its own line).
//
// Deliberately NOT supported (and not produced by the agent
// prompt): nested lists, reference-style links, footnotes, HTML
// pass-through, strikethrough. The grammar is "what report_markdown
// emits", not "all of CommonMark".

// --- Inline AST ----------------------------------------------------------

// Inline nodes are flat — we do not nest formatting (e.g. bold
// inside italic). The order of inline passes in parseInline()
// approximates the precedence a reader would expect: code wins
// over bold wins over italic wins over links. That matches the
// agent's report bodies, which never have mixed-format inline
// runs in practice (Claude either says "**bold**" or "*italic*"
// for a given span, not "**bold italic**" in a single emit).

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "link"; href: string; text: string };

// --- Block AST -----------------------------------------------------------

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: string }
  | { type: "paragraph"; content: string }
  | { type: "blockquote"; content: string }
  | { type: "code_block"; lang: string; content: string }
  | { type: "hr" }
  | { type: "bullet_list"; items: string[] }
  | { type: "numbered_list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

// --- Block parser --------------------------------------------------------

// Splits markdown source into blocks. Operates on already-normalized
// line endings (\r\n -> \n) and is otherwise position-free.
//
// Parsing precedence per line, in order:
//   1. Code fence -> consume until closing ```.
//   2. ATX heading.
//   3. Horizontal rule (--- and longer).
//   4. Blockquote start (> ).
//   5. Pipe table (only if the NEXT line is a separator row).
//   6. Bullet list start.
//   7. Numbered list start.
//   8. Blank lines absorbed.
//   9. Paragraph: anything else until the next blank line or
//      block-starter.
//
// Tables get priority over paragraph because pipe characters in
// prose are otherwise treated as plain text — the separator row
// check ensures we don't mis-classify "x | y might be" as a table.

export function parseBlocks(source: string): Block[] {
  const text = (source ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  // Helper used by paragraph collection — checks whether `line`
  // would start a different block, so the paragraph terminates.
  function startsBlock(line: string, next: string | undefined): boolean {
    if (line.startsWith("```")) return true;
    if (/^#{1,6}\s/.test(line)) return true;
    if (/^-{3,}\s*$/.test(line)) return true;
    if (line.startsWith("> ")) return true;
    if (/^[-*]\s+/.test(line)) return true;
    if (/^\d+\.\s+/.test(line)) return true;
    if (
      line.includes("|") &&
      next !== undefined &&
      /^\s*\|?\s*:?-{2,}/.test(next)
    ) {
      return true;
    }
    return false;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push({ type: "code_block", lang, content: buf.join("\n") });
      continue;
    }

    const hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hMatch) {
      const level = hMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, content: hMatch[2] });
      i++;
      continue;
    }

    if (/^-{3,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: "blockquote", content: buf.join(" ") });
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])
    ) {
      const splitRow = (row: string): string[] =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = splitRow(line);
      const rows: string[][] = [];
      i += 2; // skip header + separator
      while (
        i < lines.length &&
        lines[i].includes("|") &&
        lines[i].trim() !== ""
      ) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "bullet_list", items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "numbered_list", items });
      continue;
    }

    if (line.trim() === "") {
      while (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }

    // Paragraph: collect contiguous non-block lines.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !startsBlock(lines[i], lines[i + 1])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", content: buf.join(" ") });
  }

  return blocks;
}

// --- Inline parser -------------------------------------------------------

// Tokenizes an inline string into a flat list of InlineNodes.
//
// Algorithm: a single left-to-right scan with a precedence-ordered
// set of regex matchers. Whichever pattern matches earliest in the
// remaining input wins; ties broken by precedence order. The
// remainder before the match is emitted as a `text` node, then the
// match's content is wrapped in its semantic node and recursion
// resumes after the match.
//
// We do this iteratively (not recursively) because the nested
// case (bold containing italic etc.) isn't a thing in the agent's
// reports and would inflate the AST without payoff. If we ever
// need recursion, switch to a proper combinator parser; but
// premature recursion was a real source of bugs in the old
// React-bound inline pass, so this version stays flat by design.

interface InlinePattern {
  // The regex must use a capture group for the "inner" payload
  // (the bit that becomes the wrapped text), and may capture an
  // additional group for href in the link case.
  regex: RegExp;
  build: (match: RegExpExecArray) => InlineNode | null;
}

// Order = precedence. Code first so we don't bold inside `code`;
// bold before italic so `**foo*bar**` isn't parsed as italic-italic;
// explicit-href links before bare URLs so `[GitHub](url)` isn't
// double-linked.
const PATTERNS: InlinePattern[] = [
  {
    regex: /`([^`]+)`/g,
    build: (m) => ({ type: "code", text: m[1] }),
  },
  {
    regex: /\*\*([^*]+)\*\*/g,
    build: (m) => ({ type: "bold", text: m[1] }),
  },
  {
    regex: /(?<![*_])\*([^*]+)\*(?!\*)/g,
    build: (m) => ({ type: "italic", text: m[1] }),
  },
  {
    regex: /(?<![_*])_([^_]+)_(?!_)/g,
    build: (m) => ({ type: "italic", text: m[1] }),
  },
  {
    regex: /\[([^\]]+)\]\(([^)\s]+)\)/g,
    build: (m) => {
      // Defensive: drop javascript: URLs. The renderer falls back
      // to plain text rather than emitting a clickable link. We
      // mirror this in lib/markdown.tsx; both sides need to agree.
      if (m[2].startsWith("javascript:")) {
        return { type: "text", text: m[1] };
      }
      return { type: "link", href: m[2], text: m[1] };
    },
  },
  {
    // Bare URLs. The lookbehind keeps us from re-matching inside
    // a [label](url) that the previous pass should have handled,
    // and from grabbing `(http://x)` parenthesized refs.
    regex: /(?<![\("\w])(https?:\/\/[^\s)\]<]+)/g,
    build: (m) => ({ type: "link", href: m[1], text: m[1] }),
  },
];

interface NextMatch {
  patternIndex: number;
  match: RegExpExecArray;
}

function findEarliestMatch(input: string, from: number): NextMatch | null {
  let best: NextMatch | null = null;
  for (let p = 0; p < PATTERNS.length; p++) {
    const re = new RegExp(PATTERNS[p].regex.source, PATTERNS[p].regex.flags);
    re.lastIndex = from;
    const m = re.exec(input);
    if (!m) continue;
    if (best === null || m.index < best.match.index) {
      best = { patternIndex: p, match: m };
    }
  }
  return best;
}

export function parseInline(input: string): InlineNode[] {
  const out: InlineNode[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const next = findEarliestMatch(input, cursor);
    if (!next) {
      out.push({ type: "text", text: input.slice(cursor) });
      break;
    }
    if (next.match.index > cursor) {
      out.push({ type: "text", text: input.slice(cursor, next.match.index) });
    }
    const node = PATTERNS[next.patternIndex].build(next.match);
    if (node) out.push(node);
    cursor = next.match.index + next.match[0].length;
    // Defensive: empty match would loop forever. Shouldn't happen
    // with any of our patterns but cheap to guard.
    if (next.match[0].length === 0) cursor++;
  }
  // Merge adjacent text nodes for cleanliness (purely cosmetic for
  // downstream consumers — saves them from "text"+"text" pairs).
  const merged: InlineNode[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === "text" && n.type === "text") {
      prev.text += n.text;
    } else {
      merged.push(n);
    }
  }
  return merged;
}
