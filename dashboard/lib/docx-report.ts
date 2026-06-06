import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import {
  parseBlocks,
  parseInline,
  type Block,
  type InlineNode,
} from "./markdown-ast";
import type { PrReport } from "./types";

// DOCX exporter for PR analysis reports.
//
// Renders the same markdown subset as lib/markdown.tsx (via the
// shared lib/markdown-ast parser), but into OOXML primitives from
// the `docx` package. The result is a real Word file — opens
// natively in Word / Google Docs / Pages, not a renamed .md
// pretending to be one.
//
// Why client-side: the data lives in the user's browser already
// (the report card has a fully-typed PrReport in props), and
// docx.Packer.toBlob produces a browser-ready Blob. A server
// route would require either (a) shipping the body through
// /api/reports just to bounce it back, or (b) a separate
// /api/reports/[repo]/[pr_number]/download endpoint that does
// the same parse + generation server-side. Both add latency and
// neither buys us anything in this case — the report bodies are
// small (~2-3KB markdown, ~20-40KB docx).
//
// Document layout:
//
//   1. Title page-equivalent — "PR Analysis Report" centered + the
//      PR header line + the recommendation badge in bold.
//   2. The body of report.report_markdown rendered via the AST.
//
// The recommendation is "highlighted in bold" twice: once in the
// header card we build by hand (capitalized, framed), and once
// implicitly inside the body's "## Recommendation" section
// because Claude's prompt template already wraps it in **bold**.

// --- Inline rendering ----------------------------------------------------

// Returns the appropriate docx primitives for a flat list of inline
// nodes. A run-styling pass on each text node is the natural
// transform — TextRun for plain/bold/italic/code, ExternalHyperlink
// for links. Links contain TextRun children themselves; we keep
// their labels visually distinct (blue + underlined) to match
// Word's default hyperlink styling.

interface InlineRenderOpts {
  // Inherited formatting that applies to every TextRun produced
  // by this call. Useful when the caller has already decided
  // "everything in this paragraph is bold" (e.g. a manually-built
  // emphasized header) and just wants the parsed inline content
  // wrapped under that umbrella.
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

function inlineToRuns(
  nodes: InlineNode[],
  opts: InlineRenderOpts = {},
): (TextRun | ExternalHyperlink)[] {
  const runs: (TextRun | ExternalHyperlink)[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        runs.push(
          new TextRun({
            text: n.text,
            bold: opts.bold,
            italics: opts.italic,
            color: opts.color,
          }),
        );
        break;
      case "code":
        runs.push(
          new TextRun({
            text: n.text,
            font: "Consolas",
            bold: opts.bold,
            italics: opts.italic,
            color: opts.color,
            // Subtle background tint is unreliable across Word
            // versions; skipping it keeps the run visually
            // identifiable via the monospace font alone.
          }),
        );
        break;
      case "bold":
        runs.push(
          new TextRun({
            text: n.text,
            bold: true,
            italics: opts.italic,
            color: opts.color,
          }),
        );
        break;
      case "italic":
        runs.push(
          new TextRun({
            text: n.text,
            italics: true,
            bold: opts.bold,
            color: opts.color,
          }),
        );
        break;
      case "link":
        // ExternalHyperlink wraps its own TextRun children. We
        // style them blue + underline so they read as links to a
        // Word user even without hover affordances.
        runs.push(
          new ExternalHyperlink({
            link: n.href,
            children: [
              new TextRun({
                text: n.text,
                style: "Hyperlink",
                color: "0563C1",
                underline: {},
              }),
            ],
          }),
        );
        break;
    }
  }
  return runs;
}

function runsFromText(
  text: string,
  opts: InlineRenderOpts = {},
): (TextRun | ExternalHyperlink)[] {
  return inlineToRuns(parseInline(text), opts);
}

// --- Block rendering -----------------------------------------------------

// Maps our markdown heading levels onto docx HeadingLevel. We cap
// at 4 visual levels to match the React renderer; markdown levels
// 5/6 collapse to HEADING_4.
function headingFor(level: number) {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    default:
      return HeadingLevel.HEADING_4;
  }
}

// Build a single TableCell with one paragraph containing the
// inline-parsed cell content. Header cells get bold+shaded
// formatting via the caller — we keep the per-cell helper
// uniform so the body cells stay simple.
function cellFromText(text: string, isHeader: boolean): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: runsFromText(text, isHeader ? { bold: true } : {}),
      }),
    ],
    // Light borders all around. WORD's default for tables built
    // without explicit borders is "no borders", which renders as
    // a floating cluster of text — usually not what you want.
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
    },
    shading: isHeader
      ? { fill: "F2F2F2", color: "auto" }
      : undefined,
  });
}

function tableFromBlock(block: Extract<Block, { type: "table" }>): Table {
  const headerRow = new TableRow({
    children: block.headers.map((h) => cellFromText(h, true)),
    tableHeader: true,
  });
  const bodyRows = block.rows.map(
    (r) =>
      new TableRow({
        children: r.map((c) => cellFromText(c, false)),
      }),
  );
  return new Table({
    rows: [headerRow, ...bodyRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

// Block -> docx primitives. A block may map to multiple top-level
// elements (e.g. a list expands to N paragraphs), so the return
// type is an array.
function blockToDocx(block: Block): (Paragraph | Table)[] {
  switch (block.type) {
    case "heading":
      return [
        new Paragraph({
          heading: headingFor(block.level),
          children: runsFromText(block.content),
        }),
      ];

    case "paragraph":
      return [
        new Paragraph({
          children: runsFromText(block.content),
          spacing: { after: 120 },
        }),
      ];

    case "blockquote":
      // Word doesn't have a native blockquote style universally
      // available; we approximate with italic + a left indent.
      // 720 twentieths-of-a-point = 0.5".
      return [
        new Paragraph({
          children: runsFromText(block.content, { italic: true }),
          indent: { left: 720 },
          spacing: { after: 120 },
        }),
      ];

    case "code_block":
      // Single-paragraph monospace block. We could use a Table for
      // tighter visual framing but the gain doesn't justify the
      // OOXML weight; a monospace paragraph reads correctly in
      // every consumer (Word / Google Docs / Pages).
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: block.content,
              font: "Consolas",
            }),
          ],
          spacing: { before: 120, after: 120 },
        }),
      ];

    case "hr":
      // Word doesn't have a true HR primitive; an empty paragraph
      // with a bottom border is the established workaround.
      return [
        new Paragraph({
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 6,
              color: "BFBFBF",
              space: 1,
            },
          },
          spacing: { before: 120, after: 120 },
        }),
      ];

    case "bullet_list":
      return block.items.map(
        (it) =>
          new Paragraph({
            children: runsFromText(it),
            bullet: { level: 0 },
          }),
      );

    case "numbered_list":
      // We render numbered lists as bullets-with-numeric-prefix.
      // True numbered lists in docx require a numbering definition
      // attached at document level (Document({ numbering: { config:
      // [...] }})), which is a noticeable amount of OOXML for an
      // edge case the agent's reports rarely emit. The fallback
      // (manually-prefixed bullets) reads the same to a human
      // reader and avoids the document-level wiring.
      return block.items.map(
        (it, idx) =>
          new Paragraph({
            children: [
              new TextRun({ text: `${idx + 1}. `, bold: true }),
              ...runsFromText(it),
            ],
            indent: { left: 360 },
          }),
      );

    case "table":
      return [tableFromBlock(block)];
  }
}

// --- Top-level document builder -----------------------------------------

// Capitalizes/normalizes the recommendation label for the header
// badge. Mirrors the dashboard's "merge / request changes / reject
// / needs review" rendering so the docx feels consistent with
// what the user just saw in-app.
function recommendationLabel(rec: string | null | undefined): string {
  if (!rec) return "Needs review";
  return rec.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Same idea for vision alignment ("aligned" -> "Aligned").
function titleCase(s: string | null | undefined): string {
  if (!s) return "Unknown";
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Build the explicit "header card" that sits above the markdown
// body. Why hand-built rather than fed through the AST: it lets
// us guarantee a specific visual hierarchy regardless of what the
// agent's report_markdown happens to contain, and lets the
// recommendation get the bold-emphasis treatment the user asked
// for even when the markdown body's "## Recommendation" section
// is for some reason absent.
function buildHeader(report: PrReport): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];

  // Document title.
  out.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "PR Analysis Report", bold: true })],
      spacing: { after: 160 },
    }),
  );

  // PR identifier line (centered subtitle).
  const prLine = `${report.repo} · PR #${report.pr_number}${
    report.pr_title ? ` — ${report.pr_title}` : ""
  }`;
  out.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: prLine, italics: true, color: "595959" }),
      ],
      spacing: { after: 240 },
    }),
  );

  // Metadata grid. A small 2-column table reads better than a
  // free-floating set of paragraphs for "key: value" pairs.
  const metaRows: Array<[string, string]> = [
    ["Author", report.pr_author ?? "unknown"],
    [
      "Generated",
      new Date(report.created_at).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }) + " UTC",
    ],
    ["Recommendation", recommendationLabel(report.merge_recommendation)],
    ["Confidence", titleCase(report.merge_confidence)],
    ["Vision alignment", titleCase(report.vision_alignment)],
  ];
  if (report.sandbox_app_url) {
    metaRows.push(["Live preview", report.sandbox_app_url]);
  }

  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: metaRows.map(([k, v]) => {
        const isRecommendation = k === "Recommendation";
        return new TableRow({
          children: [
            new TableCell({
              width: { size: 30, type: WidthType.PERCENTAGE },
              shading: { fill: "F2F2F2", color: "auto" },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
                left: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
                right: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
              },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: k, bold: true })],
                }),
              ],
            }),
            new TableCell({
              width: { size: 70, type: WidthType.PERCENTAGE },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
                left: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
                right: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
              },
              children: [
                new Paragraph({
                  children: [
                    // "Recommendation highlighted in bold" — per
                    // the spec. Other rows render plain so the bold
                    // recommendation visually pops.
                    new TextRun({
                      text: v,
                      bold: isRecommendation,
                    }),
                  ],
                }),
              ],
            }),
          ],
        });
      }),
    }),
  );

  // A short visual break before the markdown body kicks in.
  out.push(
    new Paragraph({
      spacing: { before: 240, after: 120 },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 6,
          color: "BFBFBF",
          space: 1,
        },
      },
    }),
  );
  return out;
}

// Sandbox table fallback. The agent's report_markdown nearly
// always includes a "Sandbox Results" pipe table, but if Claude's
// JSON came back malformed and the fallback path kicked in, the
// markdown might be missing it. We synthesize one from the
// PrReport row's denormalized columns so the docx always has the
// section the spec promises.
function sandboxTableIfMissingFromMarkdown(
  report: PrReport,
  body: string,
): Table | null {
  // Hint: if the markdown body already contains a "Sandbox Results"
  // header (with any leading whitespace / casing), trust it and
  // skip the synthesis.
  if (/^#{1,6}\s*sandbox\s+results/im.test(body)) return null;

  const buildLabel =
    report.sandbox_build_success === true
      ? "Passed"
      : report.sandbox_build_success === false
        ? "Failed"
        : "Not run";
  const tests =
    `${report.sandbox_tests_passed ?? 0} passed` +
    ((report.sandbox_tests_failed ?? 0) > 0
      ? `, ${report.sandbox_tests_failed} failed`
      : "");
  return tableFromBlock({
    type: "table",
    headers: ["Step", "Result"],
    rows: [
      ["Tests", tests],
      ["Build", buildLabel],
      ["Sandbox", report.sandbox_overall ?? "not_run"],
      ["Preview", report.sandbox_app_url ?? "N/A"],
    ],
  });
}

// Build the full Document. Pure function — no I/O, no fetch — so
// it's straightforwardly testable in Node (see the smoke test
// below).
export function buildReportDocument(report: PrReport): Document {
  const body = report.report_markdown ?? "";
  const headerChildren = buildHeader(report);
  const blocks = parseBlocks(body);
  const bodyChildren = blocks.flatMap(blockToDocx);

  // If the synthesized markdown omitted the sandbox table, append
  // one so the spec's "Table for sandbox results" requirement is
  // always satisfied.
  const fallbackTable = sandboxTableIfMissingFromMarkdown(report, body);
  if (fallbackTable) {
    bodyChildren.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "Sandbox Results" })],
      }),
      fallbackTable,
    );
  }

  return new Document({
    creator: "Lyncas",
    title: `PR Analysis Report — ${report.repo} #${report.pr_number}`,
    description: `Generated by Lyncas for ${report.repo}#${report.pr_number}`,
    sections: [
      {
        properties: {},
        children: [...headerChildren, ...bodyChildren],
      },
    ],
  });
}

// --- Generic markdown -> docx (used by the chat health report) ----------

// Build a Word document from a raw markdown string with no PrReport
// header card. The chat "Generate report" flow produces freeform
// markdown (not a structured PrReport), so it uses this path to get a
// real .docx rather than a renamed .md.
export function buildMarkdownDocument(
  markdown: string,
  title: string,
): Document {
  const blocks = parseBlocks(markdown ?? "");
  const bodyChildren = blocks.flatMap(blockToDocx);
  return new Document({
    creator: "Lyncas",
    title,
    description: title,
    sections: [{ properties: {}, children: bodyChildren }],
  });
}

export async function downloadMarkdownDocx(
  markdown: string,
  filename: string,
  title: string,
): Promise<void> {
  const doc = buildMarkdownDocument(markdown, title);
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// --- Browser download entry point ---------------------------------------

// Filename uses the same flatten-the-slash convention as the .md
// version so users with both files on disk get a sortable, stable
// set.
export function reportDocxFilename(
  repo: string,
  prNumber: number,
): string {
  return `pr-report-${repo.replace(/\//g, "-")}-${prNumber}.docx`;
}

// Generate the Blob + trigger a download. Designed to be invoked
// from an onClick — the function awaits Packer.toBlob and then
// uses a transient <a> + ObjectURL to drive the browser's download
// UX. We clean up the ObjectURL on a microtask so the navigator
// has time to dispatch the download before revocation; ad-hoc
// testing showed Safari is the most sensitive to early revocation.
//
// Returns nothing useful — errors are thrown to the caller, which
// (in our case) surfaces them via the existing error UI.
export async function downloadReportDocx(report: PrReport): Promise<void> {
  const doc = buildReportDocument(report);
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = reportDocxFilename(report.repo, report.pr_number);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revocation so the click handler completes before the URL
  // disappears. 0ms is enough — Chrome / Firefox / Safari all
  // dispatch the download synchronously from the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
