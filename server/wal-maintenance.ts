import { windowsHidePrelude } from "../shared/win-hide-child-process.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeps messages.db's write-ahead log short WITHOUT ever holding SQLite's writer lock off the main thread.
//
// A TRUNCATE checkpoint holds the writer lock for the whole copy, so every write on the server thread would either stall
// or fail BUSY while it runs. This module never takes that lock:
//  - A worker polls committed progress every 25 ms on its own clock, even during synchronous server work.
//    It copies after 4 MiB of growth or 250 ms and retries incomplete copies. One large transaction remains unbounded.
//    maxBacklogKiB records the largest sampled log bytes still to copy, subtracting the last pass's checkpointed
//    frames and their header for the current salt. A restart discards that credit; a fully copied log counts as zero.
//    backlogKiB is the current sample. maxWalFileKiB reports the largest file size, including already copied bytes.
//  - A worker thread runs only `wal_checkpoint(PASSIVE)`, which copies pages into the database file and never touches the
//    writer lock. The server connection itself has `journal_size_limit=0`, so the first commit after a fully copied log
//    restarts the log and cuts the file back to its own frames: an ordinary write does the shrinking.
//  - After a deletion the module copies the log with PASSIVE, then makes one tiny write (a "nudge": the same schema
//    version written again, one page-1 frame). That commit restarts the log, and the check below proves the old bytes are gone.
//  - Nudges never wait on a lock. New owner transactions above the WAL ceiling
//    retry until off-thread recovery catches up; low disk also holds admission.
//  - ONE exception runs a checkpoint on the server thread (IO-IDLE-DRAIN-1018 r3.6c, MurageMain ruling 1): the revoke drain proves its
//    own copy (memory/revoke-budget.ts logCopied, resetCopiedLog, readyLog). It runs PASSIVE only on a tail of at most its own copy debt
//    plus one drain commit at the ceiling (whoever wrote those frames), and resets a log it has seen completely copied with a TRUNCATE
//    under busy_timeout 0 (restored in a finally): it never waits on a reader or a writer, and holds the writer lock only for the reset.
//
// The worker's connection also keeps the file open until the server connection has closed, so the server's close is never
// the last one (a last close would copy the whole log on the way out and hold shutdown).
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { DatabaseBusyError } from "./db-busy.ts";
import { pathIsWithin, registerTestHandle } from "./test-handle-registry.ts";

export interface PassiveResult { busy: number; log: number; checkpointed: number }
/** The salt pair in the log header: a new pair means the log was restarted. */
export interface WalMark { salt1: number; salt2: number }
export interface WalState {
  /** The log could not be read for a reason other than "it is not there" (EMFILE, access denied, I/O error). Nothing may be
   * concluded from such a read: it is neither an empty log nor a scrubbed one. */
  unknown?: boolean;
  /** The log is a well-formed whole number of frames (or empty). */
  aligned: boolean;
  frames: number;
  header: WalMark | null;
  last: WalMark | null;
}

export const STEP_BYTES = 4 * 1024 * 1024;
export const STEP_POLL_MS = 25;
export const DUE_MS = 250;
/** Stop admitting another owner transaction at this retained-WAL size until an
 * off-thread pass catches up. One transaction may cross the ceiling by its own
 * bytes; subsequent turns never extend an indefinitely pinned/dead log. */
export const WAL_ADMISSION_BYTES = 512 * 1024 * 1024;
export function assertWalWriteAdmission(file: string | null = portsFile): void {
  if (!file) return;
  let size: number;
  try { size = statSync(file + "-wal").size; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new DatabaseBusyError("wal-recovery", 0);
  }
  const current = active?.file === file && active.ready && !active.failed ? active : null;
  // One atomic signed 64-bit value retains exact bytes above 2 GiB too.
  const copiedBytes = current ? Atomics.load(current.copied, 0) : 0n;
  if (copiedBytes < 0n || (size >= WAL_ADMISSION_BYTES && (!current || copiedBytes !== BigInt(size))))
    throw new DatabaseBusyError("wal-recovery", 0);
}
let growthTimer: ReturnType<typeof setInterval> | undefined;
let growthWarningBytes = 64 * 1024 * 1024;
let growthWarnings = 0;
function watchGrowth(): void {
  if (growthTimer) clearInterval(growthTimer);
  growthWarningBytes = 64 * 1024 * 1024;
  growthTimer = setInterval(() => {
    if (!portsFile || active?.ready) return;
    let bytes = 0; try { bytes = statSync(portsFile + "-wal").size; } catch { return; }
    if (bytes < growthWarningBytes) return;
    growthWarnings++;
    console.warn(`[wal] checkpointer down: log growing, ${Math.ceil(bytes / 1048576)} MB`);
    while (growthWarningBytes <= bytes) growthWarningBytes *= 2;
  }, 1000);
  growthTimer.unref();
}

/** C2 sync-debt cap: bytes copied by passes that did not end at the end of the log (so SQLite did not sync the db file) before the worker flushes
 * the db file itself. Failed flushes retain debt and retry at DUE_MS intervals. 2 x STEP_BYTES: about 10 ms of main-thread stall on a slow disk (C2-FSYNC-DEBT-RULING). */
export const DEBT_SYNC_BYTES = 8 * 1024 * 1024;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { openSync, fstatSync, readSync, closeSync, fdatasyncSync, statfsSync } = require("node:fs");
const shared = new Int32Array(workerData.shared);
const copied = new BigInt64Array(workerData.copied);
const gen = Atomics.load(shared, 0);
const { stepBytes, pollMs, dueMs, debtBytes, debtFd } = workerData;
// debtFd is a descriptor the main thread owns and never hands over: this worker only flushes it, and NEVER closes it (closing any descriptor on
// messages.db drops every lock the process holds on that file).
const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA busy_timeout=0");
// Finish every statement before returning to the clock. No read snapshot may
// survive a poll and prevent the writer from reusing a fully copied log.
db.prepare("SELECT count(*) AS n FROM sqlite_master").all();
const versionStatement = db.prepare("PRAGMA data_version");
const checkpointStatement = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
const version = () => Number(versionStatement.all()[0].data_version);
const head = Buffer.alloc(32), frame = Buffer.alloc(24);
let diskSampleAt = 0, diskLow = false;
function header() {
  if (Date.now() - diskSampleAt >= 1000) {
    diskSampleAt = Date.now();
    try { const disk = statfsSync(workerData.file); diskLow = disk.bavail * disk.bsize < 64*1048576; }
    catch { diskLow = true; }
    if (diskLow) Atomics.store(copied,0,-1n);
  }
  let fd = -1;
  try {
    fd = openSync(workerData.file + "-wal", "r");
    const stat = fstatSync(fd), size = stat.size;
    Atomics.store(shared, 9, Math.max(Atomics.load(shared, 9), Math.ceil(size / 1024)));
    if (!stat.isFile()) throw Error("not a file");
    if (!size) return { size: 0, salt: null };
    if (size < 32 || readSync(fd, head, 0, 32, 0) !== 32) return { size, salt: null };
    const magic = head.readUInt32BE(0), pageSize = head.readUInt32BE(8);
    if ((magic !== 0x377f0682 && magic !== 0x377f0683) || !pageSize) return { size, salt: null };
    const frameSize = 24 + pageSize, body = size - 32, frames = Math.floor(body / frameSize);
    // A partial frame during a spill is not a failed file read or a commit.
    if (frames && body % frameSize === 0) {
      if (readSync(fd, frame, 0, 24, 32 + (frames - 1) * frameSize) !== 24) throw Error("short frame header");
    }
    return { size, frameSize, salt: head.readUInt32BE(16) + ":" + head.readUInt32BE(20) };
  } catch (error) {
    if (error.code === "ENOENT") return { size: 0, salt: null };
    throw error;
  } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
}
let sampledSalt = null, sampledSize = 0, checkpointedBytes = 0;
let copiedVersion = null, copiedSize = 0;
function sampleBacklog(h, dv) {
  const priorSize = sampledSize;
  if (h.salt === null || h.salt !== sampledSalt || h.size < sampledSize) {
    checkpointedBytes = 0; copiedVersion = null;
  }
  sampledSalt = h.salt; sampledSize = h.size;
  const fullyCopied = copiedVersion !== null && dv === copiedVersion && h.size === copiedSize;
  const backlog = fullyCopied ? 0 : Math.ceil(Math.max(0, h.size - checkpointedBytes) / 1024);
  Atomics.store(shared, 10, backlog);
  Atomics.store(copied,0,diskLow ? -1n : fullyCopied ? BigInt(h.size) : 0n);
  const top = Atomics.load(shared, 5);
  if (backlog > top) { // keep the fields of the sample that set the maximum, so a failing bound can print them
    Atomics.store(shared, 18, Math.ceil(checkpointedBytes / 1024)); Atomics.store(shared, 19, Math.ceil(h.size / 1024));
    Atomics.store(shared, 20, Math.ceil(priorSize / 1024)); Atomics.store(shared, 21, h.salt === null ? -1 : Number(h.salt.split(":")[1]) | 0);
    Atomics.store(shared, 22, Date.now() % 2147483647);
  }
  Atomics.store(shared, 5, Math.max(top, backlog));
}
let lastVersion = version(), lastSalt = null, base = 0, lastAt = Date.now();
let readFailed = false, retry = false, deferredAt = null;
try { const h = header(); sampleBacklog(h, lastVersion); lastSalt = h.salt; base = h.size; } catch { readFailed = true; }
let requested = null, timed = false, unsyncedBytes = 0, debtRetryAt = 0;
const trace = workerData.trace === true; // test hook only (walMaintenanceTestHooks.paceTrace): observes each poll tick, changes nothing
let tickNo = 0;
function close() {
  clearInterval(timer);
  try { db.close(); } catch {}
  parentPort.close();
}
function runPass(kind, reqId = null, holdMs = 0, sample = null) {
  if (Atomics.load(shared, 7)) return;
  if (Atomics.load(shared, 3)) {
    if (kind === "requested") requested = { reqId, holdMs }; else timed = true;
    return;
  }
  { const stop = Date.now() + 2000; while (Atomics.load(shared, 11) && Date.now() < stop) {} } // test only: pause before the running store
  Atomics.store(shared, 3, 1);
  const ranAt = performance.now(); // slot 12 keeps the longest pass (running=1 to running=0), diagnostics and the MAINBUSY allowance
  // Pairs with walResetFence().enter(): enter stores resetWant and then loads running; this stores running and then loads resetWant.
  // One side always sees the other, so a timed pass and a granted reset never both go ahead.
  if (kind === "timed" && Atomics.load(shared, 4)) {
    if (deferredAt === null) deferredAt = Date.now();
    if (Date.now() - deferredAt < dueMs) { Atomics.store(shared, 3, 0); timed = true; return; }
  }
  deferredAt = null;
  if (kind === "timed") timed = false;
  const id = Atomics.add(shared, 1, 1) + 1;
  if (kind === "timed") Atomics.add(shared, 6, 1);
  function finish() {
    // Each spin is bounded; yielding keeps requested work queued behind this pass.
    if (Atomics.load(shared, 8)) sample = null;
    const end = Date.now() + pollMs;
    while (Atomics.load(shared, 8) && !Atomics.load(shared, 7) && Date.now() < end) {}
    if (Atomics.load(shared, 8) && !Atomics.load(shared, 7)) { sample = null; setImmediate(finish); return; }
    let out = { type: "pass", gen, id, kind, reqId };
    if (Atomics.load(shared, 7)) out.cancelled = true;
    else {
      // Snapshot before copying so a commit during PASSIVE remains due on the next poll.
      let before = null;
      try {
        // An immediate timed pass uses the poll's read state. A requested or
        // gate-delayed pass takes a fresh snapshot on this worker instead.
        const { dv, h } = sample ?? { dv: version(), h: header() };
        sampleBacklog(h, dv);
        before = h;
        lastVersion = dv; lastSalt = h.salt; base = h.size; readFailed = false;
      } catch { readFailed = true; }
      const copiedBefore = checkpointedBytes; // sampled just above: 0 for a log with a new salt
      let copiedNow = 0, synced = false;
      let result = { busy: 1, log: -1, checkpointed: -1 };
      try {
        const r = checkpointStatement.all()[0];
        result = { busy: Number(r.busy), log: Number(r.log), checkpointed: Number(r.checkpointed) };
      } catch {}
      try {
        const dv = version(), h = header();
        // Never carry a pass's frame count into a different salt or a shortened log.
        if (before && h.salt !== null && h.salt === before.salt && h.size >= before.size && result.checkpointed >= 0) {
          checkpointedBytes = 32 + result.checkpointed * h.frameSize;
          copiedNow = Math.max(0, checkpointedBytes - copiedBefore);
          // A retained allocation may exceed the current log's frames. Only call it
          // fully copied if neither a commit nor file growth crossed this pass.
          // SQLite syncs the db file only when no commit landed during the pass (it compares against the live log header, while the answer here is the header
          // as the pass began), so log === checkpointed alone does not mean synced: a commit or file growth crossing the pass leaves its pages dirty.
          synced = result.log === result.checkpointed && dv === lastVersion && h.size === before.size;
          copiedVersion = synced ? dv : null;
          copiedSize = h.size;
        }
        sampleBacklog(h, dv);
      } catch { readFailed = true; }
      retry = result.busy !== 0 || result.log > result.checkpointed;
      // Sync debt. A pass that no commit crossed makes SQLite sync the db file (debt 0); a pass that a commit overtook leaves its pages dirty in the cache,
      // and the next pass that is not overtaken flushes all of them at once, on the disk the main thread commits to. The flush is taken here in pieces
      // instead, still inside running=1 (the fence pairing and the MAINBUSY allowance cover it). It never skips or delays a pass.
      if (result.log >= 0 && result.checkpointed >= 0) {
        if (synced) { unsyncedBytes = 0; debtRetryAt = 0; }
        else unsyncedBytes += copiedNow;
      }
      Atomics.store(shared, 16, Math.max(Atomics.load(shared, 16), Math.ceil(copiedNow / 1024)));
      Atomics.store(shared, 14, Math.max(Atomics.load(shared, 14), Math.ceil(unsyncedBytes / 1024)));
      Atomics.store(shared, 13, Math.ceil(unsyncedBytes / 1024));
      if (debtFd >= 0 && unsyncedBytes >= debtBytes && Date.now() >= debtRetryAt && !Atomics.load(shared, 7)) {
        try {
          fdatasyncSync(debtFd); Atomics.add(shared, 15, 1);
          unsyncedBytes = 0; debtRetryAt = 0; Atomics.store(shared, 13, 0);
        } catch (error) {
          // Failed syncs pay no debt. Keep copying, but retry flushing at most once
          // per due interval, even when requested passes arrive back to back.
          debtRetryAt = Date.now() + dueMs;
          Atomics.add(shared, 17, 1);
          parentPort.postMessage({ type: "debt-fail", message: error && error.message ? error.message : "fdatasync failed" });
        }
      }
      lastAt = Date.now();
      Object.assign(out, result);
      if (kind === "requested" && holdMs) {
        const end = Date.now() + holdMs;
        while (Date.now() < end) {}
      }
    }
    Atomics.store(shared, 12, Math.max(Atomics.load(shared, 12), Math.ceil(performance.now() - ranAt)));
    Atomics.store(shared, 3, 0);
    Atomics.store(shared, 2, id);
    parentPort.postMessage(out);
    if (Atomics.load(shared, 7)) { close(); return; }
    if (requested) {
      const next = requested; requested = null;
      runPass("requested", next.reqId, next.holdMs);
    }
  }
  finish();
}
const timer = setInterval(() => {
  if (trace) tickNo++;
  if (Atomics.load(shared, 7) || Atomics.load(shared, 3)) return;
  const now = Date.now(), wasTimed = timed, lastThen = lastAt;
  let due = timed;
  let sample = null;
  let work = false, changedNow = false;
  try {
    const dv = version(), h = header(), changed = dv !== lastVersion;
    sampleBacklog(h, dv);
    sample = { dv, h };
    const saltChanged = h.salt !== lastSalt;
    if (saltChanged) base = 0;
    changedNow = changed;
    work = changed && (saltChanged || h.size - base >= stepBytes);
    due ||= work || (changed && now - lastAt >= dueMs);
  } catch { readFailed = true; }
  const retrying = retry || readFailed;
  due ||= retrying && now - lastAt >= dueMs;
  // A failed flush stays due even when subsequent passes copy no new bytes.
  due ||= debtFd >= 0 && unsyncedBytes >= debtBytes && now >= debtRetryAt;
  const before = trace ? Atomics.load(shared, 6) : 0;
  if (due) runPass("timed", null, 0, sample);
  if (trace) parentPort.postMessage({ type: "pace", tick: tickNo, now, lastAt: lastThen, work, changed: changedNow, timed: wasTimed, retry: retrying, started: Atomics.load(shared, 6) !== before });
}, pollMs);
timer.unref();
parentPort.on("message", (m) => {
  if (m.op === "close") {
    Atomics.store(shared, 7, 1);
    if (!Atomics.load(shared, 3)) close();
  } else if (m.op === "passive") runPass("requested", m.reqId, m.holdMs);
});
parentPort.postMessage({ type: "ready" });
`;

/** Pure: reads at most 56 bytes of the log (32 header + 24 header of the last frame). */
export function readWalHeader(walFile: string): WalState {
  let fd = -1;
  try {
    if (walMaintenanceTestHooks.unreadableReads > 0) { walMaintenanceTestHooks.unreadableReads--; throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" }); }
    fd = openSync(walFile, "r");
    const stat = fstatSync(fd);
    // Windows opens a directory for reading (size 0); only a regular file can be the log, so anything else is unknown, never empty
    if (!stat.isFile()) return { unknown: true, aligned: false, frames: 0, header: null, last: null };
    const size = stat.size;
    if (size === 0) return { aligned: true, frames: 0, header: null, last: null };
    const head = Buffer.alloc(32);
    if (size < 32 || readSync(fd, head, 0, 32, 0) !== 32) return { aligned: false, frames: 0, header: null, last: null };
    const magic = head.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) return { aligned: false, frames: 0, header: null, last: null };
    const pageSize = head.readUInt32BE(8), header = { salt1: head.readUInt32BE(16), salt2: head.readUInt32BE(20) };
    const frameSize = 24 + pageSize, body = size - 32, frames = Math.floor(body / frameSize);
    if (!pageSize || body % frameSize !== 0) return { aligned: false, frames, header, last: null };
    if (frames === 0) return { aligned: true, frames, header, last: header };
    const frame = Buffer.alloc(24);
    if (readSync(fd, frame, 0, 24, 32 + (frames - 1) * frameSize) !== 24) return { aligned: false, frames, header, last: null };
    return { aligned: true, frames, header, last: { salt1: frame.readUInt32BE(8), salt2: frame.readUInt32BE(12) } };
  } catch (error) {
    // Only a missing file proves the log is empty. Any other failure leaves the state unknown.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { aligned: true, frames: 0, header: null, last: null };
    return { unknown: true, aligned: false, frames: 0, header: null, last: null };
  } finally { if (fd >= 0) try { closeSync(fd); } catch { /* closed */ } }
}

const sameMark = (a: WalMark | null, b: WalMark | null) => Boolean(a && b && a.salt1 === b.salt1 && a.salt2 === b.salt2);

/** What the log looked like when a deletion committed: its salt, null (confirmed empty or absent), or "unknown" (the read
 * failed, so nothing can later be proven against it except an empty log). */
export type WalSince = WalMark | null | "unknown";

/** The log's salt as it is now (null when the log is empty or absent, "unknown" when it could not be read). */
export function walMark(walFile: string): WalSince {
  const state = readWalHeader(walFile);
  return state.unknown ? "unknown" : state.header;
}

/** Stateless: true when no byte written before `since` can still be in the log. The log was restarted since (its header salt
 * differs from `since`) and the file then ends in a frame of the new generation (frames are written in order from the start,
 * so no frame of the old generation is left behind it). A confirmed empty or absent log holds nothing. An unreadable log, or an
 * unknown `since` with a log that has frames, proves nothing. */
export function walScrubbed(walFile: string, since: WalSince): boolean {
  const state = readWalHeader(walFile);
  if (state.unknown || !state.aligned) return false;
  if (state.frames === 0) return true;
  if (since === "unknown") return false;
  if (!state.header || !sameMark(state.header, state.last)) return false;
  return since === null || !sameMark(state.header, since);
}


/** One poll tick as the worker's scheduler saw it (test hook only). `work` is the scheduler's own committed-work decision (data_version changed, and a new
 * salt or a step of growth since the last pass; a pass deferred by the reset fence shows work=true, started=false); `retry` is its reader-blocked or failed-read retry flag; `now` and `lastAt` are the clocks it compared. */
export interface PaceTick { tick: number; now: number; lastAt: number; work: boolean; changed: boolean; timed: boolean; retry: boolean; started: boolean }
export interface WalMaintenanceHooks {
  /** Test only: when set before the worker starts, receives one record per poll tick. Observe only: it never changes a tick or a decision. */
  paceTrace: ((tick: PaceTick) => void) | null;
  /** Test only: how long the worker holds each PASSIVE answer. */
  holdMs: number;
  /** Test only: milliseconds between retries of a scrub that did not finish (default 30 s). */
  retryMs: number;
  /** Test only: the least time between two "checkpointer stopped" lines (default 10 minutes). */
  failureLogGapMs: number;
  /** Test only: the pauses before each restart of a failed checkpointer (default 1 s, 5 s, 30 s, 2 min, then every 5 min for good; an empty list means no restart). */
  restartDelaysMs: number[];
  /** Test only: the next this-many reads of the log header fail as if the system refused them (EMFILE). */
  unreadableReads: number;
  /** Test only: ends the checkpointer thread abruptly. */
  terminate(): void;
  holdGate(on: boolean): void;
  /** Test only: the worker waits (at most 2 s) just before it marks a pass running. */
  holdStart(on: boolean): void;
  /** Test only: workers created so far, live workers now, and starts refused because the journal limit could not be pinned. */
  spawned(): number;
  liveWorkers(): number;
  pinRefusals(): number;
  /** Test only: fails the current worker as if it had errored; false when there is none (stopped or retired). */
  failActive(): boolean;
  /** Test only: the descriptor number the sync-debt flush uses (-1: none), and how many replaced descriptors still wait for their workers to exit. */
  debtFd(): number;
  debtOrphans(): number;
  /** Test only: re-arms both one-shot log lines. */
  resetLogOnce(): void;
  captureHandler(): (message: unknown) => void;
  lastResult(): PassiveResult | null;
}
export const walMaintenanceTestHooks: WalMaintenanceHooks = {
  paceTrace: null, failureLogGapMs: 600_000, holdMs: 0, retryMs: 30_000, restartDelaysMs: [1000, 5000, 30_000, 120_000, 300_000], unreadableReads: 0,
  terminate() { void active?.worker.terminate(); },
  holdGate(on) { if (active) Atomics.store(active.shared, 8, Number(on)); },
  holdStart(on) { if (active) Atomics.store(active.shared, 11, Number(on)); },
  spawned() { return generation; },
  liveWorkers() { return live.size; },
  pinRefusals() { return pinRefused; },
  failActive() { const fail = failCurrent; fail?.(); return Boolean(fail); },
  debtFd() { return debtFd?.fd ?? -1; },
  debtOrphans() { return debtOrphans.length; },
  captureHandler() { return active?.handler ?? (() => {}); },
  lastResult() { return active?.lastResult ?? null; },
  resetLogOnce() { refusalLogged = false; lastFailureLogAt = -Infinity; },
};

interface Pending { afterPass: number; resolve: (result: PassiveResult) => void }
export interface WalPass extends Partial<PassiveResult> {
  type: "pass";
  gen: number;
  id: number;
  kind: "requested" | "timed";
  reqId: number | null;
  cancelled?: boolean;
}
const passListeners = new Set<(pass: WalPass) => void>();
let generation = 0;
let requestedPass: WalPass | null = null;
export function onWalPass(listener: (pass: WalPass) => void): () => void {
  passListeners.add(listener);
  return () => { passListeners.delete(listener); };
}
export function lastRequestedPass(): WalPass | null { return requestedPass; }
export function walMaintenanceCounters() {
  if (!active) return null;
  const s = active.shared;
  return { growthWarnings, admissionBlocked: Atomics.load(s, 23) < 0, gen: Atomics.load(s, 0), passSeq: Atomics.load(s, 1), passDone: Atomics.load(s, 2),
    running: Atomics.load(s, 3), resetWant: Atomics.load(s, 4), maxBacklogKiB: Atomics.load(s, 5),
    timedPasses: Atomics.load(s, 6), closing: Atomics.load(s, 7),
    maxWalFileKiB: Atomics.load(s, 9), backlogKiB: Atomics.load(s, 10), maxPassMs: Atomics.load(s, 12),
    unsyncedKiB: Atomics.load(s, 13), maxUnsyncedKiB: Atomics.load(s, 14), debtSyncs: Atomics.load(s, 15), maxPassCopyKiB: Atomics.load(s, 16), debtSyncFailures: Atomics.load(s, 17),
    maxSample: { checkpointedKiB: Atomics.load(s, 18), walKiB: Atomics.load(s, 19), priorSampledKiB: Atomics.load(s, 20), saltLow: Atomics.load(s, 21), atMs: Atomics.load(s, 22) } };
}
export function walResetFence() {
  const shared = active?.shared;
  return {
    enter(): boolean {
      if (!shared) return true;
      Atomics.store(shared, 4, 1);
      return Atomics.load(shared, 3) === 0;
    },
    leave(): void { if (shared) Atomics.store(shared, 4, 0); },
  };
}

interface Maintenance {
  gen: number;
  shared: Int32Array;
  copied: BigInt64Array;
  handler: (message: unknown) => void;
  file: string;
  walFile: string;
  worker: Worker;
  startedAt: number;
  ready: boolean;
  /** No longer usable (the worker errored or ended). It may still be alive until its real exit. */
  failed: boolean;
  /** The worker's real `exit` event has fired. Only that event sets it. */
  exitedFlag: boolean;
  exited: Promise<void>;
  nextId: number;
  waiting: Map<number, Pending>;
  inflight: Promise<PassiveResult> | null;
  timer: ReturnType<typeof setInterval> | undefined;
  lastSize: number;
  lastResult: PassiveResult | null;
}
let active: Maintenance | null = null;
/** Every checkpointer thread that has not really exited yet, usable or not. */
const live = new Set<Maintenance>();
let refusalLogged = false;
let lastFailureLogAt = -Infinity;
const UNAVAILABLE: PassiveResult = { busy: 1, log: -1, checkpointed: -1 };

export interface WalMaintenancePorts {
  /** Sets `wal_autocheckpoint` on the server connection (a no-op once it is closed). */
  setAutocheckpoint(pages: number): void;
  /** One tiny committed write on the server connection (same schema version); false when it met a lock or the handle is gone. */
  nudge(): Promise<boolean>;
  /** The server connection's `journal_size_limit` (prod: JOURNAL_SIZE_LIMIT_BYTES = 0, database.ts:429, set at open in database.ts:295). */
  journalSizeLimit?(): number | null;
  /** Pins `journal_size_limit` to the prod value on the server connection. */
  pinJournalSizeLimit?(): void;
}

// What outlives any one worker: where the log is, how to reach the server connection, and the scrubs still owed.
let ports: WalMaintenancePorts | null = null;
let portsFile: string | null = null;
/** True once the caller stopped the module; no worker is restarted and no retry runs. */
let stopped = true;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let restartAttempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retrying = false;
/** Deletions whose old bytes have not been proven gone, each as the log looked right after its commit. Kept here, not on a
 * worker, so a worker that dies takes nothing with it. */
let owed: WalSince[] = [];
const sameSince = (a: WalSince, b: WalSince) => a === b || (a !== null && b !== null && a !== "unknown" && b !== "unknown" && a.salt1 === b.salt1 && a.salt2 === b.salt2);
function owe(mark: WalSince) {
  if (!owed.some(item => sameSince(item, mark))) owed.push(mark);
  armRetry();
}
function settleOwed() {
  if (!portsFile) return;
  const file = `${portsFile}-wal`;
  owed = owed.filter(mark => !walScrubbed(file, mark));
  if (!owed.length && retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
}

/** Starts off-thread copying. Autocheckpoint stays disabled through readiness,
 * failure and restart gaps. Admission bounds growth; outstanding scrubs survive. */
export function startWalMaintenance(file: string, given: WalMaintenancePorts): void {
  if (active) void retire(active);
  if (portsFile !== file) owed = [];
  ports = given; portsFile = file; stopped = false; restartAttempts = 0; refusalLogged = false; // each start session reports its own refusal once
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
  try { given.setAutocheckpoint(0); } catch { /* handle closed */ }
  watchGrowth();
  spawnWorker();
  armRetry();
}

let pinRefused = 0;
let failCurrent: (() => void) | null = null;
/** r3.9: the backlog accounting (r3.7) assumes a copied log is cut back by the next commit, which a negative journal_size_limit prevents. Before
 * any worker exists the tracked connection is pinned to its non-negative prod value and read back. False (and no worker, no extra connection) when
 * it cannot be verified; any exception counts as not verified. A port set without the getter is not tracked. */
function journalLimitReady(mine: WalMaintenancePorts): boolean {
  try {
    const limit = mine.journalSizeLimit?.();
    // null = the tracked handle is no longer the open connection (database.ts:404). That is not a refusal: the prior code spawned unconditionally,
    // and the next open calls startWalMaintenance again with the limit set at open (database.ts:295), so a worker for a gone handle is harmless.
    if (limit === undefined || limit === null || limit >= 0) return true;
    mine.pinJournalSizeLimit?.();
    const after = mine.journalSizeLimit?.();
    return after !== undefined && after !== null && after >= 0;
  } catch { return false; }
}
function spawnWorker(): void {
  if (stopped || !ports || !portsFile || active) return;
  const file = portsFile, mine = ports;
  if (!journalLimitReady(mine)) {
    // No worker: keep automatic checkpoints disabled; retry off-thread recovery.
    pinRefused++;
    try { mine.setAutocheckpoint(0); } catch { /* handle closed */ }
    logRefusal();
    scheduleRestart(Date.now());
    return;
  }
  refusalLogged = false; // the limit verified: a later refusal is news again
  const shared = new Int32Array(new SharedArrayBuffer(24 * Int32Array.BYTES_PER_ELEMENT));
  const copied = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  const gen = ++generation;
  Atomics.store(shared, 0, gen);
  let worker: Worker;
  try { worker = new Worker(windowsHidePrelude + WORKER_SOURCE, { eval: true, workerData: {
    file, shared: shared.buffer, copied: copied.buffer, stepBytes: STEP_BYTES, pollMs: STEP_POLL_MS, dueMs: DUE_MS, debtBytes: DEBT_SYNC_BYTES, debtFd: debtFdFor(file), trace: walMaintenanceTestHooks.paceTrace !== null,
  } }); }
  catch (error) { logFailure(error); scheduleRestart(Date.now()); return; }
  worker.unref();
  let markExited!: () => void;
  const m: Maintenance = {
    gen, shared, copied, handler: () => {}, file, walFile: `${file}-wal`, worker, startedAt: Date.now(), ready: false, failed: false, exitedFlag: false, nextId: 0, waiting: new Map(),
    inflight: null, timer: undefined, lastSize: -1, lastResult: null,
    exited: new Promise<void>(resolve => { markExited = resolve; }),
  };
  active = m; live.add(m);
  failCurrent = () => fail(new Error("test"));
  const fail = (error?: unknown) => {
    if (m.failed) return;
    m.failed = true; m.ready = false;
    // A worker that failed is closed like a stopped one: a healthy thread must not keep polling and copying outside the fence.
    if (!m.exitedFlag) { try { void worker.terminate(); } catch { /* already gone */ } }
    if (m.timer) clearInterval(m.timer);
    for (const pending of m.waiting.values()) pending.resolve(UNAVAILABLE);
    m.waiting.clear(); m.inflight = null;
    if (active === m) {
      active = null; failCurrent = null; logFailure(error);
      try { mine.setAutocheckpoint(0); } catch { /* handle closed */ }
      scheduleRestart(m.startedAt);
    }
  };
  let lastDelivered = 0; // pass ids arrive in order from one worker: anything at or below the last is a duplicate (bounded, no id set)
  m.handler = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Partial<WalPass> & { type?: string };
    if ((raw as { type?: string }).type === "ready") {
      if (m.failed || active !== m) return;
      m.ready = true;
      try { mine.setAutocheckpoint(0); } catch { /* handle closed */ }
      m.timer = setInterval(() => tick(m), 1000);
      m.timer.unref();
      return;
    }
    if ((raw as { type?: string }).type === "debt-fail") { logDebtFailure((raw as { message?: unknown }).message); return; }
    if ((raw as { type?: string }).type === "pace") { if (active === m) walMaintenanceTestHooks.paceTrace?.(raw as PaceTick); return; }
    if (message.type !== "pass" || message.gen !== m.gen || typeof message.id !== "number" || message.id <= lastDelivered) return;
    lastDelivered = message.id;
    const pass = message as WalPass;
    for (const listener of passListeners) {
      try { listener(pass); } catch { /* one observer cannot prevent delivery */ }
    }
    if (active !== m || m.failed) return;
    const result = { busy: Number(pass.busy ?? 1), log: Number(pass.log ?? -1), checkpointed: Number(pass.checkpointed ?? -1) };
    if (!pass.cancelled) m.lastResult = result;
    if (pass.kind !== "requested" || pass.reqId === null) return;
    const pending = m.waiting.get(pass.reqId);
    if (!pending || pass.id <= pending.afterPass) return;
    m.waiting.delete(pass.reqId);
    requestedPass = pass;
    pending.resolve(result);
  };
  worker.on("message", m.handler);
  // An error is a failure, not an exit: the thread is only known to be gone when its `exit` event fires.
  worker.on("error", error => fail(error));
  worker.on("exit", () => { fail(); m.exitedFlag = true; live.delete(m); releaseDebtFds(); markExited(); });
}

/** After the worker failed: start another, with a growing pause that stops growing at the last delay (a worker that ran a
 * minute before failing starts the pause again). There is no attempt limit;
 * automatic checkpoints stay disabled and outstanding scrubs stay pending. */
function scheduleRestart(startedAt: number) {
  if (stopped || restartTimer) return;
  if (Date.now() - startedAt > 60_000) restartAttempts = 0;
  const delays = walMaintenanceTestHooks.restartDelaysMs;
  if (!delays.length) return;
  const delay = delays[Math.min(restartAttempts++, delays.length - 1)]!;
  restartTimer = setTimeout(() => { restartTimer = undefined; spawnWorker(); }, delay);
  restartTimer.unref();
}

/** The start was refused (no checkpointer ever ran): its own one-shot line, so the first real failure of a later worker still logs. */
function logRefusal() {
  if (refusalLogged) return;
  refusalLogged = true;
  console.warn("[sqlite] the log checkpointer did not start (journal_size_limit could not be verified); the log stays queued for off-thread recovery");
}

function logFailure(error: unknown) {
  // The gap is the only limit (monotonic clock): the first failure always writes its line, and a worker that keeps failing, with or without ever reaching
  // ready, is reported again once per gap. A failure the gap swallows changes nothing, so it can never silence a later one for good.
  const now = performance.now();
  if (now - lastFailureLogAt < walMaintenanceTestHooks.failureLogGapMs) return;
  lastFailureLogAt = now;
  console.warn(`[sqlite] the log checkpointer stopped (${error instanceof Error ? error.message : "worker ended"}); the log stays queued for off-thread recovery`);
}

// ── C2 sync-debt cap: the flush descriptor ─────────────────────────────────────
// POSIX locks belong to the process and the file: closing ANY descriptor on messages.db drops every lock this process holds on it, the server connection
// included. So exactly one descriptor is opened (here, on the main thread, after the server connection is open), every worker flushes that number and never
// closes it, and it is closed only by closeDebtFd (stopWalMaintenance, after the server connection and every worker are gone). A start on the same file
// and inode (a worker restart, a reopen) keeps it. A start on a replaced file (restore, rename) opens a new one and parks the old one until the workers that
// could still use it have exited; the old inode has no other holder, so closing it then drops no lock that matters.
interface DebtFd { fd: number; file: string; dev: bigint | null; ino: bigint | null }
let debtFd: DebtFd | null = null;
const debtOrphans: { fd: number; users: Maintenance[] }[] = [];
let lastDebtLogAt = -Infinity;
function logDebtFailure(error: unknown) {
  const now = performance.now(); // its own gap: a swallowed flush failure never silences a checkpointer failure line
  if (now - lastDebtLogAt < walMaintenanceTestHooks.failureLogGapMs) return;
  lastDebtLogAt = now;
  console.warn(`[sqlite] a log-debt flush failed (${error instanceof Error ? error.message : String(error)}); the next full checkpoint pass syncs as before`);
}
/** The descriptor a worker for this file flushes, or -1 (the flush is off for that worker; nothing else changes). Never closes anything it opened. */
function debtFdFor(file: string): number {
  try {
    if (debtFd) {
      // Unknown identity cannot prove replacement. Retry the retained descriptor;
      // if this still fails, keep it open until shutdown and disable this worker's
      // explicit flush rather than risking the server connection's process locks.
      if (debtFd.dev === null || debtFd.ino === null) {
        const identity = fstatSync(debtFd.fd, { bigint: true });
        debtFd.dev = identity.dev; debtFd.ino = identity.ino;
      }
      const now = statSync(file, { bigint: true });
      if (debtFd.file === file && debtFd.dev === now.dev && debtFd.ino === now.ino) return debtFd.fd;
      debtOrphans.push({ fd: debtFd.fd, users: [...live] });
      debtFd = null;
      releaseDebtFds();
    }
    const fd = openSync(file, "r+"); // read-write: Windows will not flush a read-only handle. It never writes.
    let dev: bigint | null = null, ino: bigint | null = null;
    try { const stat = fstatSync(fd, { bigint: true }); dev = stat.dev; ino = stat.ino; }
    catch (error) { logDebtFailure(error); } // retained with unknown identity, never evidence of replacement
    debtFd = { fd, file, dev, ino };
    return fd;
  } catch (error) { logDebtFailure(error); return -1; }
}
function releaseDebtFds() {
  for (let index = debtOrphans.length - 1; index >= 0; index--) {
    const orphan = debtOrphans[index]!;
    if (!orphan.users.every(user => user.exitedFlag)) continue;
    try { closeSync(orphan.fd); } catch { /* closed */ }
    debtOrphans.splice(index, 1);
  }
}
function closeDebtFd() {
  if (!debtFd) return;
  try { closeSync(debtFd.fd); } catch { /* closed */ }
  debtFd = null;
}

/** One PASSIVE checkpoint in the worker. At most one runs at a time (callers share it); never rejects. A worker that is not
 * running answers "busy" at once. */
export function checkpointPassive(): Promise<PassiveResult> {
  const m = active;
  if (!m || !m.ready || m.failed) return Promise.resolve(UNAVAILABLE);
  if (m.inflight) return m.inflight;
  const id = ++m.nextId;
  const promise = new Promise<PassiveResult>(resolve => {
    m.waiting.set(id, { resolve, afterPass: Atomics.load(m.shared, 1) });
    try { m.worker.postMessage({ reqId: id, op: "passive", holdMs: walMaintenanceTestHooks.holdMs }); }
    catch { m.waiting.delete(id); resolve(UNAVAILABLE); }
  }).then(result => { if (m.inflight === promise) m.inflight = null; return result; });
  m.inflight = promise;
  return promise;
}

const sleep = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** `promise`, or `fallback` once `ms` have passed, whichever is first. Never rejects. The work itself is not cancelled. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const safe = promise.catch(() => fallback);
  if (ms === Infinity) return safe;
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    void safe.then(value => { clearTimeout(timer); resolve(value); });
  });
}

export interface SettleOptions {
  nudge?: boolean;
  /** Wall-clock time (Date.now) by which every wait in this call must be over. */
  deadlineAt?: number;
}

/** Copies the whole log into the database file; with `nudge`, then writes one tiny frame so the log restarts and shrinks.
 * True when it got as far as it was asked to; false means "not yet" (a reader pins the log, a lock, the worker is gone, the
 * deadline passed). Every await is bounded by `deadlineAt`. */
export async function settleWal(options: SettleOptions = {}): Promise<boolean> {
  const left = () => (options.deadlineAt === undefined ? Infinity : options.deadlineAt - Date.now());
  try {
    const m = active;
    // No checkpointer, no checkpoint: this module never runs one on the server thread (the revoke drain's bounded own copy,
    // header, is the one exception and is not a scrub), so a slow disk cannot stall it. The scrub stays owed and the restarted
    // checkpointer carries it out.
    if (!m || !m.ready || m.failed) return false;
    const result = await within(checkpointPassive(), left(), UNAVAILABLE);
    if (result.log < 0 || result.busy !== 0 || result.log !== result.checkpointed) return false;
    if (!options.nudge) return true;
    if (!ports) return false;
    return await within(ports.nudge(), left(), false);
  } catch { return false; }
}

/** After a deletion has committed: gets the deleted text out of messages.db's log within `ms`. True once it is provably gone;
 * false when a reader, a lock, a failed read of the log or the deadline held it up. The scrub is then owed: it is kept
 * independently of any worker and retried through the restarted checkpointer (never a checkpoint of this module's on the server thread),
 * and the start-up TRUNCATE settles it after a crash. */
export async function scrubWalAfterDelete(ms = 5000): Promise<boolean> {
  if (!ports || !portsFile) return false;
  const walFile = `${portsFile}-wal`;
  const deadline = Date.now() + ms;
  const mark = walMark(walFile);
  owe(mark);
  let delay = 25;
  try {
    for (;;) {
      if (await settleWal({ nudge: true, deadlineAt: deadline }) && walScrubbed(walFile, mark)) {
        owed = owed.filter(item => !sameSince(item, mark));
        settleOwed();
        return true;
      }
      const left = deadline - Date.now();
      if (left <= 0 || stopped) break;
      await sleep(Math.min(delay, left));
      delay = Math.min(delay * 2, 500);
    }
  } catch { /* stays owed */ }
  return false;
}

/** Retries what is owed on the idle timer. The timer outlives any worker: with a checkpointer up the PASSIVE runs there,
 * otherwise it waits for the restarted one. */
function armRetry() {
  if (retryTimer || stopped || !owed.length) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (stopped || !owed.length) return;
    if (retrying) { armRetry(); return; }
    retrying = true;
    void settleWal({ nudge: true, deadlineAt: Date.now() + 5000 })
      .then(() => settleOwed()).catch(() => {}).finally(() => { retrying = false; armRetry(); });
  }, walMaintenanceTestHooks.retryMs);
  retryTimer.unref();
}

function tick(m: Maintenance) {
  if (m.failed || active !== m) return;
  let size = 0;
  try { size = statSync(m.walFile).size; } catch { size = 0; }
  const behind = Boolean(m.lastResult && m.lastResult.log > m.lastResult.checkpointed);
  if ((size !== m.lastSize || behind) && !m.inflight) void checkpointPassive();
  m.lastSize = size;
}

/** True while a deletion's scrub has not been proven yet. */
export function walScrubPending(): boolean { return owed.length > 0; }
/** Test and diagnostics only: whether the checkpointer is up. */
export function walMaintenanceReady(): boolean { return Boolean(active?.ready); }

/** Asks one thread to close (which drops the last connection and removes the log) and ends it after `grace` ms if it does
 * not. Resolves only on the thread's real exit event. */
async function retire(m: Maintenance, grace = 0, kill = 0): Promise<boolean> {
  if (active === m) { active = null; failCurrent = null; }
  if (m.timer) clearInterval(m.timer);
  m.failed = true; m.ready = false;
  for (const pending of m.waiting.values()) pending.resolve(UNAVAILABLE);
  m.waiting.clear(); m.inflight = null;
  if (m.exitedFlag) return true;
  Atomics.store(m.shared, 7, 1);
  try { m.worker.postMessage({ op: "close" }); } catch { /* already ending */ }
  const exitedWithin = (ms: number) => (ms <= 0 ? Promise.resolve(m.exitedFlag) : Promise.race([m.exited.then(() => true), sleep(ms).then(() => false)]));
  if (await exitedWithin(grace)) return true;
  try { void m.worker.terminate(); } catch { /* already gone */ }
  return exitedWithin(kill);
}

/** Ends the checkpointer, and any failed one that has not really left yet: each is asked to close, and ended after `grace` ms
 * if it does not. Resolves true only after every thread has exited (the `exit` event, never `error`); false if one is still
 * alive after `kill` more ms. Stops restarts and retries. Idempotent. Must run AFTER the server connection has closed. */
export async function stopWalMaintenance(grace = 3000, kill = 1500): Promise<boolean> {
  stopped = true; ports = null; failCurrent = null;
  if (growthTimer) { clearInterval(growthTimer); growthTimer = undefined; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
  owed = [];
  const all = [...live];
  const results = await Promise.all(all.map(m => retire(m, grace, kill)));
  const done = results.every(Boolean) && live.size === 0;
  // The flush descriptor is closed here and nowhere else: after the server connection has closed (this function runs after it), after every worker has exited,
  // and only if no start has begun a new session meanwhile (that session keeps using it).
  if (done && stopped) closeDebtFd();
  releaseDebtFds();
  return done;
}

// Under vitest only: lets test cleanup await this copy's checkpointer even after vi.resetModules() made it a stranger.
registerTestHandle("stop", dir => {
  if (dir !== undefined && ![...live].some(m => pathIsWithin(m.walFile, dir)) && !(portsFile && pathIsWithin(portsFile, dir))) return;
  return stopWalMaintenance();
}, () => [...live].flatMap(m => [m.walFile, `${m.file}-shm`]));
