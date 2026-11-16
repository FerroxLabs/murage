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
//    frames and their header for the current salt. Retained frames from an older salt do not count as new debt.
//    A restart discards copy credit; a fully copied log counts as zero.
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
// Admission state producer owner: scperf-p1 (io-budget). Execution-time FGCOPY consumer owner: scperf-p1 (WM).
import { checkpointLedger } from "./admission-shared.ts";
import { ioBudget } from "./io-budget.ts";
import { ioMeterNativeId, ioMeterNativePath, ioMeterPageSize } from "./io-meter.ts";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { DatabaseBusyError } from "./db-busy.ts";

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
  // A worker minute rotation conservatively marks idle until the foreground republishes its current verdict.
  ioBudget.checkpointAdmissionBuffer();
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
const gen = Atomics.load(shared, 0);
const admission = workerData.admission && workerData.admissionSource
  ? (0,eval)("("+workerData.admissionSource+")")(workerData.admission, require("node:worker_threads").threadId, 2000, { gen })
  : {
      beginCopy() { throw Object.assign(new Error("wal-worker: admission ledger unavailable"), { name: "AdmissionLockTimeout" }); },
      endCopy() { throw Object.assign(new Error("wal-worker: admission ledger unavailable"), { name: "AdmissionLockTimeout" }); },
    };
const osPageSize = workerData.osPageSize || 65536;
// P5d/P5g: the meter addon is the parent's private copy. Before require: an absolute, canonical, regular file (O_NOFOLLOW) whose dev, ino, size and sha256 are
// the parent's; any miss is a named error and nothing is required.
function loadNativeMeter(p, id) {
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
  const refuse = (why) => { throw new Error("wal-worker: native meter refused: " + why); };
  if (typeof p !== "string" || !path.isAbsolute(p)) refuse("the path is not absolute");
  if (!id) refuse("no file identity");
  if (!fs.lstatSync(p).isFile()) refuse("not a regular file");
  if (fs.realpathSync(p) !== p) refuse("the path is not canonical");
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== id.dev || st.ino !== id.ino || st.size !== id.size) refuse("the file identity changed");
    const bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, bytes, off, st.size - off, off); if (!n) break; off += n; }
    if (off !== st.size || crypto.createHash("sha256").update(bytes).digest("hex") !== id.sha256) refuse("the file content changed");
  } finally { fs.closeSync(fd); }
  return require(p);
}
const nativeMeter = workerData.nativeMeterPath ? loadNativeMeter(workerData.nativeMeterPath, workerData.nativeMeterId) : null;
const copied = new BigInt64Array(workerData.copied);
// D6: an endCopy that timed out is KEPT and retried at the start of each poll; no new copy is admitted while it is set, and the
// owner-table entry stays charged meanwhile (the main thread reconciles it only if this thread exits).
let pendingEnd = null, tableFullSeen = 0;
const admissionNow = () => Date.now();
function retryPendingEnd() {
  if (!pendingEnd) return;
  try { admission.endCopy(pendingEnd.ticket, pendingEnd.used, pendingEnd.raw, pendingEnd.reading, admissionNow()); pendingEnd = null; }
  catch (error) { if (!(error && error.name === "AdmissionLockTimeout")) throw error; }
}
const { stepBytes, pollMs, dueMs, debtBytes, debtFd } = workerData;
// debtFd is a descriptor the main thread owns and never hands over: this worker only flushes it, and NEVER closes it (closing any descriptor on
// messages.db drops every lock the process holds on that file).
const db = new DatabaseSync(workerData.file,{timeout:50});
db.exec("PRAGMA busy_timeout=0");
// Finish every statement before returning to the clock. No read snapshot may
// survive a poll and prevent the writer from reusing a fully copied log.
db.prepare("SELECT count(*) AS n FROM sqlite_master").all();
const versionStatement = db.prepare("PRAGMA data_version");
const checkpointStatement = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
const version = () => Number(versionStatement.all()[0].data_version);
const head = Buffer.alloc(32), headCheck = Buffer.alloc(32), frame = Buffer.alloc(24);
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
    if (!size) return { size: 0, logSize: 0, salt: null };
    if (size < 32 || readSync(fd, head, 0, 32, 0) !== 32) return { size, logSize: size, salt: null };
    const magic = head.readUInt32BE(0), pageSize = head.readUInt32BE(8);
    if ((magic !== 0x377f0682 && magic !== 0x377f0683) || !pageSize) return { size, logSize: size, salt: null };
    const frameSize = 24 + pageSize, body = size - 32, frames = Math.floor(body / frameSize);
    // A partial spill is not a complete frame or a failed read.
    if (body % frameSize !== 0) return { size, logSize: size, frameSize, pageSize, salt: head.readUInt32BE(16) + ":" + head.readUInt32BE(20) };
    // SQLite can restart a log without shrinking its allocation. Only the
    // contiguous prefix with this header's salts belongs to the current log;
    // counting the old tail both invents copy debt and hides subsequent growth.
    const salt1 = head.readUInt32BE(16), salt2 = head.readUInt32BE(20);
    const currentFrame = count => {
      if (readSync(fd, frame, 0, 24, 32 + (count - 1) * frameSize) !== 24) throw Error("short frame header");
      return frame.readUInt32BE(8) === salt1 && frame.readUInt32BE(12) === salt2;
    };
    let liveFrames = frames;
    if (frames && !currentFrame(frames)) {
      let low = 0, high = frames - 1;
      while (low < high) {
        const mid = low + Math.ceil((high - low) / 2);
        if (currentFrame(mid)) low = mid; else high = mid - 1;
      }
      liveFrames = low;
    }
    // A reset during the bounded search proves no extent for either generation.
    if (readSync(fd, headCheck, 0, 32, 0) !== 32 || !head.equals(headCheck)) throw Error("WAL generation changed");
    return { size, logSize: 32 + liveFrames * frameSize, frameSize, pageSize, salt: salt1 + ":" + salt2 };
  } catch (error) {
    if (error.code === "ENOENT") return { size: 0, logSize: 0, salt: null };
    throw error;
  } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
}
let sampledSalt = null, sampledSize = 0, sampledLogSize = 0, checkpointedBytes = 0;
let copiedVersion = null, copiedSize = 0;
function sampleBacklog(h, dv) {
  const priorSize = sampledLogSize;
  if (h.salt === null || h.salt !== sampledSalt || h.size < sampledSize || h.logSize < sampledLogSize) {
    checkpointedBytes = 0; copiedVersion = null;
  }
  sampledSalt = h.salt; sampledSize = h.size; sampledLogSize = h.logSize;
  const fullyCopied = copiedVersion !== null && dv === copiedVersion && h.size === copiedSize;
  const backlog = fullyCopied ? 0 : Math.ceil(Math.max(0, h.logSize - checkpointedBytes) / 1024);
  Atomics.store(shared, 10, backlog);
  Atomics.store(copied,0,diskLow ? -1n : fullyCopied ? BigInt(h.size) : 0n);
  const top = Atomics.load(shared, 5);
  if (backlog > top) { // keep the fields of the sample that set the maximum, so a failing bound can print them
    Atomics.store(shared, 18, Math.ceil(checkpointedBytes / 1024)); Atomics.store(shared, 19, Math.ceil(h.logSize / 1024));
    Atomics.store(shared, 20, Math.ceil(priorSize / 1024)); Atomics.store(shared, 21, h.salt === null ? -1 : Number(h.salt.split(":")[1]) | 0);
    Atomics.store(shared, 22, Date.now() % 2147483647);
  }
  Atomics.store(shared, 5, Math.max(top, backlog));
}
let lastVersion = version(), lastSalt = null, base = 0, lastAt = Date.now();
let readFailed = false, retry = false, deferredAt = null;
try { const h = header(); sampleBacklog(h, lastVersion); lastSalt = h.salt; base = h.logSize; } catch { readFailed = true; }
let requested = null, timed = false, unsyncedBytes = 0, debtRetryAt = 0;
function close() {
  clearInterval(timer);
  try { db.close(); } catch {}
  parentPort.close();
}
function runPass(kind, reqId = null, sample = null) {
  if (Atomics.load(shared, 7)) return;
  if (Atomics.load(shared, 3)) {
    if (kind === "requested") requested = { reqId }; else timed = true;
    return;
  }
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
  if (kind === "timed") {
    Atomics.add(shared, 6, 1);
  }
  function finish() {
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
        lastVersion = dv; lastSalt = h.salt; base = h.logSize; readFailed = false;
      } catch { readFailed = true; }
      const copiedBefore = checkpointedBytes; // sampled just above: 0 for a log with a new salt
      let copiedNow = 0, synced = false;
      let result = { busy: 1, log: -1, checkpointed: -1 };
      // Whole-copy admission is taken HERE, after any request/gate wait and immediately before PRAGMA.
      const pendingFrames=before&&before.frameSize?Math.ceil(Math.max(0,(before.logSize??before.size)-Math.max(32,checkpointedBytes))/before.frameSize):0;
      const copyPageSpan=Math.ceil((before&&before.pageSize||4096)/osPageSize)*osPageSize;
      const ceiling=pendingFrames*copyPageSpan+osPageSize+4096;
      // D2: a lock that stays held past the ledger's deadline (AdmissionLockTimeout) refuses this copy for this tick, never proceeds as if held;
      // the main thread logs it and counts it (message "admission-timeout" below, io-budget noteLockTimeout, GET /api/health admissionLock).
      let copyTicket=null;
      if(before){
        retryPendingEnd();
        if(!pendingEnd){
          try{copyTicket=admission.beginCopy(ceiling,admissionNow());}
          catch(error){if(error&&error.name==="AdmissionLockTimeout")parentPort.postMessage({type:"admission-timeout",site:"wal-beginCopy"});else throw error;}
          if(!copyTicket&&admission.tableFullCount&&admission.tableFullCount()>tableFullSeen){tableFullSeen=admission.tableFullCount();parentPort.postMessage({type:"admission-table-full"});}
        }
      }
      if(copyTicket){
        const rawBefore=nativeMeter ? nativeMeter.ioGrantSnapshot().threadRawBytes : 0;
        try {
          const r = checkpointStatement.all()[0];
          result = { busy: Number(r.busy), log: Number(r.log), checkpointed: Number(r.checkpointed) };
        } catch {}
        // A whole admitted copy has a conservative charge even if its result is unusable.
        const copiedFrames=result.checkpointed>=0?Math.max(0,result.checkpointed-Math.max(0,(checkpointedBytes-32)/(before.frameSize||4120))):pendingFrames;
        const raw=nativeMeter ? nativeMeter.ioGrantSnapshot().threadRawBytes-rawBefore : 0;
        const meter=nativeMeter ? nativeMeter.ioMeterSnapshot().total : 0;
        const os=nativeMeter ? process.platform==="darwin" ? nativeMeter.diskWritten()||0 : process.platform==="win32" ? 0 : process.resourceUsage().fsWrite*512 : 0;
        // On a timeout the reservation stays charged in full until the minute turns (conservative); the main thread is told.
        const endUsed=Math.ceil(copiedFrames)*copyPageSpan+osPageSize+4096,endReading=nativeMeter?{os,meter}:undefined;
        try{admission.endCopy(copyTicket,endUsed,raw,endReading,admissionNow());}
        catch(error){if(error&&error.name==="AdmissionLockTimeout"){pendingEnd={ticket:copyTicket,used:endUsed,raw,reading:endReading};parentPort.postMessage({type:"admission-timeout",site:"wal-endCopy"});}else throw error;}
      }
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
      Object.assign(out, result, {salt:before&&before.salt, copied:copyTicket!==null});
    }
    Atomics.store(shared, 12, Math.max(Atomics.load(shared, 12), Math.ceil(performance.now() - ranAt)));
    Atomics.store(shared, 3, 0);
    Atomics.store(shared, 2, id);
    parentPort.postMessage(out);
    if (Atomics.load(shared, 7)) { close(); return; }
    if (requested) {
      const next = requested; requested = null;
      runPass("requested", next.reqId);
    }
  }
  finish();
}
const timer = setInterval(() => {
  if (pendingEnd) retryPendingEnd();
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
    work = changed && (saltChanged || h.logSize - base >= stepBytes);
    due ||= work || (changed && now - lastAt >= dueMs);
  } catch { readFailed = true; }
  const retrying = retry || readFailed;
  due ||= retrying && now - lastAt >= dueMs;
  // A failed flush stays due even when subsequent passes copy no new bytes.
  due ||= debtFd >= 0 && unsyncedBytes >= debtBytes && now >= debtRetryAt;
  if (due) runPass("timed", null, sample);
}, pollMs);
timer.unref();
parentPort.on("message", (m) => {
  if (m.op === "close") {
    Atomics.store(shared, 7, 1);
    if (!Atomics.load(shared, 3)) close();
  } else if (m.op === "passive") runPass("requested", m.reqId);
});
parentPort.postMessage({ type: "ready" });
`;

/** Pure: reads at most 56 bytes of the log (32 header + 24 header of the last frame). */
export function readWalHeader(walFile: string): WalState {
  let fd = -1;
  try {
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


interface Pending { afterPass: number; resolve: (result: PassiveResult) => void }
export interface WalPass extends Partial<PassiveResult> {
  type: "pass";
  gen: number;
  id: number;
  kind: "requested" | "timed";
  reqId: number | null;
  cancelled?: boolean;
}
const RETRY_MS = 30_000, FAILURE_LOG_GAP_MS = 600_000, RESTART_DELAYS_MS = [1000, 5000, 30_000, 120_000, 300_000];
let generation = 0;
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
    file, shared: shared.buffer, copied: copied.buffer, admission:(ioBudget.rebuildAdmissionIfPoisoned(), ioBudget.checkpointAdmissionBuffer()), admissionSource:checkpointLedger.toString(), nativeMeterPath:ioMeterNativePath(), nativeMeterId:ioMeterNativeId(), osPageSize:ioMeterPageSize(), stepBytes: STEP_BYTES, pollMs: STEP_POLL_MS, dueMs: DUE_MS, debtBytes: DEBT_SYNC_BYTES, debtFd: debtFdFor(file),
  } }); }
  catch (error) { logFailure(error); scheduleRestart(Date.now()); return; }
  worker.unref();
  let markExited!: () => void;
  const m: Maintenance = {
    gen, shared, copied, handler: () => {}, file, walFile: `${file}-wal`, worker, startedAt: Date.now(), ready: false, failed: false, exitedFlag: false, nextId: 0, waiting: new Map(),
    inflight: null, timer: undefined, lastSize: -1, lastResult: null,
    exited: new Promise<void>(resolve => { markExited = resolve; }),
  };
  const threadId = worker.threadId;
  ioBudget.registerCheckpointer(threadId, gen);
  active = m; live.add(m);
  const fail = (error?: unknown) => {
    if (m.failed) return;
    m.failed = true; m.ready = false;
    // A worker that failed is closed like a stopped one: a healthy thread must not keep polling and copying outside the fence.
    if (!m.exitedFlag) void endWorker(worker, gen);
    if (m.timer) clearInterval(m.timer);
    for (const pending of m.waiting.values()) pending.resolve(UNAVAILABLE);
    m.waiting.clear(); m.inflight = null;
    if (active === m) {
      active = null; logFailure(error);
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
    if ((raw as { type?: string }).type === "admission-table-full") { ioBudget.noteTableFull(); return; }
    if ((raw as { type?: string }).type === "admission-timeout") { ioBudget.noteLockTimeout(String((raw as { site?: unknown }).site ?? "wal-worker")); return; }
    if ((raw as { type?: string }).type === "debt-fail") { logDebtFailure((raw as { message?: unknown }).message); return; }
    if (message.type !== "pass" || message.gen !== m.gen || typeof message.id !== "number" || message.id <= lastDelivered) return;
    lastDelivered = message.id;
    const pass = message as WalPass;
    const copiedMark=raw as {salt?:unknown;checkpointed?:unknown;log?:unknown;copied?:unknown};
    if(copiedMark.copied===true&&typeof copiedMark.salt==="string"&&Number(copiedMark.checkpointed)>=0){
      // The worker's salt is two BE header integers; the debt reader stores their original bytes as hex.
      const pair=copiedMark.salt.split(":").map(Number),salt=Buffer.alloc(8);
      if(pair.length===2&&pair.every(Number.isFinite)){
        salt.writeUInt32BE(pair[0]!>>>0,0);salt.writeUInt32BE(pair[1]!>>>0,4);
        ioBudget.backfilled({salt:salt.toString("hex"),frame:Number(copiedMark.checkpointed),complete:Number(copiedMark.log)>=0&&Number(copiedMark.checkpointed)>=Number(copiedMark.log)});
      }
    }
    if (active !== m || m.failed) return;
    const result = { busy: Number(pass.busy ?? 1), log: Number(pass.log ?? -1), checkpointed: Number(pass.checkpointed ?? -1) };
    if (!pass.cancelled) m.lastResult = result;
    if (pass.kind !== "requested" || pass.reqId === null) return;
    const pending = m.waiting.get(pass.reqId);
    if (!pending || pass.id <= pending.afterPass) return;
    m.waiting.delete(pass.reqId);
    pending.resolve(result);
  };
  worker.on("message", m.handler);
  // An error is a failure, not an exit: the thread is only known to be gone when its `exit` event fires.
  worker.on("error", error => fail(error));
  worker.on("exit", () => {
    fail();
    // Confirmed exit: the only point where a lock the thread still held is recovered (poisons the ledger; never by time).
    ioBudget.checkpointerExited(threadId, gen);
    // A newer checkpointer already started while this one was still going: rebuild now, it will not start again.
    if (active && active !== m) ioBudget.rebuildAdmissionIfPoisoned();
    m.exitedFlag = true; live.delete(m); releaseDebtFds(); markExited(); });
}

/** After the worker failed: start another, with a growing pause that stops growing at the last delay (a worker that ran a
 * minute before failing starts the pause again). There is no attempt limit;
 * automatic checkpoints stay disabled and outstanding scrubs stay pending. */
function scheduleRestart(startedAt: number) {
  if (stopped || restartTimer) return;
  if (Date.now() - startedAt > 60_000) restartAttempts = 0;
  const delays = RESTART_DELAYS_MS;
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
  if (now - lastFailureLogAt < FAILURE_LOG_GAP_MS) return;
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
  if (now - lastDebtLogAt < FAILURE_LOG_GAP_MS) return;
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
  ioBudget.checkpointAdmissionBuffer();
  if (m.inflight) return m.inflight;
  const id = ++m.nextId;
  const promise = new Promise<PassiveResult>(resolve => {
    m.waiting.set(id, { resolve, afterPass: Atomics.load(m.shared, 1) });
    try { m.worker.postMessage({ reqId: id, op: "passive" }); }
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
  }, RETRY_MS);
  retryTimer.unref();
}

function tick(m: Maintenance) {
  if (m.failed || active !== m) return;
  // A rebuild that found the lock busy at the checkpointer start is retried here (an atomic read when the ledger is clean).
  ioBudget.admissionTick();
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
/** Every worker.terminate() goes through here. terminate() runs no finally block, so a worker ended inside the admission ledger
 * keeps its lock word. The main thread never waits for it and never clears the lock on a timer: it awaits the worker's real
 * exit ASYNCHRONOUSLY, then recovers the lock only if the word still holds that thread's token (recoverAdmissionAfterExit,
 * which poisons the ledger until the next checkpointer starts). If no exit arrives within EXIT_BOUND_MS the ledger is
 * poisoned (fail closed) and the lock is left alone. Resolves true on a confirmed exit. */
const EXIT_BOUND_MS = 5000;
function endWorker(worker: Worker, gen: number): Promise<boolean> {
  const id = worker.threadId;
  if (id < 0) return Promise.resolve(true); // already gone: its exit handler did the recovery
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<boolean>(resolve => { worker.once("exit", () => resolve(true)); });
  const bound = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), EXIT_BOUND_MS); timer.unref(); });
  try { void worker.terminate().catch(() => {}); } catch { /* already gone */ }
  return Promise.race([exited, bound]).then(confirmed => {
    clearTimeout(timer);
    if (confirmed) ioBudget.checkpointerExited(id, gen);
    else ioBudget.poisonAdmission(`checkpointer thread ${id} did not exit within ${EXIT_BOUND_MS} ms`);
    return confirmed;
  });
}

async function retire(m: Maintenance, grace = 0, kill = 0): Promise<boolean> {
  if (active === m) { active = null; }
  if (m.timer) clearInterval(m.timer);
  m.failed = true; m.ready = false;
  for (const pending of m.waiting.values()) pending.resolve(UNAVAILABLE);
  m.waiting.clear(); m.inflight = null;
  if (m.exitedFlag) return true;
  Atomics.store(m.shared, 7, 1);
  try { m.worker.postMessage({ op: "close" }); } catch { /* already ending */ }
  const exitedWithin = (ms: number) => (ms <= 0 ? Promise.resolve(m.exitedFlag) : Promise.race([m.exited.then(() => true), sleep(ms).then(() => false)]));
  if (await exitedWithin(grace)) return true;
  void endWorker(m.worker, m.gen); // awaits the real exit, then recovers the admission lock; never by time
  return exitedWithin(kill);
}

/** Ends the checkpointer, and any failed one that has not really left yet: each is asked to close, and ended after `grace` ms
 * if it does not. Resolves true only after every thread has exited (the `exit` event, never `error`); false if one is still
 * alive after `kill` more ms. Stops restarts and retries. Idempotent. Must run AFTER the server connection has closed. */
export async function stopWalMaintenance(grace = 3000, kill = 1500): Promise<boolean> {
  stopped = true; ports = null;
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


