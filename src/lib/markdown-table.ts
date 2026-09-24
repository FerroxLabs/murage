// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A GFM table that keeps the author's own text.
//
// The pinned @tiptap/markdown 3.31.3 table renderer pads every cell to the
// column width and wraps the table in extra newlines, so a file with an
// ordinary table could never pass the byte-for-byte fidelity gate. This
// extension keeps the table's Markdown source on the node at parse time and
// re-emits it verbatim on serialize while the table still means the same
// thing: the normalized output for the node now equals the normalized output
// for the source. An edited table is written in the normalized form: aligned
// columns, no blank lines of its own, pipes in cell text escaped (the pinned
// renderer writes them bare, which splits the cell) and a delimiter row as
// wide as each column.
import type { JSONContent, MarkdownRendererHelpers, MarkdownToken } from "@tiptap/core";
import { escapeTableCellPipes, Table } from "@tiptap/extension-table";

/** Parse a Markdown body into document JSON (the fidelity analyzer's parser). */
export type MarkdownBodyParser = (markdown: string) => JSONContent;

/** Node attribute holding the table's Markdown source as parsed. Never
 *  rendered to or read from HTML, so pasted HTML cannot supply it. */
export const TABLE_MARKDOWN_SOURCE_ATTR = "markdownSource";

type Align = "left" | "right" | "center" | null;
const ALIGNS = new Set(["left", "right", "center"]);
const alignOf = (attrs: Record<string, unknown> | undefined): Align =>
  (ALIGNS.has(attrs?.align as string) ? attrs!.align : null) as Align;

/** Escape every pipe not already escaped. Rendered cell Markdown only holds a
 *  pipe that came from text, a code span or a link, and GFM reads each one
 *  as a column border unless it is escaped. */
function escapeCellPipes(text: string): string {
  let out = "";
  let slashes = 0;
  for (const char of text) {
    if (char === "|" && slashes % 2 === 0) out += "\\";
    slashes = char === "\\" ? slashes + 1 : 0;
    out += char;
  }
  return out;
}

/** The table as normalized GFM, following the pinned renderer (header from
 *  the first row, cells kept on one line with <br> for line breaks, columns
 *  padded to at least three characters) with the fixes named above. */
export function renderNormalizedTable(node: JSONContent, h: MarkdownRendererHelpers): string {
  const rows = (node.content ?? []).map(row => (row.content ?? []).map(cell => {
    const blocks = cell.content ?? [];
    const raw = blocks.length > 1 ? blocks.map(block => h.renderChildren(block)).join("\n") : h.renderChildren(blocks);
    const text = raw.replace(/[ \t]*\r?\n[ \t]*/g, "<br>").replace(/\s+/g, " ").trim();
    return { text: escapeCellPipes(text), header: cell.type === "tableHeader", align: alignOf(cell.attrs) };
  }));
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) return "";
  const widths = Array.from({ length: columns }, (_, index) => Math.max(3, ...rows.map(row => row[index]?.text.length ?? 0)));
  const aligns = Array.from({ length: columns }, (_, index) => rows.map(row => row[index]?.align).find(Boolean) ?? null);
  const hasHeader = rows[0].some(cell => cell.header);
  const line = (texts: string[]) => `| ${texts.map((text, index) => text.padEnd(widths[index])).join(" | ")} |`;
  const delimiter = `| ${widths.map((width, index) => {
    const align = aligns[index];
    if (align === "center") return `:${"-".repeat(width - 2)}:`;
    if (align === "left") return `:${"-".repeat(width - 1)}`;
    if (align === "right") return `${"-".repeat(width - 1)}:`;
    return "-".repeat(width);
  }).join(" | ")} |`;
  const cells = (row: typeof rows[number]) => Array.from({ length: columns }, (_, index) => row[index]?.text ?? "");
  const header = hasHeader ? cells(rows[0]) : Array.from({ length: columns }, () => "");
  const body = hasHeader ? rows.slice(1) : rows;
  return [line(header), delimiter, ...body.map(row => line(cells(row)))].join("\n");
}

/** Cells on one table line, split the way marked splits them: pipes inside
 *  code spans and backslash-escaped pipes are cell text, and one leading and
 *  one trailing pipe are borders. */
export function countTableCells(line: string): number {
  let text = escapeTableCellPipes(line).trim();
  const escapedAt = (index: number) => {
    let slashes = 0;
    for (let at = index - 1; at >= 0 && text[at] === "\\"; at -= 1) slashes += 1;
    return slashes % 2 === 1;
  };
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !escapedAt(text.length - 1)) text = text.slice(0, -1);
  let cells = 1;
  for (let index = 0; index < text.length; index += 1) if (text[index] === "|" && !escapedAt(index)) cells += 1;
  return cells;
}

/** Whether every line of a table's Markdown fits the delimiter row. marked
 *  drops the cells past the header's width, so a longer row holds text the
 *  editor would never show; the fidelity gate keeps such a file in Source. */
export function tableRowsFitHeader(raw: string): boolean {
  const lines = raw.replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return false;
  const width = countTableCells(lines[1]);
  return lines.every(line => countTableCells(line) <= width);
}

const MEMO_LIMIT = 256;

export function createSourcePreservingTable(parseBody: MarkdownBodyParser) {
  // source -> normalized form of the table it parses to ("" if it is not
  // exactly one table). Parsing on every keystroke would be wasteful.
  const memo = new Map<string, string>();
  const normalizedSource = (source: string, h: MarkdownRendererHelpers): string => {
    const cached = memo.get(source);
    if (cached !== undefined) return cached;
    let normalized = "";
    try {
      const content = parseBody(source).content ?? [];
      if (content.length === 1 && content[0].type === "table") normalized = renderNormalizedTable(content[0], h);
    } catch {
      normalized = "";
    }
    if (memo.size >= MEMO_LIMIT) memo.clear();
    memo.set(source, normalized);
    return normalized;
  };

  return Table.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        [TABLE_MARKDOWN_SOURCE_ATTR]: {
          default: null,
          rendered: false,
          keepOnSplit: false,
          parseHTML: () => null,
        },
      };
    },

    parseMarkdown(token: MarkdownToken, h) {
      // The pinned table's own parser; it does not use `this`.
      const parsed = Table.config.parseMarkdown?.(token, h);
      const node = (Array.isArray(parsed) ? parsed[0] : parsed) as JSONContent | undefined;
      const raw = typeof token.raw === "string" ? token.raw.replace(/\n+$/, "") : "";
      if (!node || node.type !== "table" || !raw) return parsed ?? [];
      return { ...node, attrs: { ...node.attrs, [TABLE_MARKDOWN_SOURCE_ATTR]: raw } };
    },

    renderMarkdown(node: JSONContent, h: MarkdownRendererHelpers) {
      const normalized = renderNormalizedTable(node, h);
      const source = node.attrs?.[TABLE_MARKDOWN_SOURCE_ATTR];
      if (typeof source === "string" && source !== "" && !source.includes("\n\n")) {
        const original = normalizedSource(source, h);
        if (original !== "" && original === normalized) return source;
      }
      return normalized;
    },
  });
}
