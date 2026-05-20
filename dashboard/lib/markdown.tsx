import type { ReactNode } from "react";

// Minimal markdown -> React renderer.
//
// We do NOT ship react-markdown / remark / rehype here — the project
// charter forbids new npm packages. The agent's generated reports
// are bounded (Sonnet, max 2000 tokens) and produce a predictable
// subset of markdown, so a ~150-line hand-rolled renderer is
// strictly cheaper than pulling in the multi-megabyte
// remark-rehype-react chain.
//
// What we support (the subset Claude's prompt in
// agent/report_generator.py actually produces):
//
//   * ATX headings: `# H1`, `## H2`, `### H3`, `#### H4`
//   * Bold (`**text**`), italic (`*text*` / `_text_`)
//   * Inline code (`` `code` ``)
//   * Fenced code blocks (```optional-lang)
//   * Bullet lists (`-` or `*` at start of line)
//   * Numbered lists (`1.`)
//   * Pipe tables (`| col1 | col2 |` with a `|---|---|` separator
//     row immediately below the header row)
//   * Horizontal rules (`---` on its own line)
//   * Links (`[text](url)`) and bare URLs
//   * Blockquotes (`> text`)
//   * Paragraphs (anything else)
//
// What we DON'T support (and deliberately don't):
//   * Nested lists. Reports don't generate them.
//   * Reference-style links. Reports don't generate them.
//   * Strikethrough. Reports don't generate them.
//   * HTML pass-through. Defensive against XSS by escaping any
//     literal `<` in source text before inline parsing — the
//     renderer always emits via React's text nodes, never via
//     dangerouslySetInnerHTML.
//
// Anything in the source markdown that falls outside the supported
// subset is treated as a plain paragraph, so the worst-case is
// "looks like the raw markdown" rather than a render crash.

// --- Inline pass --------------------------------------------------------

// Order matters: code first (so we don't bold inside ` `), then
// bold (so `**foo*bar**` is bold-italic, not italic-italic),
// then italic, then links/urls. Each pass takes a string and
// returns a list of React nodes (text + spans/anchors).

type Inline = string | ReactNode;

function inlinePass(
  input: string,
  regex: RegExp,
  wrap: (match: RegExpExecArray, key: string) => ReactNode,
): Inline[] {
  const out: Inline[] = [];
  let lastIndex = 0;
  let counter = 0;
  let m: RegExpExecArray | null;
  // Reset state for stateful regexes:
  regex.lastIndex = 0;
  while ((m = regex.exec(input)) !== null) {
    if (m.index > lastIndex) {
      out.push(input.slice(lastIndex, m.index));
    }
    out.push(wrap(m, `${m[0]}-${counter++}-${m.index}`));
    lastIndex = m.index + m[0].length;
    // Defensive: empty-match infinite loop. shouldn't happen with
    // any of our patterns but cheap to guard.
    if (m[0].length === 0) regex.lastIndex++;
  }
  if (lastIndex < input.length) {
    out.push(input.slice(lastIndex));
  }
  return out;
}

function applyAcross(
  parts: Inline[],
  regex: RegExp,
  wrap: (match: RegExpExecArray, key: string) => ReactNode,
): Inline[] {
  const next: Inline[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      next.push(...inlinePass(p, regex, wrap));
    } else {
      next.push(p);
    }
  }
  return next;
}

function renderInline(text: string, baseKey: string): ReactNode[] {
  let parts: Inline[] = [text];

  // 1. Inline code — `code`. Matched first so we don't bold inside
  // a code span.
  parts = applyAcross(parts, /`([^`]+)`/g, (m, key) => (
    <code
      key={`${baseKey}-c-${key}`}
      className="rounded-sm bg-bg-elev px-1 py-[1px] font-mono text-[0.85em] text-white"
    >
      {m[1]}
    </code>
  ));

  // 2. Bold — **text**. Two-pass over the same content; bold first
  // because italic uses a subset of the same delimiter.
  parts = applyAcross(parts, /\*\*([^*]+)\*\*/g, (m, key) => (
    <strong key={`${baseKey}-b-${key}`} className="font-semibold text-white">
      {m[1]}
    </strong>
  ));

  // 3. Italic — *text* or _text_. We exclude double-`*` (already
  // consumed by the bold pass).
  parts = applyAcross(parts, /(?<![*_])\*([^*]+)\*(?!\*)/g, (m, key) => (
    <em key={`${baseKey}-i-${key}`} className="italic">
      {m[1]}
    </em>
  ));
  parts = applyAcross(parts, /(?<![_*])_([^_]+)_(?!_)/g, (m, key) => (
    <em key={`${baseKey}-u-${key}`} className="italic">
      {m[1]}
    </em>
  ));

  // 4. Links — [text](url). We accept http(s):// and relative paths;
  // a JS-protocol URL is dropped to a plain string defensively.
  parts = applyAcross(
    parts,
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (m, key) => {
      const label = m[1];
      const href = m[2];
      const safe = href.startsWith("javascript:")
        ? null
        : href;
      if (!safe) return label;
      const external = /^https?:\/\//i.test(safe);
      return (
        <a
          key={`${baseKey}-a-${key}`}
          href={safe}
          target={external ? "_blank" : undefined}
          rel={external ? "noopener noreferrer" : undefined}
          className="text-white underline decoration-border underline-offset-4 hover:decoration-white"
        >
          {label}
        </a>
      );
    },
  );

  // 5. Auto-link bare URLs. We only auto-link http(s) so a stray
  // word containing "://" doesn't become a broken link.
  parts = applyAcross(
    parts,
    /(?<![\("\w])(https?:\/\/[^\s)\]<]+)/g,
    (m, key) => (
      <a
        key={`${baseKey}-l-${key}`}
        href={m[1]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-white underline decoration-border underline-offset-4 hover:decoration-white"
      >
        {m[1]}
      </a>
    ),
  );

  // Wrap any straggling strings + nodes into a stable React array.
  return parts.map((p, i) =>
    typeof p === "string" ? <span key={`${baseKey}-t-${i}`}>{p}</span> : p,
  );
}

// --- Block pass ---------------------------------------------------------

interface RenderOpts {
  // Class hook for the wrapper. Defaults to a vertical-rhythm
  // markdown stack — overridable so the consumer can drop the
  // wrapper entirely (e.g. inline preview).
  className?: string;
}

// Splits the source into a list of "blocks" — heading, list,
// table, code-fence, hr, blockquote, paragraph — and renders each.
// The result is wrapped in a single styled <div> by default.
export function renderMarkdown(
  source: string | null | undefined,
  opts: RenderOpts = {},
): ReactNode {
  const text = (source ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockCounter = 0;

  function nextKey(): string {
    blockCounter++;
    return `b${blockCounter}`;
  }

  while (i < lines.length) {
    const line = lines[i];

    // 1. Code fence — captures everything until the closing ```.
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      // Skip the closing fence if we found one.
      if (i < lines.length) i++;
      const k = nextKey();
      blocks.push(
        <pre
          key={k}
          className="max-w-full overflow-auto rounded-md border border-border bg-bg-elev px-3 py-2 font-mono text-[12px] leading-relaxed text-white"
          data-lang={lang || undefined}
        >
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }

    // 2. Heading — ATX style. The renderer accepts up to 6 #'s but
    // we only style 1–4 distinctly (5/6 collapse to the H4 styling
    // because reports never go deeper). A switch on the literal
    // tag name is more TS-friendly than building one dynamically:
    // React 19 + Next 16's stricter JSX types reject the
    // string-as-element pattern unless we hand-type the full union.
    const hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hMatch) {
      const level = Math.min(hMatch[1].length, 4);
      const content = hMatch[2];
      const k = nextKey();
      const inner = renderInline(content, k);
      if (level === 1) {
        blocks.push(
          <h1 key={k} className="mt-2 text-2xl font-semibold text-white">
            {inner}
          </h1>,
        );
      } else if (level === 2) {
        blocks.push(
          <h2 key={k} className="mt-1 text-xl font-semibold text-white">
            {inner}
          </h2>,
        );
      } else if (level === 3) {
        blocks.push(
          <h3
            key={k}
            className="text-base font-semibold uppercase tracking-[0.12em] text-white"
          >
            {inner}
          </h3>,
        );
      } else {
        blocks.push(
          <h4
            key={k}
            className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-strong"
          >
            {inner}
          </h4>,
        );
      }
      i++;
      continue;
    }

    // 3. Horizontal rule — exactly --- (or more) on its own line.
    if (/^-{3,}\s*$/.test(line)) {
      const k = nextKey();
      blocks.push(
        <hr key={k} className="my-3 border-border" />,
      );
      i++;
      continue;
    }

    // 4. Blockquote — chained > lines.
    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2));
        i++;
      }
      const k = nextKey();
      blocks.push(
        <blockquote
          key={k}
          className="border-l-2 border-border pl-3 text-muted-strong"
        >
          {renderInline(buf.join(" "), k)}
        </blockquote>,
      );
      continue;
    }

    // 5. Table — pipe-delimited. Requires a header row and a
    // separator row of dashes. If the separator isn't immediately
    // below the suspected header, we fall through to paragraph
    // rendering — defensive against single-row pipe-using prose.
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
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const k = nextKey();
      blocks.push(
        <div key={k} className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border">
                {headers.map((h, hi) => (
                  <th
                    key={`${k}-h-${hi}`}
                    className="px-2 py-1 text-left font-mono uppercase tracking-[0.12em] text-muted"
                  >
                    {renderInline(h, `${k}-h-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={`${k}-r-${ri}`} className="border-b border-border/40">
                  {r.map((c, ci) => (
                    <td key={`${k}-c-${ri}-${ci}`} className="px-2 py-1">
                      {renderInline(c, `${k}-c-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 6. Bullet list — - / * markers. Chains until a blank or non-
    // bullet line.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      const k = nextKey();
      blocks.push(
        <ul key={k} className="ml-5 list-disc space-y-1 text-muted-strong">
          {items.map((it, ii) => (
            <li key={`${k}-li-${ii}`}>
              {renderInline(it, `${k}-li-${ii}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // 7. Numbered list — `1.` markers. Same chain semantics.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      const k = nextKey();
      blocks.push(
        <ol
          key={k}
          className="ml-5 list-decimal space-y-1 text-muted-strong"
        >
          {items.map((it, ii) => (
            <li key={`${k}-li-${ii}`}>
              {renderInline(it, `${k}-li-${ii}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // 8. Blank line — paragraph terminator. We absorb runs of blanks
    // here so the output doesn't get spurious empty <p>s.
    if (line.trim() === "") {
      while (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }

    // 9. Paragraph — collect contiguous non-block lines.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !lines[i].startsWith("```") &&
      !/^-{3,}\s*$/.test(lines[i]) &&
      !lines[i].startsWith("> ") &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    const k = nextKey();
    blocks.push(
      <p key={k} className="leading-relaxed text-muted-strong">
        {renderInline(buf.join(" "), k)}
      </p>,
    );
  }

  return (
    <div
      className={
        opts.className ??
        "space-y-3 text-sm text-muted-strong [&>p:first-child]:mt-0"
      }
    >
      {blocks}
    </div>
  );
}
