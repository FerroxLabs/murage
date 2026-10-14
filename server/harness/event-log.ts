// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The harness event log (events/<threadId>.ndjson) within a budget.
//
// What is kept, and for whom:
//  - The Inspector's Events lens (thread-events.ts) reads the newest lines of
//    events/<thread>.ndjson. It shows turns, tools, requests, completed text
//    and errors; every one of those is kept.
//  - Conversation deletion (conversation-deletion.ts) reads every
//    `session.started` the conversation ever had, so it can remove the
//    engine's own transcripts. Those lines are also written to a small
//    events/<thread>.sessions.ndjson that no budget sweep evicts; it goes only
//    with the conversation. A log file is never discarded (by a rotation or
//    the sweep) while it holds session lines that file has not been given.
//  - events/routine-runs/ is a journal (routine-runs-journal.ts) and other
//    files in events/ are not ours: the sweeps here look only at
//    <thread>.ndjson and <thread>.previous.ndjson files directly in events/.
//
// What is not written: `content.delta` (each streamed chunk of a reply) and
// `item.updated` (a running tool's progress tick). They are live-only: the
// completed item carries the same text, and they were 97% of the bytes.
//
// Limits: 16 MB per thread file with one `.previous` rotation, and 256 MB / 30
// days for the folder, the same budget as native/.
//
// Rewrites (a forgotten message, the upgrade prune) are background jobs: the
// file is read line by line and the kept lines streamed to a temporary file,
// in slices that yield the main loop; only the last step (take in what the bus
// appended meanwhile, then an atomic rename) is synchronous, and it is small.
// The bus appends with appendFileSync and never holds the file open between
// events, so no writer can interleave with that step. While a rewrite owns a
// thread's files its log does not rotate. Old logs from before this release
// can be far over the V8 string limit (~512 MiB), so no reader here ever holds
// a whole file.
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { open as openAsync, readdir as readdirAsync, stat as statAsync, unlink as unlinkAsync, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { renameWithRetry, writeFileAtomic } from "../atomic.ts";
import type { RuntimeEvent } from "../contracts.ts";

const ID = /^[\w-]+$/;
const LOG_NAME = /^([\w-]+)(\.previous)?\.ndjson$/;
const TMP_NAME = /^[\w-]+(\.previous)?\.ndjson\.(\d+)\.[0-9a-f-]+\.tmp$/;

export const EVENT_LOG_THREAD_BYTES = 16 * 1024 * 1024;
export const EVENT_LOG_BUDGET_BYTES = 256 * 1024 * 1024;
export const EVENT_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** One record is at most this big; a larger one is summarized (a huge tool result, say). */
export const EVENT_LOG_RECORD_BYTES = 1024 * 1024;
/** The upgrade prune starts at the first /api/health answer, or this long after listen (a headless run). */
export const EVENT_LOG_PRUNE_FALLBACK_MS = 2 * 60 * 1000;
/** What a rewrite's last, synchronous step may still have to read. */
const CATCH_UP_BYTES = 256 * 1024;

/** Tunable for tests only. */
export const eventLogLimits = {
  threadBytes: EVENT_LOG_THREAD_BYTES,
  maxBytes: EVENT_LOG_BUDGET_BYTES,
  maxAgeMs: EVENT_LOG_MAX_AGE_MS,
  recordBytes: EVENT_LOG_RECORD_BYTES,
  sweepEveryMs: 60_000,
  sweepEveryBytes: 8 * 1024 * 1024,
};

/** The file operations a test needs to fail on demand (no portable way exists
 * to make a real filesystem refuse a rename). */
export const eventLogIo = {
  rename: renameSync as (from: string, to: string) => void,
  platform: process.platform as NodeJS.Platform,
  appendSession: appendFileSync as (path: string, data: string, options: { mode: number }) => void,
};
function replaceFile(from: string, to: string): void { renameWithRetry(from, to, eventLogIo.rename, eventLogIo.platform); }
/** A rename Windows refuses while another handle (the Inspector, a backup, a scanner) holds the file. */
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"]);

function errorCode(error: unknown): string | undefined { const code = (error as { code?: unknown } | null)?.code; return typeof code === "string" ? code : undefined; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Live-only event types: delivered to every listener, never written. */
export const LIVE_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(["content.delta", "item.updated"]);
export function persistsEvent(event: Pick<RuntimeEvent, "type">): boolean { return !LIVE_ONLY_EVENT_TYPES.has(event.type); }

export function currentLog(dir: string, threadId: string): string { return join(dir, `${threadId}.ndjson`); }
export function previousLog(dir: string, threadId: string): string { return join(dir, `${threadId}.previous.ndjson`); }
export function sessionsLog(dir: string, threadId: string): string { return join(dir, `${threadId}.sessions.ndjson`); }
/** Every file name a thread can have in events/ (temporary rewrite files are matched by prefix, see threadTempFiles). */
export function threadLogNames(threadId: string): string[] { return [`${threadId}.ndjson`, `${threadId}.previous.ndjson`, `${threadId}.sessions.ndjson`, `${threadId}.sessions.pending`]; }
/** Present while a session line may be in a log and not yet in the sessions file (survives a restart or crash). */
function sessionsPendingMark(dir: string, threadId: string): string { return join(dir, `${threadId}.sessions.pending`); }
export function threadTempFiles(dir: string, threadId: string): string[] {
  try { return readdirSync(dir).filter(name => TMP_NAME.test(name) && (name.startsWith(`${threadId}.ndjson.`) || name.startsWith(`${threadId}.previous.ndjson.`))); }
  catch { return []; }
}

// ── conversations already deleted ───────────────────────────────────────────
/** Threads whose conversation was deleted in this process: a late event (a
 * turn still winding down) is delivered but never recreates their files. */
const closedThreads = new Set<string>();
export function closeThreadLog(threadId: string): void {
  if (closedThreads.size > 50_000) closedThreads.clear();
  closedThreads.add(threadId);
}
export function threadLogClosed(threadId: string): boolean { return closedThreads.has(threadId); }

// ── reading a log of any size ───────────────────────────────────────────────
/** Splits bytes into lines without ever holding more than one line: a line
 * far over the per-record limit (only an old log has one) is dropped, not
 * buffered. A torn last line stays in `carry` and is never handed out. */
class LineSplitter {
  private carry = Buffer.alloc(0);
  private skipping = false;
  skipped = 0;
  private readonly onLine: (line: string) => void;
  private readonly maxLine: number;
  constructor(onLine: (line: string) => void, maxLine: number = 4 * eventLogLimits.recordBytes) { this.onLine = onLine; this.maxLine = maxLine; }
  feed(chunk: Buffer): void {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    let start = 0, nl: number;
    while ((nl = data.indexOf(10, start)) >= 0) {
      if (this.skipping) { this.skipping = false; this.skipped++; } else if (nl > start) this.onLine(data.subarray(start, nl).toString("utf8"));
      start = nl + 1;
    }
    this.carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    if (this.carry.length > this.maxLine) { this.carry = Buffer.alloc(0); this.skipping = true; }
  }
}

/** Every complete line of a file, read in chunks on the calling thread. For a
 * synchronous caller that cannot wait (conversation deletion's planning step).
 * Returns false when the file does not exist. */
export function forEachLineSync(path: string, onLine: (line: string) => void, chunkBytes = 1024 * 1024): boolean {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return false; }
  try {
    const splitter = new LineSplitter(onLine);
    const buffer = Buffer.alloc(chunkBytes);
    for (let position = 0; ;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (!read) break;
      position += read;
      splitter.feed(Buffer.from(buffer.subarray(0, read)));
    }
    return true;
  } finally { closeSync(fd); }
}

function pause(ms: number): Promise<void> { return new Promise(resolve => { const t = setTimeout(resolve, ms); (t as { unref?: () => void }).unref?.(); }); }

/** Yields the main loop once a slice has run `sliceMs`, and waits while `busy`. */
function slicer(sliceMs: number, busy?: () => boolean): () => Promise<void> {
  let start = Date.now();
  return async () => {
    if (Date.now() - start < sliceMs) return;
    while (busy?.()) await pause(500);
    await new Promise<void>(resolve => setImmediate(resolve));
    start = Date.now();
  };
}

type ScanOptions = { chunkBytes?: number; sliceMs?: number; busy?: () => boolean };

/** Reads a file handle from `position` to `to` in chunks, yielding between slices. */
class FileScanner {
  readonly splitter: LineSplitter;
  private readonly buffer: Buffer;
  private readonly step: () => Promise<void>;
  private readonly handle: FileHandle;
  position: number;
  private readonly afterChunk?: () => Promise<void>;
  constructor(handle: FileHandle, position: number, onLine: (line: string) => void, options: ScanOptions, afterChunk?: () => Promise<void>) {
    this.handle = handle; this.position = position; this.afterChunk = afterChunk;
    this.splitter = new LineSplitter(onLine);
    this.buffer = Buffer.alloc(options.chunkBytes ?? 1024 * 1024);
    this.step = slicer(options.sliceMs ?? 15, options.busy);
  }
  async readTo(to: number): Promise<void> {
    while (this.position < to) {
      const { bytesRead } = await this.handle.read(this.buffer, 0, Math.min(this.buffer.length, to - this.position), this.position);
      if (!bytesRead) break;
      this.position += bytesRead;
      this.splitter.feed(Buffer.from(this.buffer.subarray(0, bytesRead)));
      await this.afterChunk?.();
      await this.step();
    }
  }
}

// ── session lines ───────────────────────────────────────────────────────────
function lineType(line: string): string | undefined {
  try { const t = (JSON.parse(line) as { type?: unknown }).type; return typeof t === "string" ? t : undefined; } catch { return undefined; }
}
function isSessionLine(line: string): boolean { return line.includes("\"session.started\"") && lineType(line) === "session.started"; }

/** What deletion needs from a session line, and nothing else (no prompt, no settings). */
function compactSession(line: string): string | undefined {
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    if (e.type !== "session.started") return undefined;
    return JSON.stringify({ type: "session.started", eventId: e.eventId, provider: e.provider, providerInstanceId: e.providerInstanceId, threadId: e.threadId, createdAt: e.createdAt, sessionId: e.sessionId });
  } catch { return undefined; }
}
function sessionKey(line: string): string {
  try { const e = JSON.parse(line) as { providerInstanceId?: unknown; sessionId?: unknown }; return `${String(e.providerInstanceId)}\u0000${String(e.sessionId)}`; } catch { return line; }
}

/** `session.started` lines go to the thread's sessions file as well, so
 * conversation deletion can still find every engine session once the
 * rotations and the budget have let the older lines go. Every session is
 * kept: deletion needs each one, and a line is about 250 bytes. */
export function recordSessionLine(dir: string, threadId: string, line: string): void {
  const key = jobKey(dir, threadId);
  const queue = pendingSessionLines.get(key) ?? [];
  queue.push(line);
  pendingSessionLines.set(key, queue);
  flushSessionLines(dir, threadId);
}
/** Called by the bus before the log append of a `session.started`: from here until the sessions file has the line, a
 * rescan of this thread's logs is owed (the mark outlives a restart; a failed mark write leaves the in-memory retry). */
export function markSessionsPending(dir: string, threadId: string): void {
  try { writeFileSync(sessionsPendingMark(dir, threadId), "", { mode: 0o600 }); } catch { /* the in-memory retry still holds the line */ }
}
/** Retries session lines that did not reach the sessions file; the mark is cleared once none is owed. Never throws. */
export function flushSessionLines(dir: string, threadId: string): void {
  const key = jobKey(dir, threadId);
  const queue = pendingSessionLines.get(key);
  if (!queue) return;
  while (queue.length) {
    try { eventLogIo.appendSession(sessionsLog(dir, threadId), (compactSession(queue[0]!) ?? queue[0]!) + "\n", { mode: 0o600 }); queue.shift(); }
    catch (error) { console.warn(`[events] a session line of ${threadId} could not be written (it is retried): ${errorText(error)}`); return; }
  }
  pendingSessionLines.delete(key);
  try { unlinkSync(sessionsPendingMark(dir, threadId)); } catch { /* none */ }
}
const pendingSessionLines = new Map<string, string[]>();

/** Adds the sessions not already in the thread's sessions file (append only). */
function mergeSessions(dir: string, threadId: string, lines: readonly string[]): void {
  if (!lines.length) return;
  const path = sessionsLog(dir, threadId);
  const seen = new Set<string>();
  forEachLineSync(path, line => { seen.add(sessionKey(line)); });
  const add: string[] = [];
  for (const line of lines) {
    const compact = compactSession(line);
    if (!compact) continue;
    const key = sessionKey(compact);
    if (!seen.has(key)) { seen.add(key); add.push(compact); }
  }
  if (add.length) appendFileSync(path, add.join("\n") + "\n", { mode: 0o600 });
}

// ── which files have given their session lines ──────────────────────────────
/** Files (by dir and inode: a rotation keeps the inode) whose session lines
 * are all in the sessions file: files the bus created in this release, and
 * files a rewrite or a session copy has read. */
const coveredFiles = new Set<string>();
const fileKey = (dir: string, ino: bigint | number | string) => `${dir}\u0000${String(ino)}`;
function inoOf(path: string): bigint | undefined { try { return statSync(path, { bigint: true }).ino; } catch { return undefined; } }

function sessionsCovered(dir: string, ino: bigint): boolean {
  return budgetReady || coveredFiles.has(fileKey(dir, ino)) || progressFor(dir).has(String(ino)) || eventLogPruneDone(dir);
}
/** The bus calls this after an append that created the thread's current file. */
export function markLogCovered(dir: string, threadId: string): void {
  const ino = inoOf(currentLog(dir, threadId));
  if (ino !== undefined) coveredFiles.add(fileKey(dir, ino));
}

// ── one rewrite (or session copy) per thread at a time ──────────────────────
const threadJobs = new Map<string, Promise<unknown>>();
const jobKey = (dir: string, threadId: string) => `${dir}\u0000${threadId}`;
async function withThreadJob<T>(dir: string, threadId: string, job: () => Promise<T>): Promise<T> {
  const key = jobKey(dir, threadId);
  for (let running = threadJobs.get(key); running; running = threadJobs.get(key)) await running.catch(() => undefined);
  const run = job();
  threadJobs.set(key, run);
  try { return await run; } finally { if (threadJobs.get(key) === run) threadJobs.delete(key); }
}

/** Copies the session lines of a thread's `.previous` file, so the next rotation may replace it. */
const copying = new Set<string>();
function queueSessionCopy(dir: string, threadId: string): void {
  const key = jobKey(dir, threadId);
  if (copying.has(key)) return;
  copying.add(key);
  const job = withThreadJob(dir, threadId, async () => {
    const path = previousLog(dir, threadId);
    let handle: FileHandle;
    try { handle = await openAsync(path, "r"); } catch { return; }
    try {
      const { ino, size } = await handle.stat({ bigint: true });
      const sessions: string[] = [];
      await new FileScanner(handle, 0, line => { if (isSessionLine(line)) sessions.push(line); }, {}).readTo(Number(size));
      mergeSessions(dir, threadId, sessions);
      coveredFiles.add(fileKey(dir, ino));
    } finally { await handle.close().catch(() => undefined); }
  }).catch(error => console.warn(`[events] the session lines of ${threadId}.previous.ndjson could not be copied (its log keeps growing until they are): ${errorText(error)}`))
    .finally(() => copying.delete(key));
  backgroundJobs.add(job); void job.finally(() => backgroundJobs.delete(job));
}

// ── a thread's sessions, for deletion ───────────────────────────────────────
export type SessionReadOptions = ScanOptions & { onBytes?: (bytes: number) => void };

/** Every `session.started` line a thread has, as compact lines, read from the
 * thread's sessions file (about 250 bytes a session) in short slices. A log
 * whose session lines are not in that file yet (one from before 1.0.2, maybe
 * gigabytes) is scanned once, in slices that yield the event loop, and its
 * sessions are copied over and marked covered: after that the call reads only
 * the compact file, whatever the size of the logs. */
export async function threadSessionLines(dir: string, threadId: string, options: SessionReadOptions = {}): Promise<string[]> {
  const count = (chunk: number) => options.onBytes?.(chunk);
  flushSessionLines(dir, threadId);
  const stale = existsSync(sessionsPendingMark(dir, threadId));
  await withThreadJob(dir, threadId, async () => {
    for (const path of [previousLog(dir, threadId), currentLog(dir, threadId)]) {
      let handle: FileHandle;
      try { handle = await openAsync(path, "r"); } catch { continue; }
      try {
        const { ino, size } = await handle.stat({ bigint: true });
        if (!stale && sessionsCovered(dir, ino)) continue;
        const sessions: string[] = [];
        const scanner = new FileScanner(handle, 0, line => { if (isSessionLine(line)) sessions.push(line); }, options);
        await scanner.readTo(Number(size));
        count(scanner.position);
        mergeSessions(dir, threadId, sessions);
        coveredFiles.add(fileKey(dir, ino));
      } finally { await handle.close().catch(() => undefined); }
    }
    if (stale && !pendingSessionLines.has(jobKey(dir, threadId))) try { unlinkSync(sessionsPendingMark(dir, threadId)); } catch { /* gone */ }
  });
  const out: string[] = [];
  let handle: FileHandle;
  try { handle = await openAsync(sessionsLog(dir, threadId), "r"); } catch { return out; }
  try {
    const { size } = await handle.stat();
    const scanner = new FileScanner(handle, 0, line => { out.push(line); }, options);
    await scanner.readTo(size);
    count(scanner.position);
  } finally { await handle.close().catch(() => undefined); }
  return out;
}

// ── writing ─────────────────────────────────────────────────────────────────
function sizeOf(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/** A record over the per-record limit keeps its shape (the Inspector still
 * shows it happened) and loses its bulk. */
export function boundedRecord(event: RuntimeEvent, limit = eventLogLimits.recordBytes): string {
  const line = JSON.stringify(event);
  if (Buffer.byteLength(line) <= limit) return line;
  const bytes = Buffer.byteLength(line);
  const e = event as unknown as Record<string, unknown>;
  if (e.type === "item.completed" && e.itemType === "tool") return JSON.stringify({ ...e, result: `[${bytes} bytes, too large for the event log]` });
  if (e.type === "item.completed" && e.itemType === "assistant_text" && typeof e.text === "string") {
    return JSON.stringify({ ...e, text: `${(e.text as string).slice(0, Math.floor(limit / 4))}\n[${bytes} bytes in all; the rest is in the conversation]` });
  }
  const base = { eventId: e.eventId, provider: e.provider, providerInstanceId: e.providerInstanceId, threadId: e.threadId, createdAt: e.createdAt, turnId: e.turnId, itemId: e.itemId };
  return JSON.stringify({ ...base, type: "runtime.error", message: `A ${String(e.type)} event of ${bytes} bytes was summarized for the event log.` });
}

const heldWarned = new Set<string>();
/** Called before an append of `incoming` bytes: a full current file becomes
 * `.previous` (replacing the older one), so a thread keeps at most two files.
 * The rotation waits (the current file grows past the cap for a while) when a
 * rewrite owns the thread's files, when the `.previous` it would replace still
 * holds session lines the sessions file lacks (they are copied first, in the
 * background), or when Windows refuses the rename because the file is held
 * open. Returns true when the append that follows creates the current file. */
export function rotateIfFull(dir: string, threadId: string, incoming: number): boolean {
  const current = currentLog(dir, threadId);
  const bytes = sizeOf(current);
  if (bytes === 0) return true;
  if (bytes + incoming <= eventLogLimits.threadBytes) return false;
  if (threadJobs.has(jobKey(dir, threadId))) return false;
  const previous = previousLog(dir, threadId);
  const older = inoOf(previous);
  if (older !== undefined && !sessionsCovered(dir, older)) { queueSessionCopy(dir, threadId); return false; }
  try { replaceFile(current, previous); }
  catch (error) {
    const code = errorCode(error);
    if (!code || !HELD_OPEN.has(code)) throw error;
    if (!heldWarned.has(threadId)) { heldWarned.add(threadId); console.warn(`[events] ${threadId}.ndjson could not rotate (${code}: the file is held open); it rotates on a later event`); }
    return false;
  }
  heldWarned.delete(threadId);
  return true;
}

let lastSweep = 0;
let writtenSinceSweep = 0;
let ageTimer: ReturnType<typeof setInterval> | undefined;
let sweeping: Promise<void> | undefined;
const backgroundJobs = new Set<Promise<unknown>>();
/** False until the upgrade prune has run once on this folder: until then the
 * old files still hold the only copy of their session lines, so nothing is
 * evicted by size or age. */
let budgetReady = false;
export function setEventLogBudgetReady(ready: boolean): void { budgetReady = ready; }

/** Starts a budget sweep in the background (never more than one at a time). */
let sweepQueued: { dir: string; keep?: readonly string[] } | undefined;
function sweepInBackground(dir: string, keep?: readonly string[]): void {
  // one due while another runs runs right after it
  if (sweeping) { sweepQueued = { dir, ...(keep ? { keep } : {}) }; return; }
  sweeping = enforceEventLogBudget(dir, keep ? { keep } : {})
    .then(() => undefined, error => console.warn(`[events] the event log budget sweep failed: ${errorText(error)}`))
    .finally(() => {
      sweeping = undefined;
      const next = sweepQueued;
      sweepQueued = undefined;
      if (next) sweepInBackground(next.dir, next.keep);
    });
}

export function sweepAfterWrite(dir: string, threadId: string, bytes: number): void {
  writtenSinceSweep += bytes;
  if (!budgetReady) return;
  const now = Date.now();
  if (now - lastSweep < eventLogLimits.sweepEveryMs && writtenSinceSweep < eventLogLimits.sweepEveryBytes) return;
  lastSweep = now; writtenSinceSweep = 0;
  sweepInBackground(dir, [`${threadId}.ndjson`]);
  if (!ageTimer) { ageTimer = setInterval(() => { if (budgetReady) sweepInBackground(dir); }, 60 * 60 * 1000); ageTimer.unref?.(); }
}

/** Keeps the folder inside its budget: files past the age limit go first,
 * then the oldest until the total fits. Files named in `keep` (the one being
 * written) are never evicted for size. Sessions files, events/routine-runs/
 * and anything else that is not a thread log are never touched. Reads the
 * folder asynchronously (thousands of threads are tens of ms of stat calls).
 * Best effort, never throws; resolves to the number of files removed. */
export async function enforceEventLogBudget(dir: string, options: { maxBytes?: number; maxAgeMs?: number; now?: number; keep?: readonly string[] } = {}): Promise<number> {
  const maxBytes = options.maxBytes ?? eventLogLimits.maxBytes, maxAge = options.maxAgeMs ?? eventLogLimits.maxAgeMs, now = options.now ?? Date.now();
  const keep = new Set(options.keep ?? []);
  let removed = 0;
  let names: string[];
  try { names = (await readdirAsync(dir)).filter(name => LOG_NAME.test(name)); } catch { return 0; /* the folder may not exist yet */ }
  const files: { path: string; name: string; bytes: number; at: number }[] = [];
  for (let i = 0; i < names.length; i += 64) {
    const part = await Promise.all(names.slice(i, i + 64).map(async name => {
      const path = join(dir, name);
      try { const st = await statAsync(path); return st.isFile() ? { path, name, bytes: st.size, at: st.mtimeMs } : undefined; } catch { return undefined; /* gone already */ }
    }));
    for (const file of part) if (file) files.push(file);
  }
  const drop = async (file: { path: string }) => { try { await unlinkAsync(file.path); removed++; return true; } catch { return false; } };
  const live: typeof files = [];
  for (const file of files) if (now - file.at <= maxAge || !(await drop(file))) live.push(file);
  live.sort((a, b) => a.at - b.at);
  let total = live.reduce((sum, file) => sum + file.bytes, 0);
  for (const file of live) {
    if (total <= maxBytes) break;
    if (keep.has(file.name)) continue;
    if (await drop(file)) total -= file.bytes;
  }
  return removed;
}

// ── the streamed rewrite ────────────────────────────────────────────────────
/** What a rewrite does with each line. `drain` hands over the lines ready to
 * write; `endMain` (the prune's newest-16-MB window) hands over what it held
 * back once the first full read is done. */
type Rewriter = {
  take(line: string): void;
  drain(): string[];
  endMain?(): string[];
  changed(): boolean;
  sessions: string[];
};
type RewriteOutcome = { outcome: "replaced" | "unchanged" | "missing" | "moved" | "closed"; ino?: string };

/** Rewrites one log file through `rewriter`: streamed to a temporary file in
 * slices, then a short synchronous step takes in what the bus appended since,
 * and an atomic rename puts it in place. "moved" means the file was replaced
 * under it (visit it again); "closed" that its conversation was deleted. */
async function rewriteStreamed(dir: string, threadId: string, name: string, rewriter: Rewriter, options: ScanOptions & { onlyIfChanged?: boolean }): Promise<RewriteOutcome> {
  const path = join(dir, name);
  let handle: FileHandle | undefined;
  try { handle = await openAsync(path, "r"); }
  catch (error) { if (errorCode(error) === "ENOENT") return { outcome: "missing" }; throw error; }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let out: FileHandle | undefined;
  let placed = false;
  try {
    const { ino, size } = await handle.stat({ bigint: true });
    out = await openAsync(tmp, "w", 0o600);
    const step = slicer(options.sliceMs ?? 15, options.busy);
    // in pieces of about 1 MB: the prune's window can be the whole thread cap
    const write = async (lines: string[]) => {
      for (let i = 0; i < lines.length;) {
        let bytes = 0; const start = i;
        while (i < lines.length && bytes < 1024 * 1024) bytes += lines[i++]!.length + 1;
        await out!.write(lines.slice(start, i).join("\n") + "\n");
        await step();
      }
    };
    const scanner = new FileScanner(handle, 0, line => rewriter.take(line), options, () => write(rewriter.drain()));
    await scanner.readTo(Number(size));
    if (rewriter.endMain) await write(rewriter.endMain());
    await write(rewriter.drain());
    // catch up with the bus until what is left is small
    for (;;) {
      let now;
      try { now = await statAsync(path, { bigint: true }); } catch { return { outcome: "missing" }; }
      if (now.ino !== ino || Number(now.size) < scanner.position) return { outcome: "moved" };
      if (Number(now.size) - scanner.position <= CATCH_UP_BYTES) break;
      await scanner.readTo(Number(now.size));
    }
    await out.sync();
    await out.close(); out = undefined;
    // Windows: no handle of ours may hold the file being replaced
    await handle.close(); handle = undefined;
    if (rewriter.sessions.length) { mergeSessions(dir, threadId, rewriter.sessions); rewriter.sessions.length = 0; }
    // ── the last step: synchronous, and small ──
    if (threadLogClosed(threadId)) return { outcome: "closed" };
    let fd: number;
    try { fd = openSync(path, "r"); } catch { return { outcome: "missing" }; }
    try {
      const st = fstatSync(fd, { bigint: true });
      if (st.ino !== ino || Number(st.size) < scanner.position) return { outcome: "moved" };
      const extra = Buffer.alloc(Number(st.size) - scanner.position);
      if (extra.length) readSync(fd, extra, 0, extra.length, scanner.position);
      // a torn last line (a crash mid-append) stays behind in the splitter and is dropped
      scanner.splitter.feed(extra);
    } finally { closeSync(fd); }
    if (rewriter.sessions.length) mergeSessions(dir, threadId, rewriter.sessions);
    coveredFiles.add(fileKey(dir, ino));
    if (options.onlyIfChanged && !rewriter.changed()) return { outcome: "unchanged", ino: String(ino) };
    const tail = rewriter.drain();
    if (tail.length) {
      const t = openSync(tmp, "a");
      try { writeSync(t, tail.join("\n") + "\n"); fsyncSync(t); } finally { closeSync(t); }
    }
    // The old file keeps a second name until the rename is done, so the rename
    // does not free its blocks on the main loop (hundreds of ms for an old log
    // of hundreds of MB); that name is removed in the background.
    const old = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let kept = false;
    try { linkSync(path, old); kept = true; } catch { /* a filesystem without hard links: the rename frees it */ }
    try { replaceFile(tmp, path); }
    catch (error) { if (kept) { try { unlinkSync(old); } catch { /* removed with the next start's dead rewrites */ } } throw error; }
    placed = true;
    if (kept) { const freeing = unlinkAsync(old).catch(() => undefined); backgroundJobs.add(freeing); void freeing.finally(() => backgroundJobs.delete(freeing)); }
    const next = inoOf(path);
    if (next === undefined) return { outcome: "missing" };
    coveredFiles.add(fileKey(dir, next));
    return { outcome: "replaced", ino: String(next) };
  } finally {
    await handle?.close().catch(() => undefined);
    await out?.close().catch(() => undefined);
    // off the main loop too: an unused rewrite can be as large as the log
    if (!placed) await unlinkAsync(tmp).catch(() => undefined /* never created, or gone */);
  }
}

// ── forgetting ──────────────────────────────────────────────────────────────
export type ForgottenText = { threadId: string; turnId?: string; text?: string };

function jsonInner(text: string): string { return JSON.stringify(text).slice(1, -1); }

/** The lines that hold a forgotten message: every event of the turn it came
 * from, and any line that carries its text. */
export function forgottenMatcher(items: readonly ForgottenText[]): (line: string) => boolean {
  const turns = new Set(items.map(item => item.turnId).filter((id): id is string => typeof id === "string" && id.length > 0));
  const needles: string[] = [];
  for (const item of items) {
    const text = item.text?.trim();
    if (!text || text.length < 12) continue;
    const inner = jsonInner(text);
    needles.push(inner.length > 160 ? inner.slice(0, 160) : inner);
  }
  const turnNeedles = [...turns].map(id => `"turnId":${JSON.stringify(id)}`);
  return (line: string) => turnNeedles.some(n => line.includes(n)) || needles.some(n => line.includes(n));
}

function forgetRewriter(matches: (line: string) => boolean): Rewriter {
  let out: string[] = [];
  let dropped = false;
  const sessions: string[] = [];
  return {
    sessions,
    take(line) {
      if (matches(line)) { dropped = true; return; }
      if (isSessionLine(line)) sessions.push(line);
      out.push(line);
    },
    drain() { const lines = out; out = []; return lines; },
    changed: () => dropped,
  };
}

type Db = {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
  exec(sql: string): void;
};
type ForgetJobOptions = { dir: string; database: () => Db; retryMs?: number } & ScanOptions;

const FORGETS = "event_log_forgets";
/** Exported so the installation snapshot knows this table's exact definition. */
export function ensureForgetTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${FORGETS}(thread_id TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(thread_id, message_id))`);
}

/** Threads with a forgotten message still in their log: no reader serves their lines. */
const forgetPending = new Set<string>();
export function eventLogForgetPending(threadId: string): boolean { return forgetPending.has(threadId); }

let forgetJob: ForgetJobOptions | undefined;
let forgetRun: Promise<void> | undefined;
let forgetAgain = false;
let forgetRetry: ReturnType<typeof setTimeout> | undefined;

/** Called inside the forget's own SQLite transaction (memory/forget.ts): the
 * durable record that these messages must leave the event log commits with
 * the forget. From now on the Inspector serves none of the thread's lines;
 * the rewrite itself runs after the commit, in the background. Returns the
 * threads it applies to. */
export function recordEventLogForget(db: Db, messageIds: readonly string[]): string[] {
  const ids = [...new Set(messageIds)].filter(id => typeof id === "string" && id.length > 0);
  if (!ids.length) return [];
  ensureForgetTable(db);
  const insert = db.prepare(`INSERT OR IGNORE INTO ${FORGETS}(thread_id, message_id, at) VALUES(?,?,?)`);
  const threads = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    for (const row of db.prepare(`SELECT id, thread_id FROM messages WHERE id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ id?: unknown; thread_id?: unknown }>) {
      if (typeof row.id !== "string" || typeof row.thread_id !== "string") continue;
      insert.run(row.thread_id, row.id, Date.now());
      threads.add(row.thread_id);
    }
  }
  for (const threadId of threads) forgetPending.add(threadId);
  if (threads.size) scheduleForgets();
  return [...threads];
}

/** At start: reads the forgets a stop or crash left unfinished (their threads
 * are gated at once), removes rewrite files a dead process left, and runs the
 * job. Later forgets run as they are recorded. */
export function startEventLogForgets(options: ForgetJobOptions): void {
  forgetJob = options;
  try {
    const db = options.database();
    ensureForgetTable(db);
    for (const row of db.prepare(`SELECT DISTINCT thread_id FROM ${FORGETS}`).all() as Array<{ thread_id?: unknown }>) if (typeof row.thread_id === "string") forgetPending.add(row.thread_id);
  } catch (error) {
    console.warn(`[events] unfinished forgets could not be read; retrying: ${errorText(error)}`);
  }
  removeDeadRewrites(options.dir);
  scheduleForgets();
}

/** A rewrite file whose process is gone (a crash mid-rewrite) holds only kept lines; it is removed. */
function removeDeadRewrites(dir: string): void {
  const job = (async () => {
    for (const name of await readdirAsync(dir).catch(() => [] as string[])) {
      const match = TMP_NAME.exec(name);
      if (match && Number(match[2]) !== process.pid) await unlinkAsync(join(dir, name)).catch(() => undefined);
    }
  })();
  backgroundJobs.add(job); void job.finally(() => backgroundJobs.delete(job));
}

function scheduleForgets(): void {
  const options = forgetJob;
  if (!options) return;
  if (forgetRun) { forgetAgain = true; return; }
  if (forgetRetry) { clearTimeout(forgetRetry); forgetRetry = undefined; }
  forgetRun = (async () => {
    // after the forget's transaction has committed
    await new Promise<void>(resolve => setImmediate(resolve));
    let failed = 0;
    do {
      forgetAgain = false;
      try { failed = (await runEventLogForgets(options)).failed; }
      catch (error) { failed = 1; console.warn(`[events] the forget job failed; retrying: ${errorText(error)}`); }
    } while (forgetAgain && forgetJob === options);
    if (failed && forgetJob === options) {
      forgetRetry = setTimeout(() => { forgetRetry = undefined; scheduleForgets(); }, options.retryMs ?? 30_000);
      forgetRetry.unref?.();
    }
  })().finally(() => { forgetRun = undefined; });
}

/** One pass over the recorded forgets: each thread's current and previous log
 * are rewritten without the forgotten lines, then its records are cleared. A
 * thread whose rewrite failed keeps its records (and stays gated) and is
 * reported; the next pass retries it. */
export async function runEventLogForgets(options: ForgetJobOptions): Promise<{ threads: number; failed: number }> {
  const db = options.database();
  ensureForgetTable(db);
  const byThread = new Map<string, string[]>();
  for (const row of db.prepare(`SELECT thread_id, message_id FROM ${FORGETS} ORDER BY at`).all() as Array<{ thread_id?: unknown; message_id?: unknown }>) {
    if (typeof row.thread_id !== "string" || typeof row.message_id !== "string") continue;
    const list = byThread.get(row.thread_id) ?? [];
    list.push(row.message_id); byThread.set(row.thread_id, list);
  }
  let threads = 0, failed = 0;
  for (const [threadId, messageIds] of byThread) {
    forgetPending.add(threadId);
    try {
      if (ID.test(threadId)) {
        const items = forgottenTextsFor(db, messageIds).filter(item => item.threadId === threadId);
        const matches = forgottenMatcher(items);
        await withThreadJob(options.dir, threadId, async () => {
          // the current file first: a rotation between the two moves already cleaned lines into .previous
          for (const name of [`${threadId}.ndjson`, `${threadId}.previous.ndjson`]) {
            let attempt = 0;
            while ((await rewriteStreamed(options.dir, threadId, name, forgetRewriter(matches), { ...options, onlyIfChanged: true })).outcome === "moved") {
              if (++attempt >= 3) throw new Error(`${name} kept changing under the rewrite`);
            }
          }
        });
      }
      const marks = messageIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM ${FORGETS} WHERE thread_id=? AND message_id IN (${marks})`).run(threadId, ...messageIds);
      if (!db.prepare(`SELECT 1 FROM ${FORGETS} WHERE thread_id=? LIMIT 1`).get(threadId)) forgetPending.delete(threadId);
      threads++;
    } catch (error) {
      failed++;
      console.warn(`[events] a forgotten message is still in the event log of ${threadId} (its lines stay hidden); retrying: ${errorText(error)}`);
    }
  }
  return { threads, failed };
}

// ── the upgrade prune ───────────────────────────────────────────────────────
const PROGRESS = ".retention-progress.json";
const DONE = ".retention-v1";

export type EventLogPruneOptions = {
  dir: string;
  /** True for a thread that still has a conversation (a live bot or room thread, or message rows). */
  threadKnown: (threadId: string) => boolean;
  /** Forgotten messages of every thread, read once at the start. */
  forgotten?: () => readonly ForgottenText[];
  /** True while the owner has a turn running: the prune waits. */
  busy?: () => boolean;
  /** Test seams. */
  chunkBytes?: number;
  sliceMs?: number;
  orphanGraceMs?: number;
  now?: () => number;
  /** Stop after this many files (a test of resuming). */
  stopAfter?: number;
};
export type EventLogPruneResult = { done: boolean; files: number; orphansRemoved: number; bytesBefore: number; bytesAfter: number };

export function eventLogPruneDone(dir: string): boolean {
  try { return statSync(join(dir, DONE)).isFile(); } catch { return false; }
}

/** The prune's progress: the files (by inode) already brought to the rules.
 * A rotation keeps a file's inode, and a rewrite gives it a new one that is
 * recorded, so a `.previous` replaced by an unpruned file is visited again. */
const progressCache = new Map<string, Set<string>>();
function progressFor(dir: string): Set<string> {
  let progress = progressCache.get(dir);
  if (progress) return progress;
  progress = new Set();
  try {
    const parsed = JSON.parse(readFileSync(join(dir, PROGRESS), "utf8")) as { inodes?: unknown };
    if (Array.isArray(parsed.inodes)) for (const ino of parsed.inodes) if (typeof ino === "string") progress.add(ino);
  } catch { /* none yet */ }
  progressCache.set(dir, progress);
  return progress;
}

/** Health gate for the prune: the first /api/health answer opens it, or,
 * when nothing probes (a headless run), the fallback timer armed at listen. */
export function eventLogPruneGate(fallbackMs = EVENT_LOG_PRUNE_FALLBACK_MS): { ready: Promise<void>; answered: () => void; armFallback: () => void } {
  let open: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>(resolve => { open = () => { open = () => {}; if (timer) clearTimeout(timer); resolve(); }; });
  return {
    ready,
    answered: () => open(),
    armFallback: () => { if (timer) return; timer = setTimeout(() => open(), fallbackMs); timer.unref?.(); },
  };
}

/** The per-line rule shared by the prune: what stays, in what form. */
function classify(line: string, forgotten: (line: string) => boolean, recordBytes: number): string | undefined {
  if (!line) return undefined;
  if ((line.includes("\"type\":\"content.delta\"") || line.includes("\"type\":\"item.updated\"")) && LIVE_ONLY_EVENT_TYPES.has(lineType(line) ?? "")) return undefined;
  if (forgotten(line)) return undefined;
  if (Buffer.byteLength(line) <= recordBytes) return line;
  try { return boundedRecord(JSON.parse(line) as RuntimeEvent, recordBytes); } catch { return undefined; }
}

/** The prune's rule: live-only events and forgotten lines out, the newest
 * thread-cap bytes kept (a window, written out once the first read is done),
 * session lines collected for the sessions file. */
function pruneRewriter(forgotten: (line: string) => boolean): Rewriter {
  const limit = eventLogLimits.threadBytes, recordBytes = eventLogLimits.recordBytes;
  let windowed = true, changed = false;
  let kept: string[] = []; let keptBytes = 0; let keepStart = 0;
  const sessions: string[] = [];
  return {
    sessions,
    take(line) {
      if (isSessionLine(line)) sessions.push(line);
      const keep = classify(line, forgotten, recordBytes);
      if (keep !== line) changed = true;
      if (keep === undefined) return;
      kept.push(keep);
      if (!windowed) return;
      keptBytes += Buffer.byteLength(keep) + 1;
      while (keptBytes > limit && keepStart < kept.length) { keptBytes -= Buffer.byteLength(kept[keepStart]!) + 1; kept[keepStart] = ""; keepStart++; changed = true; }
      if (keepStart > 4096) { kept.splice(0, keepStart); keepStart = 0; }
    },
    drain() { if (windowed) return []; const lines = kept; kept = []; return lines; },
    endMain() { windowed = false; const lines = kept.slice(keepStart).filter(Boolean); kept = []; keepStart = 0; return lines; },
    changed: () => changed,
  };
}

/** Prunes one file to the new rules. Returns whether it is finished (false:
 * replaced under it, or the replace failed; it is visited again) and the inode
 * it now has. */
async function pruneFile(dir: string, name: string, threadId: string, forgotten: (line: string) => boolean, options: EventLogPruneOptions): Promise<{ finished: boolean; ino?: string }> {
  try {
    const result = await withThreadJob(dir, threadId, () => rewriteStreamed(dir, threadId, name, pruneRewriter(forgotten), { chunkBytes: options.chunkBytes, sliceMs: options.sliceMs, busy: options.busy, onlyIfChanged: true }));
    if (result.outcome === "moved") return { finished: false };
    return { finished: true, ...(result.ino ? { ino: result.ino } : {}) };
  } catch (error) {
    console.warn(`[events] ${name} could not be pruned this pass: ${errorText(error)}`);
    return { finished: false };
  }
}

function removeQuietly(path: string): boolean { try { unlinkSync(path); return true; } catch { return false; } }
/** An old log can be hundreds of MB: freeing it is left to the thread pool. */
function removeInBackground(path: string): Promise<boolean> { return unlinkAsync(path).then(() => true, () => false); }

/** First start after the upgrade: every existing thread log is pruned to the
 * new rules, logs of conversations already deleted are removed, and leftover
 * rewrite files go. Resumable: each finished file is recorded by inode, and a
 * finished pass (every log file recorded) leaves a marker so it never runs
 * twice. */
export async function pruneEventLogs(options: EventLogPruneOptions): Promise<EventLogPruneResult> {
  const { dir } = options;
  const now = options.now ?? Date.now;
  const grace = options.orphanGraceMs ?? 10 * 60 * 1000;
  const result: EventLogPruneResult = { done: false, files: 0, orphansRemoved: 0, bytesBefore: 0, bytesAfter: 0 };
  if (eventLogPruneDone(dir)) { result.done = true; setEventLogBudgetReady(true); return result; }
  let names: string[];
  try { names = await readdirAsync(dir); } catch { return result; }
  // a thread's older file first: a rotation turns the current file into it
  names.sort((a, b) => Number(!a.includes(".previous.")) - Number(!b.includes(".previous.")) || (a < b ? -1 : a > b ? 1 : 0));
  progressCache.delete(dir);
  const progress = progressFor(dir);
  const saveProgress = () => writeFileAtomic(join(dir, PROGRESS), JSON.stringify({ inodes: [...progress] }), { mode: 0o600 });
  let forgottenItems: readonly ForgottenText[] = [];
  try { forgottenItems = options.forgotten?.() ?? []; } catch (error) { console.warn(`[events] forgotten messages could not be read: ${errorText(error)}`); }
  const forgottenByThread = new Map<string, ForgottenText[]>();
  for (const item of forgottenItems) { const list = forgottenByThread.get(item.threadId) ?? []; list.push(item); forgottenByThread.set(item.threadId, list); }
  const none = () => false;
  let visited = 0, again = false;
  for (const name of names) {
    const path = join(dir, name);
    if (TMP_NAME.test(name)) {
      try { if (now() - statSync(path).mtimeMs > grace) await removeInBackground(path); } catch { /* gone */ }
      continue;
    }
    const match = LOG_NAME.exec(name) ?? /^([\w-]+)\.sessions\.ndjson$/.exec(name);
    if (!match) continue;
    const threadId = match[1]!;
    let st;
    try { st = statSync(path, { bigint: true }); } catch { continue; }
    if (!st.isFile()) continue;
    result.bytesBefore += Number(st.size);
    if (!options.threadKnown(threadId) && now() - Number(st.mtimeMs) > grace) {
      if (await removeInBackground(path)) result.orphansRemoved++;
      continue;
    }
    if (name.endsWith(".sessions.ndjson") || progress.has(String(st.ino))) continue;
    if (options.stopAfter !== undefined && visited >= options.stopAfter) return result;
    while (options.busy?.()) await pause(500);
    const list = forgottenByThread.get(threadId);
    const { finished, ino } = await pruneFile(dir, name, threadId, list ? forgottenMatcher(list) : none, options);
    visited++; result.files++;
    if (!finished) { again = true; continue; }
    if (ino) { progress.add(ino); saveProgress(); }
  }
  // every log file now in the folder must be one the prune has finished (a
  // rotation may have put an unpruned file under a name already visited)
  // (a file the bus created in this release follows the rules already)
  for (const name of await readdirAsync(dir).catch(() => [] as string[])) {
    if (!LOG_NAME.test(name)) continue;
    const ino = inoOf(join(dir, name));
    if (ino !== undefined && !progress.has(String(ino)) && !coveredFiles.has(fileKey(dir, ino))) again = true;
  }
  if (again) return result;
  setEventLogBudgetReady(true);
  await enforceEventLogBudget(dir);
  for (const name of await readdirAsync(dir).catch(() => [] as string[])) {
    if (!LOG_NAME.test(name)) continue;
    result.bytesAfter += sizeOf(join(dir, name));
  }
  writeFileSync(join(dir, DONE), `${new Date(now()).toISOString()}\n`, { mode: 0o600 });
  removeQuietly(join(dir, PROGRESS));
  progressCache.delete(dir);
  result.done = true;
  return result;
}

// ── tests ───────────────────────────────────────────────────────────────────
/** Resolves once every background job (rewrites, session copies, sweeps, the forget run) has finished. */
export async function eventLogJobsSettled(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const pending = [...threadJobs.values(), ...backgroundJobs, ...(sweeping ? [sweeping] : []), ...(forgetRun ? [forgetRun] : [])];
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}
/** A restart, as far as this module's memory goes (the files and the database stay). */
export function resetEventLogJobsForTests(): void {
  forgetJob = undefined;
  if (forgetRetry) clearTimeout(forgetRetry);
  forgetRetry = undefined; forgetAgain = false;
  forgetPending.clear();
  coveredFiles.clear();
  pendingSessionLines.clear();
  progressCache.clear();
  heldWarned.clear();
  sweepQueued = undefined;
  lastSweep = 0; writtenSinceSweep = 0;
}

// ── reading forgotten messages from the database ────────────────────────────
type ReadDb = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };

function rowsToForgotten(rows: unknown[]): ForgottenText[] {
  const out: ForgottenText[] = [];
  for (const row of rows as Array<{ thread_id?: unknown; text?: unknown; json?: unknown }>) {
    if (typeof row.thread_id !== "string") continue;
    let turnId: string | undefined;
    try { const parsed = JSON.parse(String(row.json ?? "{}")) as { turnId?: unknown }; if (typeof parsed.turnId === "string") turnId = parsed.turnId; } catch { /* no turn */ }
    out.push({ threadId: row.thread_id, ...(turnId ? { turnId } : {}), ...(typeof row.text === "string" ? { text: row.text } : {}) });
  }
  return out;
}

/** The thread, turn and text of these messages (memory/forget.ts names them by id). */
export function forgottenTextsFor(db: ReadDb, messageIds: readonly string[]): ForgottenText[] {
  const ids = [...new Set(messageIds)].filter(id => typeof id === "string" && id.length > 0);
  const out: ForgottenText[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    out.push(...rowsToForgotten(db.prepare(`SELECT thread_id, text, json FROM messages WHERE id IN (${part.map(() => "?").join(",")})`).all(...part)));
  }
  return out;
}

/** Every message forgotten before this release (for the upgrade prune): a
 * source tombstone is what memory/forget.ts leaves for a forgotten message. */
export function forgottenTextsAll(db: ReadDb): ForgottenText[] {
  return rowsToForgotten(db.prepare(`SELECT m.thread_id, m.text, m.json FROM messages m WHERE m.id IN (
    SELECT s.message_id FROM memory_tombstones t JOIN memory_sources s ON t.target_type='source' AND s.id=t.target_id WHERE s.message_id IS NOT NULL)`).all());
}
