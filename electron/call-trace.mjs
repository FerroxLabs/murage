// Call trace log: ~/Library/Logs/Murage/call-trace.log, next to server.log.
// COUNTS AND STATES ONLY, never words. Callers build lines from numbers and
// fixed labels; this writer additionally flattens each line, caps its length
// and rotates the file at about 2 MB, keeping one old file.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export const CALL_TRACE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 400;
const PREFIX = /^\[call-(?:diag|trace)\]/;

let fileOverride = null;
/** Test hook: write to this file instead of the OS log dir. null resets. */
export function configureCallTrace(file) {
  fileOverride = file;
}

function traceFile() {
  return fileOverride ?? path.join(app.getPath("logs"), "call-trace.log");
}

/** Flatten to one printable line. Returns null when it is not a call line. */
export function cleanTraceLine(raw) {
  const line = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!PREFIX.test(line)) return null;
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line;
}

export function writeCallTrace(raw, { maxBytes = CALL_TRACE_MAX_BYTES, now = () => new Date() } = {}) {
  const line = cleanTraceLine(raw);
  if (!line) return false;
  const file = traceFile();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* first write */
    }
    if (size >= maxBytes) {
      rmSync(`${file}.1`, { force: true });
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, `${now().toISOString()} ${line}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** One summary line per helper session. Numbers and labels only. */
export function sessionTraceLine(s) {
  const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const reason = String(s.reason ?? "-").replace(/[^\w.-]/g, "_").slice(0, 40);
  return `[call-trace] helper session partials=${n(s.partials)} emptyPartials=${n(s.emptyPartials)} lastPartialChars=${n(s.lastPartialChars)} final=${s.finalChars === null || s.finalChars === undefined ? "none" : n(s.finalChars)} longEndpoint=${s.longEndpoint === true} recovered=${s.recovered === true} exit=${n(s.code)} reason=${reason}`;
}
