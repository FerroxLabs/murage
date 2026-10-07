// Call trace lines, persisted by the desktop main process to
// ~/Library/Logs/Murage/call-trace.log (electron/call-trace.mjs).
// COUNTS AND STATES ONLY, never words: a line is a fixed label plus numeric
// and boolean fields. Anything else is dropped here, so a transcript cannot be
// passed in by mistake.

export type TraceFields = Record<string, number | boolean | null | undefined>;

const LABEL = /^[a-z][a-z0-9 :>_.-]{0,60}$/;

export function formatCallTrace(label: string, fields: TraceFields = {}): string | null {
  if (!LABEL.test(label)) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-zA-Z]{1,24}$/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) parts.push(`${key}=${Math.round(value * 100) / 100}`);
    else if (typeof value === "boolean") parts.push(`${key}=${value}`);
  }
  return `[call-trace] ${label}${parts.length ? ` ${parts.join(" ")}` : ""}`;
}

export function callTrace(label: string, fields?: TraceFields): void {
  const line = formatCallTrace(label, fields);
  if (line) console.warn(line);
}

/** Word count, the only measure of a transcript the trace may carry. */
export const wordCount = (text: string | undefined | null): number => (text ?? "").trim().split(/\s+/).filter(Boolean).length;
