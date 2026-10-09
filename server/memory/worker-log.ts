// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The memory helper used to swallow its failures with no trace (`catch{}`), so an
// owner saw "unavailable" and nobody could say why. Each swallowed catch now
// names its subsystem and cause once per ten minutes (PROPOSAL-v2 section 11,
// line 3). Fixed words only: no job, source, scope or message content.
import { observeLine } from "../observe.ts";

export type WorkerSubsystem = "capture" | "index" | "learning" | "reflection" | "maintenance" | "recall";
const WINDOW_MS = 10 * 60_000;
const MAX_ENTRIES = 256;
interface Entry { since: number; reportedAt: number; count: number }
const entries = new Map<string, Entry>();

/** A cause is a short code (an error name or one of the MEMORY_* codes); anything else collapses to its error name. */
export function causeOf(error: unknown): string {
  if (typeof error === "string") return /^[A-Za-z0-9_:.-]{1,60}$/.test(error) ? error : "unnamed";
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; errcode?: unknown; message?: unknown; name?: unknown };
    if (typeof e.message === "string" && /^[A-Z][A-Z0-9_]{3,60}$/.test(e.message)) return e.message;
    if (typeof e.errcode === "number") return `${typeof e.name === "string" ? e.name : "Error"}:sqlite${e.errcode}`;
    if (typeof e.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(e.code)) return e.code;
    if (typeof e.message === "string" && /database is locked/i.test(e.message)) return "SQLITE_BUSY";
    if (typeof e.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.name)) return e.name;
  }
  return "unnamed";
}

/** Log one swallowed failure. Returns true when a line was written (the first of a cause, then at most one per ten minutes with the count since). */
export function logSwallowed(subsystem: WorkerSubsystem, error: unknown, nextInMs?: number, now = Date.now()): boolean {
  const cause = causeOf(error), key = `${subsystem}\u0000${cause}`;
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    entry = { since: now, reportedAt: -Infinity, count: 0 };
    entries.set(key, entry);
  }
  entry.count++;
  if (now - entry.reportedAt < WINDOW_MS) return false;
  entry.reportedAt = now;
  observeLine(`[memory-worker] subsystem=${subsystem} cause=${cause} count=${entry.count} since=${new Date(entry.since).toISOString()} next=${nextInMs === undefined ? "later" : new Date(now + nextInMs).toISOString()}`);
  return true;
}
export function resetWorkerLog(): void { entries.clear(); }

/** Child process stderr, line by line, at most `perMinute` lines a minute (S5). Text is cut and carries no paths. */
export function makeStderrForwarder(perMinute = 6, now: () => number = Date.now): (chunk: string) => void {
  let windowStart = 0, written = 0, dropped = 0, pending = "";
  const emit = (line: string) => {
    const t = now();
    if (t - windowStart >= 60_000) { if (dropped) observeLine(`[memory-worker] stderr more=${dropped}`); windowStart = t; written = 0; dropped = 0; }
    if (written >= perMinute) { dropped++; return; }
    written++;
    observeLine(`[memory-worker] stderr ${line.replace(/\/(?:Users|home|root)\/[^\s:)]+/g, "<path>").slice(0, 240)}`);
  };
  return chunk => {
    pending += chunk;
    let at: number;
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at).trim(); pending = pending.slice(at + 1);
      if (line) emit(line);
    }
    if (pending.length > 4096) pending = pending.slice(-512);
  };
}
