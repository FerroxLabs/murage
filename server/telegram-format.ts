type Run = { text: string; open?: string; close?: string };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeLink(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch { return false; }
}

/** A conservative Markdown subset. Unrecognized syntax and raw HTML stay literal.
 * Runs never nest, so model output cannot create unsupported Telegram entities.
 * Truncation happens on decoded text, before escaping, and always closes tags.
 */
export function formatTelegramHtml(markdown: string, maxLength = 4096): string {
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 4096) {
    throw new RangeError("Telegram text limit must be between 1 and 4096");
  }
  const runs: Run[] = [];
  const tokens = /\\([\\`*_\[\]])|```[^\n]*\n([\s\S]*?)(?:```|$)|`([^`\n]+)`|\*\*([\s\S]+?)\*\*|__([^\n]+?)__|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!\w)_([^_\n]+)_(?!\w)|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let cursor = 0;
  for (const match of markdown.matchAll(tokens)) {
    if (match.index > cursor) runs.push({ text: markdown.slice(cursor, match.index) });
    if (match[1] !== undefined) runs.push({ text: match[1] });
    else if (match[2] !== undefined) runs.push({ text: match[2], open: "<pre>", close: "</pre>" });
    else if (match[3] !== undefined) runs.push({ text: match[3], open: "<code>", close: "</code>" });
    else if (match[4] !== undefined || match[5] !== undefined) runs.push({ text: match[4] ?? match[5]!, open: "<b>", close: "</b>" });
    else if (match[6] !== undefined || match[7] !== undefined) runs.push({ text: match[6] ?? match[7]!, open: "<i>", close: "</i>" });
    else if (safeLink(match[9]!)) runs.push({ text: match[8]!, open: `<a href="${escapeHtml(match[9]!)}">`, close: "</a>" });
    else runs.push({ text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < markdown.length) runs.push({ text: markdown.slice(cursor) });
  const truncated = runs.reduce((length, run) => length + run.text.length, 0) > maxLength;
  let remaining = maxLength - (truncated ? 1 : 0);
  let html = "";
  for (const run of runs) {
    if (remaining === 0) break;
    let end = Math.min(remaining, run.text.length);
    // JavaScript lengths conservatively count UTF-16 units; don't split an emoji.
    if (end < run.text.length && /[\uD800-\uDBFF]/.test(run.text[end - 1] ?? "")) end--;
    const text = run.text.slice(0, end);
    if (text) html += (run.open ?? "") + escapeHtml(text) + (run.close ?? "");
    remaining -= end;
    if (end < run.text.length) break;
  }
  return html + (truncated ? "…" : "");
}
