import type { ReactNode } from "react";
import {
  parseBlocks,
  parseInline,
  type Block,
  type InlineNode,
} from "./markdown-ast";

// React renderer for the markdown subset documented in
// lib/markdown-ast.ts.
//
// This file used to carry its own parser (~250 lines of regex
// scanning interleaved with JSX construction). It now delegates
// to parseBlocks() / parseInline() so that lib/docx-report.ts can
// consume the same AST — any future change to supported syntax
// only has to land in markdown-ast.ts.
//
// Security: we never emit via dangerouslySetInnerHTML. All text
// goes through React text nodes; links are filtered by the inline
// parser (which drops javascript: URLs to plain text).

function renderInlineNodes(nodes: InlineNode[], baseKey: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${baseKey}-${i}`;
    switch (n.type) {
      case "text":
        return <span key={k}>{n.text}</span>;
      case "code":
        return (
          <code
            key={k}
            className="rounded-sm bg-bg-elev px-1 py-[1px] font-mono text-[0.85em] text-white"
          >
            {n.text}
          </code>
        );
      case "bold":
        return (
          <strong key={k} className="font-semibold text-white">
            {n.text}
          </strong>
        );
      case "italic":
        return (
          <em key={k} className="italic">
            {n.text}
          </em>
        );
      case "link": {
        const external = /^https?:\/\//i.test(n.href);
        return (
          <a
            key={k}
            href={n.href}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
            className="text-white underline decoration-border underline-offset-4 hover:decoration-white"
          >
            {n.text}
          </a>
        );
      }
    }
  });
}

// Convenience: parse + render inline in one shot. Used by callers
// that have a raw string (e.g. heading content, table cells) and
// want the rendered nodes back.
function renderInline(text: string, baseKey: string): ReactNode[] {
  return renderInlineNodes(parseInline(text), baseKey);
}

interface RenderOpts {
  /** Class hook for the wrapper. Defaults to a vertical-rhythm
   * markdown stack — overridable so the consumer can drop the
   * wrapper entirely (e.g. inline preview). */
  className?: string;
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.type) {
    case "code_block":
      return (
        <pre
          key={key}
          className="max-w-full overflow-auto rounded-md border border-border bg-bg-elev px-3 py-2 font-mono text-[12px] leading-relaxed text-white"
          data-lang={block.lang || undefined}
        >
          {block.content}
        </pre>
      );

    case "heading": {
      const inner = renderInline(block.content, key);
      // Heading levels collapse: 5/6 share H4 styling because the
      // agent's report prompts never go deeper than H4.
      if (block.level === 1) {
        return (
          <h1 key={key} className="mt-2 text-2xl font-semibold text-white">
            {inner}
          </h1>
        );
      }
      if (block.level === 2) {
        return (
          <h2 key={key} className="mt-1 text-xl font-semibold text-white">
            {inner}
          </h2>
        );
      }
      if (block.level === 3) {
        return (
          <h3
            key={key}
            className="text-base font-semibold uppercase tracking-[0.12em] text-white"
          >
            {inner}
          </h3>
        );
      }
      return (
        <h4
          key={key}
          className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-strong"
        >
          {inner}
        </h4>
      );
    }

    case "hr":
      return <hr key={key} className="my-3 border-border" />;

    case "blockquote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-border pl-3 text-muted-strong"
        >
          {renderInline(block.content, key)}
        </blockquote>
      );

    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border">
                {block.headers.map((h, hi) => (
                  <th
                    key={`${key}-h-${hi}`}
                    className="px-2 py-1 text-left font-mono uppercase tracking-[0.12em] text-muted"
                  >
                    {renderInline(h, `${key}-h-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, ri) => (
                <tr
                  key={`${key}-r-${ri}`}
                  className="border-b border-border/40"
                >
                  {r.map((c, ci) => (
                    <td
                      key={`${key}-c-${ri}-${ci}`}
                      className="px-2 py-1"
                    >
                      {renderInline(c, `${key}-c-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "bullet_list":
      return (
        <ul
          key={key}
          className="ml-5 list-disc space-y-1 text-muted-strong"
        >
          {block.items.map((it, ii) => (
            <li key={`${key}-li-${ii}`}>
              {renderInline(it, `${key}-li-${ii}`)}
            </li>
          ))}
        </ul>
      );

    case "numbered_list":
      return (
        <ol
          key={key}
          className="ml-5 list-decimal space-y-1 text-muted-strong"
        >
          {block.items.map((it, ii) => (
            <li key={`${key}-li-${ii}`}>
              {renderInline(it, `${key}-li-${ii}`)}
            </li>
          ))}
        </ol>
      );

    case "paragraph":
      return (
        <p key={key} className="leading-relaxed text-muted-strong">
          {renderInline(block.content, key)}
        </p>
      );
  }
}

export function renderMarkdown(
  source: string | null | undefined,
  opts: RenderOpts = {},
): ReactNode {
  const blocks = parseBlocks(source ?? "");
  return (
    <div
      className={
        opts.className ??
        "space-y-3 text-sm text-muted-strong [&>p:first-child]:mt-0"
      }
    >
      {blocks.map((b, i) => renderBlock(b, `b${i}`))}
    </div>
  );
}
