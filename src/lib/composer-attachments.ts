// Text pasted into the composer that is too long to live in the input.
// It rides along as a chip and folds back into the message on send —
// nothing here reaches the server, so every driver still sees a prompt.
export type Attachment = {
  kind: "paste";
  id: string;
  text: string;
  size: number;
  lines: number;
};

export function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<Attachment>;
  return (
    attachment.kind === "paste" &&
    typeof attachment.id === "string" &&
    typeof attachment.text === "string" &&
    typeof attachment.size === "number" &&
    Number.isFinite(attachment.size) &&
    attachment.size >= 0 &&
    typeof attachment.lines === "number" &&
    Number.isInteger(attachment.lines) &&
    attachment.lines >= 1
  );
}

/** Past this, a paste stops reading as typing and becomes an attachment.
 * Long-but-narrow (a stack trace, a log) counts by line, not just chars. */
export const PASTE_CHARS = 900;
export const PASTE_LINES = 12;

export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_CHARS || countLines(text) >= PASTE_LINES;
}

export function countLines(text: string): number {
  return text.split("\n").length;
}

export function pasteAttachment(text: string): Attachment {
  const id = globalThis.crypto?.randomUUID?.() ?? `a${Math.random().toString(36).slice(2)}`;
  // measured once, here: a chip re-renders on every keystroke in the
  // composer, and encoding half a megabyte each time would be felt
  return { kind: "paste", id, text, size: byteLength(text), lines: countLines(text) };
}

/** What the paste actually weighs — String#length counts UTF-16 units, so
 * it reads a third under on accented text and half under on CJK. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "12 lines, 3.4 KB" — what the chip says under the preview. */
export function pasteSummary(a: { lines: number; size: number }): string {
  return `${a.lines} lines, ${formatSize(a.size)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The prompt the bot receives: what was typed, then one block per paste.
 * Tagged blocks rather than fences — pasted code and markdown carry fences
 * of their own, and nesting them loses the boundary. */
export function composeMessage(text: string, attachments: Attachment[]): string {
  const parts = [text.trim()];
  attachments.forEach((a, i) => {
    parts.push(`<pasted-text index="${i + 1}">\n${a.text}\n</pasted-text>`);
  });
  return parts.filter(Boolean).join("\n\n");
}
