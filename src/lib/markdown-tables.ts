// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Split only unescaped pipes. Backslash pairs leave the next pipe unescaped,
 * as GFM does. Keep the cell text itself intact, including its escapes. */
function cells(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let slashes = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "|" && slashes % 2 === 0) {
      parts.push(line.slice(start, index));
      start = index + 1;
    }
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  parts.push(line.slice(start));
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.at(-1)?.trim() === "") parts.pop();
  return parts;
}

function row(line: string): string[] | null {
  // Require both borders before inferring a missing separator. Prose with a
  // pipe, block quotes and indented code are deliberately left alone.
  if (!/^ {0,3}\|.*\|\s*$/.test(line)) return null;
  const parts = cells(line);
  return parts.length >= 2 ? parts : null;
}
const delimiter = (cell: string) => /^:?-+:?$/.test(cell.trim());

/** Display-only repairs for unmistakable pipe tables. The caller keeps the
 * original masked message for Copy, source view and storage. One forward
 * pass over this message, with no transcript-wide work or unbounded cache. */
export function repairMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let tableBodyEnd = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Recognize fences inside list/quote containers too. Indentation belongs
    // to the container, not the code. Keep every original byte in the output.
    const fenceLine = line.replace(/\r$/, "").replace(/^(?:[ \t]*(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+))+/, "");
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(fenceLine);
    if (fence) {
      out.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length };
      out.push(line);
      continue;
    }
    if (index < tableBodyEnd) { out.push(line); continue; }
    const header = row(line);
    const next = lines[index + 1];
    if (!header || next === undefined) { out.push(line); continue; }
    // An absent inner pipe is recoverable only when whitespace still divides
    // exactly one delimiter per header cell. Keep alignment colons.
    const tokens = next.trim().replace(/^\||\|$/g, "").trim().split(/[| \t]+/);
    const separator = tokens.length === header.length && tokens.every(delimiter);
    const body = row(next);
    if (!separator && (!body || body.length !== header.length)) { out.push(line); continue; }
    const existing = cells(next);
    const complete = separator && existing.length === header.length && existing.every(delimiter);
    if (!complete) {
      // GFM silently drops body cells beyond the header width, including in
      // rows without outer borders. Check the entire paragraph before adding
      // structure. Do not reinterpret its suffix as another table. Fence
      // tracking still runs for each line, and each paragraph is scanned once.
      let end = index + 1;
      let overflow = false;
      while (end < lines.length && lines[end].trim()) {
        if (cells(lines[end]).length > header.length) overflow = true;
        end += 1;
      }
      tableBodyEnd = end;
      if (overflow) {
        out.push(line);
        continue;
      }
    }
    out.push(line);
    if (separator) {
      out.push(complete
        ? next
        : `| ${tokens.join(" | ")} |${line.endsWith("\r") ? "\r" : ""}`);
      index += 1;
    } else {
      out.push(`| ${header.map(() => "---").join(" | ")} |${line.endsWith("\r") ? "\r" : ""}`);
    }
    // Consume the remaining body once. It must not become another header,
    // even if one of its later rows has a different number of cells.
    while (index + 1 < lines.length && row(lines[index + 1])) out.push(lines[++index]);
  }
  return out.join("\n");
}
