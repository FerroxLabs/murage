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
import { closeSync, fstatSync, openSync, readSync, statfsSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { DatabaseBusyError } from "./db-busy.ts";
// Its own line: the test transform (server/testing/wal-seam-edits.json, wal-maintenance.ts@36) anchors on the import above as it stands.
import { DiskFloorRefusal } from "./db-busy.ts";
import { isReadOnly } from "./read-only-start.ts";
import { WAL_HALF_GATE_BYTES } from "./io-budget.ts";

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
/** 1.0.21 W4/B2: with a commit notice, how often the worker looks at the log with no commit seen: one stat, no SQL. It catches writes on
 * other connections (workers, the helper) and is the heartbeat's pace, so it is kept under half the stall bound. */
export const WAL_IDLE_CHECK_MS = 30_000;
/** The idle check a new worker is given (WAL_IDLE_CHECK_MS). Tests may lower it. */
export const WAL_IDLE_CHECK = { ms: WAL_IDLE_CHECK_MS };
/** Stop admitting another owner transaction at this retained-WAL size until an
 * off-thread pass catches up. One transaction may cross the ceiling by its own
 * bytes; subsequent turns never extend an indefinitely pinned/dead log. */
export const WAL_ADMISSION_BYTES = 512 * 1024 * 1024;
const HEARTBEAT_SLOT = 27;
const admissionBytes = WAL_ADMISSION_BYTES;
/** Seconds-scale in production: a worker whose heartbeat has not moved for this long is replaced (see tick). Long enough for any real pass. */
export const WAL_STALL_MS = 60_000;
const stallMs = WAL_STALL_MS;
/** One stall replacement per window, 5 x the stall bound (300 s in production = the longest restart delay): a replacement is started within the longest
 * restart delay of the stall and judged stalled itself within one more stall bound, so it lands inside the window. */
const stallWindowMs = () => 5 * stallMs;
/** Set while the worker is stalled and was already replaced inside the window: writes at the ceiling are refused as "paused". Clears when the worker's own progress resumes. */
let writesPaused = false;
let lastStallReplaceAt: number | null = null;
export const WAL_PAUSED_MESSAGE = "Writes are paused: the database maintenance worker is not responding. They resume on their own when it recovers.";
/** The user-visible "writes paused" state (it surfaces as the same retryable 503 DATABASE_BUSY with its own op and message). */
export function walWritesPaused(): boolean { return writesPaused; }
export function assertWalWriteAdmission(file: string | null = portsFile): void {
  if (!file) return;
  // A read-only start (read-only-start.ts) admits no write at all, with or without a log.
  if (isReadOnly()) throw new DiskFloorRefusal("read-only-start");
  let size: number;
  try { size = statSync(file + "-wal").size; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new DatabaseBusyError("wal-recovery", 0);
  }
  // A missed owner reading conservatively marks idle (a minute rotation, also one seen first by the worker, keeps the last verdict); the foreground republishes its current verdict here.
  ioBudget.checkpointAdmissionBuffer();
  const current = active?.file === file && active.ready && !active.failed ? active : null;
  // One atomic signed 64-bit value retains exact bytes above 2 GiB too.
  const copiedBytes = current ? Atomics.load(current.copied, 0) : 0n;
  // The worker's disk verdict (free below FLOOR_BYTES) is low disk, not a lagging log: its own type, kept through every wrapper.
  if (copiedBytes < 0n) throw new DiskFloorRefusal("disk-floor");
  if (size >= admissionBytes && (!current || copiedBytes !== BigInt(size))) {
    if (writesPaused) throw new DatabaseBusyError("wal-recovery-paused", 0, WAL_PAUSED_MESSAGE);
    // B5: the owner is told which reader holds the log when one is known
    const holders = walReaderHolders();
    throw new DatabaseBusyError("wal-recovery", 0, ...(holders.length ? [`Busy for a moment, try again (the database log is held open by ${holders.join(", ")})`] : []));
  }
}
/** 1.0.21 B5 (MEMORY-V2-DESIGN 4.8, AF-H8, F21; owner: memv2-D): a reader that keeps a read snapshot pins the log, so no pass can reset it and
 * the owner meets the hard gate. Long readers register here. At the half gate (256 MiB un-copied, the same reading the hard gate uses) the
 * main thread's watch asks memory's own readers once to end their snapshot (`release`, which calls `done` when it has); one that has not
 * within WAL_READER_RELEASE_MS is restarted (`restart`: it is a child memory owns). A reader memory does not own (`memory: false`) cannot be
 * ended by memory: background memory writes stop at the half gate (io-budget B4), the hard gate stays for it (disk safety) and its
 * refusal names it. */
export const WAL_READER_RELEASE_MS = 5000;
export interface WalReader { readonly name: string; readonly memory: boolean; release?(done: () => void): void; restart?(): void }
const walReaders = new Set<WalReader>();
/** One episode per stretch at or past the half gate, bound to the checkpointer that saw it (a restarted one starts clean). Every memory
 * reader is asked once per episode (one registered during it is asked at the next look); each has its own 5 s bound. */
let halfGateEpisode: { owner: object; asked: Set<WalReader>; waiting: Map<WalReader, number>; logged: boolean } | null = null;
export function registerWalReader(reader: WalReader): () => void {
  walReaders.add(reader);
  return () => { walReaders.delete(reader); halfGateEpisode?.waiting.delete(reader); halfGateEpisode?.asked.delete(reader); };
}
/** The readers that may be holding the log now: those memory does not own, then memory's own still asked to let go. */
export function walReaderHolders(): string[] {
  const out: string[] = [];
  for (const r of walReaders) if (!r.memory) out.push(r.name);
  if (halfGateEpisode && halfGateEpisode.owner === active) for (const r of halfGateEpisode.waiting.keys()) out.push(r.name);
  return out.slice(0, 8);
}
/** One step of the half-gate release, from the main thread's 1 s watch (no SQL). */
function releaseWalReaders(owner: object, backlog: number, now: number): void {
  if (backlog < WAL_HALF_GATE_BYTES) { halfGateEpisode = null; return; }
  if (halfGateEpisode?.owner !== owner) halfGateEpisode = { owner, asked: new Set(), waiting: new Map(), logged: false };
  const ep = halfGateEpisode;
  for (const r of [...walReaders]) {
    if (!r.memory || !r.release || ep.asked.has(r)) continue;
    ep.asked.add(r); ep.waiting.set(r, now);
    try { r.release(() => { ep.waiting.delete(r); }); } catch { /* not released: restarted at its bound */ }
  }
  if (!ep.logged) {
    ep.logged = true;
    const foreign = [...walReaders].filter(r => !r.memory).map(r => r.name);
    console.warn(`[wal] ${Math.ceil(backlog / 1048576)} MB of the log not copied: background memory writes stopped; memory's readers asked to let go${foreign.length ? `; held by readers memory does not own: ${foreign.join(", ")}` : ""}`);
  }
  for (const [r, at] of [...ep.waiting]) {
    if (now - at < WAL_READER_RELEASE_MS) continue;
    ep.waiting.delete(r);
    try { r.restart?.(); console.warn(`[wal] ${r.name} did not end its read snapshot within ${WAL_READER_RELEASE_MS} ms: restarted`); } catch { /* its own failure path restarts it */ }
  }
}
/** recalldesign-1020-n1 (owner: recallcap-1020-n3c, the recall reclaimer's WAL yield): the log's size and the bytes the off-thread pass has not
 *  copied yet, by the same reading assertWalWriteAdmission uses. Null when no log is open. */
export function walBacklog(file: string | null = portsFile): { size: number; backlog: number } | null {
  if (!file) return null;
  let size: number;
  try { size = statSync(file + "-wal").size; } catch { return { size: 0, backlog: 0 }; }
  const current = active?.file === file && active.ready && !active.failed ? active : null;
  const copied = current ? Atomics.load(current.copied, 0) : 0n;
  return { size, backlog: copied < 0n ? size : Math.max(0, size - Number(copied)) };
}
/** The worker's live disk verdict: true while free space is under the floor and every guarded write is refused (shown to the owner as diskLow "refusing"). */
export function diskFloorRefusing(): boolean {
  const current = active?.ready && !active.failed ? active : null;
  return current ? Atomics.load(current.copied, 0) < 0n : false;
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
const { openSync, fstatSync, readSync, closeSync, fdatasyncSync, statfsSync, statSync } = require("node:fs");
const shared = new Int32Array(workerData.shared);
// The eval program has its own scope; slots 24 to 26 remain reserved.
const HEARTBEAT_SLOT = 27;
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
const { stepBytes, pollMs, dueMs, debtBytes } = workerData;
const { debt: debtFd, index: indexFd } = workerData.debtFd;
// Main owns both descriptors until the database and all workers close; closing any db/shm descriptor drops the process locks on that file.
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
// W4: the commit notice the event-driven clock waits on (declared here: header() wakes the clock through it)
const noticeCells = workerData.notice ? new Int32Array(workerData.notice) : null;
const nativeLittle = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const indexHead = Buffer.alloc(100);
function checksum(bytes, length, little) {
  let a = 0, b = 0;
  for (let off = 0; off < length; off += 8) {
    a = (a + (little ? bytes.readUInt32LE(off) : bytes.readUInt32BE(off)) + b) >>> 0;
    b = (b + (little ? bytes.readUInt32LE(off + 4) : bytes.readUInt32BE(off + 4)) + a) >>> 0;
  }
  return [a, b];
}
function indexHeader() {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (readSync(indexFd, indexHead, 0, 100, 0) !== 100) continue;
    const word = off => nativeLittle ? indexHead.readUInt32LE(off) : indexHead.readUInt32BE(off);
    const sum = checksum(indexHead, 40, nativeLittle);
    if (indexHead.subarray(0, 48).equals(indexHead.subarray(48, 96)) && indexHead[12] === 1 && sum[0] === word(40) && sum[1] === word(44))
      return { mxFrame: word(16), nBackfill: word(96), salt: indexHead.readUInt32BE(32) + ":" + indexHead.readUInt32BE(36) };
  }
  throw Error("invalid WAL-index header");
}
const databaseIdentity = debtFd >= 0 ? fstatSync(debtFd, { bigint: true }) : statSync(workerData.file, { bigint: true });
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
let headerProof = null;
function headerOnce(fd) {
  const stat = fstatSync(fd, { bigint: true }), size = Number(stat.size);
  if (!sameIdentity(databaseIdentity, statSync(workerData.file, { bigint: true })) || !sameIdentity(stat, statSync(workerData.file + "-wal", { bigint: true }))) throw Error("WAL identity changed");
  Atomics.store(shared, 9, Math.max(Atomics.load(shared, 9), Math.ceil(size / 1024)));
  if (!stat.isFile()) throw Error("not a file");
  if (!size) return { size: 0, logSize: 0, salt: null };
  if (size < 32 || readSync(fd, head, 0, 32, 0) !== 32) return { size, logSize: size, salt: null };
  const magic = head.readUInt32BE(0), pageSize = head.readUInt32BE(8);
  const original = Buffer.from(head), sum = checksum(original, 24, magic === 0x377f0682);
  const valid = (magic === 0x377f0682 || magic === 0x377f0683) && sum[0] === original.readUInt32BE(24) && sum[1] === original.readUInt32BE(28);
  if (!valid) throw Error("invalid WAL header");
  const index = indexHeader();
  if ((magic !== 0x377f0682 && magic !== 0x377f0683) || !pageSize) return { size, logSize: size, salt: null };
  const frameSize = 24 + pageSize, body = size - 32, frames = Math.floor(body / frameSize);
  // A partial spill is not a complete frame or a failed read.
  // SQLite can restart a log without shrinking its allocation. Only the
  // contiguous prefix with this header's salts belongs to the current log;
  // counting the old tail both invents copy debt and hides subsequent growth.
  const salt1 = head.readUInt32BE(16), salt2 = head.readUInt32BE(20);
  const currentFrame = count => {
    if (readSync(fd, frame, 0, 24, 32 + (count - 1) * frameSize) !== 24) throw Error("short frame header");
    return frame.readUInt32BE(8) === salt1 && frame.readUInt32BE(12) === salt2;
  };
  let liveFrames = frames;
  if (body % frameSize === 0 && frames && !currentFrame(frames)) {
    let low = 0, high = frames - 1;
    while (low < high) {
      const mid = low + Math.ceil((high - low) / 2);
      if (currentFrame(mid)) low = mid; else high = mid - 1;
    }
    liveFrames = low;
  }
  // A reset during the bounded search proves no extent for either generation.
  const salt = salt1 + ":" + salt2;
  const snapshot = { stat, size, salt, salt1, pageSize, sequence: original.readUInt32BE(12), valid, index };
  if (readSync(fd, headCheck, 0, 32, 0) !== 32 || !original.equals(headCheck) || index.salt !== salt)
    throw Object.assign(Error("WAL generation changed"), { snapshot });
  return { ...snapshot, logSize: body % frameSize ? size : 32 + liveFrames * frameSize, frameSize, pageSize };
}
function header() {
  if (Date.now() - diskSampleAt >= 1000) {
    diskSampleAt = Date.now();
    const wasLow = diskLow;
    try { const disk = statfsSync(workerData.file); diskLow = disk.bavail * disk.bsize < 64*1048576; }
    catch { diskLow = true; }
    if (diskLow) Atomics.store(copied,0,-1n);
    // W4: a verdict that turns low in a pass the main thread requested finds the clock parked on its idle wait; wake it, so it looks again
    // at the disk cadence (waitMs) and a freed disk clears the refusal with no commit
    if (diskLow && !wasLow && noticeCells) Atomics.notify(noticeCells, 0);
  }
  let fd;
  try { fd = openSync(workerData.file + "-wal", "r"); }
  catch (error) { if (error.code === "ENOENT") return { size: 0, logSize: 0, salt: null }; throw error; }
  // Keep the inode alive across both reads so replacement cannot recycle its identity.
  try {
    let h;
    try { h = headerOnce(fd); }
    catch (error) {
      if (error.message !== "WAL generation changed") throw error;
      // Only SQLite's next generation after a proven full backfill may replace a straddled read.
      const before = error.snapshot, prior = headerProof;
      h = headerOnce(fd);
      if (!prior || !before.valid || !h.valid || prior.salt !== before.salt || prior.sequence !== before.sequence || prior.pageSize !== h.pageSize || before.size < prior.size || prior.index.nBackfill !== prior.index.mxFrame ||
          !sameIdentity(prior.stat, before.stat) || !sameIdentity(before.stat, h.stat) || h.size < before.size ||
          h.sequence !== before.sequence + 1 || h.salt1 !== before.salt1 + 1 || h.salt === before.salt)
        throw error;
    }
    if (h.valid) headerProof = h;
    return h;
  } finally { try { closeSync(fd); } catch {} }
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
  stopped = true;
  if (noticeCells) Atomics.notify(noticeCells, 0);
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
// 1.0.21 W4/B2 (MEMORY-V2-DESIGN 4.8, 4.9; owner lane D): with the main thread's commit notice (wake.ts commitNotice, lane W) the clock is
// event-driven: the worker waits on the notice cell and polls (data_version, the log header) only after a commit, while a pass is owed
// (250 ms after the last commit of a burst, a retry, a held end, an unsynced debt), or when the log's size moved at the 30 s check (a
// writer on another connection). An idle machine costs one stat of the log every 30 s and no SQL. Without a notice (tests that drive this
// clock themselves) it is the 25 ms interval as before.
const idleCheckMs = workerData.idleCheckMs || 30000;
let owed = false;
function poll() {
  Atomics.add(shared, 11, 1); // slot 11: polls (each one a data_version read and a log header read), diagnostics and G-IDLE-PROCESS
  if (pendingEnd) retryPendingEnd();
  if (Atomics.load(shared, 7) || Atomics.load(shared, 3)) return;
  const now = Date.now(), wasTimed = timed, lastThen = lastAt;
  let due = timed;
  let sample = null;
  let work = false, changedNow = false;
  try {
    const dv = version(), h = header();
    const changed = dv !== lastVersion && (h.salt === lastSalt || (h.index && h.index.mxFrame > 0));
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
  owed = (changedNow || retrying) && !due;
  if (due) runPass("timed", null, sample);
}
let stopped = false, seen = noticeCells ? Atomics.load(noticeCells, 0) : 0, walSizeSeen = -1, retryWait = dueMs;
const walSize = () => { try { return statSync(workerData.file + "-wal").size; } catch { return -1; } };
// Heartbeat: the main thread replaces a worker whose count stops moving (a thread stuck in a loop or a call never returns to this clock).
const beat = () => { Atomics.add(shared, HEARTBEAT_SLOT, 1); };
/** What is owed before the next commit, and when: a pass DUE_MS after the last one or a held end; a failed flush at its retry; a pass a
 * reader holds back at a doubling wait (a retry cannot move a reader; a commit or a size change resets it); else only the idle check. */
function waitMs() {
  const at = Date.now();
  // a low-disk verdict refuses the owner's writes, so no commit comes to wake this clock: whatever else waits, it looks again at the disk
  // cadence (1 s) until the verdict clears
  const disk = diskLow ? Math.max(pollMs, diskSampleAt + 1000 - at) : idleCheckMs;
  // never faster than the old 25 ms clock: a pass the reset fence defers (timed) or a held end retries at that pace at most
  if (owed || timed || pendingEnd || requested) return Math.min(disk, Math.max(pollMs, Math.min(dueMs, lastAt + dueMs - at)));
  if (debtFd >= 0 && unsyncedBytes >= debtBytes) return Math.min(disk, Math.max(pollMs, Math.min(idleCheckMs, debtRetryAt - at)));
  if (retry || readFailed) return Math.min(disk, Math.max(pollMs, Math.min(retryWait, lastAt + retryWait - at)));
  return Math.min(disk, idleCheckMs);
}
function step() {
  if (stopped) return;
  beat();
  const cell = Atomics.load(noticeCells, 0), committed = cell !== seen;
  seen = cell;
  const size = walSize(), grew = size !== walSizeSeen;
  walSizeSeen = size;
  if (committed || grew) retryWait = dueMs;
  const due = owed || timed || pendingEnd || requested || (debtFd >= 0 && unsyncedBytes >= debtBytes && Date.now() >= debtRetryAt)
    || ((retry || readFailed) && Date.now() - lastAt >= retryWait);
  // W4: the verdict is refreshed only in header(); with the log unchanged and the owner refused, only this re-sample can clear it
  const diskDue = diskLow && Date.now() - diskSampleAt >= 1000;
  if (committed || grew || due || diskDue) {
    const retrying = (retry || readFailed) && !committed && !grew;
    poll();
    if (retrying && (retry || readFailed)) retryWait = Math.min(idleCheckMs, retryWait * 2);
  }
  wait();
}
function wait() {
  if (stopped) return;
  const waiting = Atomics.waitAsync(noticeCells, 0, seen, waitMs());
  if (waiting.async) waiting.value.then(step); else setImmediate(step);
}
const timer = setInterval(() => {
  poll();
}, pollMs);
timer.unref();
// A test-driven clock (the WAL test transform) keeps driving the poll itself.
const testClock = typeof __walManual !== "undefined" && __walManual;
// a fresh worker (a replacement after a stall or a kill) looks once at start, as the clock did within its first 25 ms: a log left behind
// while writes were refused gets no commit to wake it
if (noticeCells && !testClock) { clearInterval(timer); walSizeSeen = walSize(); poll(); wait(); }
else setInterval(beat, pollMs).unref();
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
    timedPasses: Atomics.load(s, 6), closing: Atomics.load(s, 7), polls: Atomics.load(s, 11), eventDriven: active.notice !== null,
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
  /** W4: the commit notice this worker waits on (null: it polls). */
  notice: SharedArrayBuffer | null;
  lastSize: number;
  lastResult: PassiveResult | null;
  /** Last heartbeat count seen by tick and when it last moved. */
  lastBeat: number;
  beatAt: number;
  /** Marks this worker failed, ends it and schedules its replacement (the supervisor's own failure path). */
  fail: (error?: unknown) => void;
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
  /** 1.0.21 W4 (lane D): the main thread's commit notice (wake.ts commitNotice, bumped at every commit the wake bus observes on the server
   * connection), or null when the bus is not installed there. With it the worker waits on commits and checks the log's size every
   * WAL_IDLE_CHECK_MS; without it the worker polls every STEP_POLL_MS as before (a commit nobody observes is never left unseen). */
  commitNotice?(): SharedArrayBuffer | null;
}

// What outlives any one worker: where the log is, how to reach the server connection, and the scrubs still owed.
let ports: WalMaintenancePorts | null = null;
/** The commit notice the current ports hand out (null: none, the worker polls). */
function noticeOf(): SharedArrayBuffer | null { try { return ports?.commitNotice?.() ?? null; } catch { return null; } }
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
  ports = given; portsFile = file; stopped = false; restartAttempts = 0; refusalLogged = false; writesPaused = false; lastStallReplaceAt = null; // each start session reports its own refusal once
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
  try { given.setAutocheckpoint(0); } catch { /* handle closed */ }
  watchGrowth();
  // B4 (lane D): background admission reads the un-copied log through the same reading the hard gate uses
  ioBudget.setWalBacklog(() => {
    // an unreadable log (any stat error but ENOENT) throws, which the half gate reads as past it (fail closed); walBacklog itself reads it as 0
    try { statSync(file + "-wal"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    return walBacklog(file)?.backlog ?? null;
  });
  // W5 (lane D, D-R4 1.5): the index-debt copy's disk door reads the worker's low-disk verdict and the volume's free space (asked only on an
  // index-debt ask, never on a timer)
  ioBudget.setIndexDebtDisk(() => {
    let free: number | null = null;
    try { const disk = statfsSync(file); free = disk.bavail * disk.bsize; } catch { /* the verdict decides */ }
    return { refusing: diskFloorRefusing(), free };
  });
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
  const shared = new Int32Array(new SharedArrayBuffer((HEARTBEAT_SLOT + 1) * Int32Array.BYTES_PER_ELEMENT));
  const copied = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  const gen = ++generation;
  const notice = noticeOf();
  Atomics.store(shared, 0, gen);
  let worker: Worker;
  try { worker = new Worker(windowsHidePrelude + WORKER_SOURCE, { eval: true, workerData: {
    file, shared: shared.buffer, copied: copied.buffer, admission:(ioBudget.rebuildAdmissionIfPoisoned(), ioBudget.checkpointAdmissionBuffer()), admissionSource:checkpointLedger.toString(), nativeMeterPath:ioMeterNativePath(), nativeMeterId:ioMeterNativeId(), osPageSize:ioMeterPageSize(), stepBytes: STEP_BYTES, pollMs: STEP_POLL_MS, dueMs: DUE_MS, notice, idleCheckMs: Math.min(WAL_IDLE_CHECK.ms, Math.floor(stallMs / 2)), debtBytes: DEBT_SYNC_BYTES, debtFd: { debt: debtFdFor(file), index: indexFdFor(file) },
  } }); }
  catch (error) { logFailure(error); scheduleRestart(Date.now()); return; }
  worker.unref();
  let markExited!: () => void;
  const m: Maintenance = {
    gen, shared, copied, handler: () => {}, file, walFile: `${file}-wal`, worker, startedAt: Date.now(), ready: false, failed: false, exitedFlag: false, nextId: 0, waiting: new Map(),
    inflight: null, timer: undefined, notice, lastSize: -1, lastResult: null, lastBeat: -1, beatAt: Date.now(), fail: () => {},
    exited: new Promise<void>(resolve => { markExited = resolve; }),
  };
  const threadId = worker.threadId;
  ioBudget.registerCheckpointer(threadId, gen);
  active = m; live.add(m);
  const fail = (error?: unknown) => {
    if (m.failed) return;
    m.failed = true; m.ready = false;
    if (active === m) writesPaused = false;
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
  m.fail = fail;
  // A worker that never reports ready is as useless as a dead one: replace it after the stall bound.
  const startWatch = () => {
    if (m.ready || m.failed || active !== m) return;
    if (!replaceStalled(m, "checkpointer did not start")) setTimeout(startWatch, stallMs).unref();
  };
  setTimeout(startWatch, stallMs).unref();
  let lastDelivered = 0; // pass ids arrive in order from one worker: anything at or below the last is a duplicate (bounded, no id set)
  m.handler = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Partial<WalPass> & { type?: string };
    if ((raw as { type?: string }).type === "ready") {
      if (m.failed || active !== m) return;
      m.ready = true; writesPaused = false;
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
let indexFd: DebtFd | null = null;
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
function indexFdFor(databaseFile: string): number {
  const file = databaseFile + "-shm";
  try {
    if (indexFd) {
      // Unknown identity keeps this descriptor until shutdown; it never proves replacement.
      if (indexFd.dev === null || indexFd.ino === null) {
        const identity = fstatSync(indexFd.fd, { bigint: true });
        indexFd.dev = identity.dev; indexFd.ino = identity.ino;
      }
      const now = statSync(file, { bigint: true });
      if (indexFd.file === file && indexFd.dev === now.dev && indexFd.ino === now.ino) return indexFd.fd;
      debtOrphans.push({ fd: indexFd.fd, users: [...live] });
      indexFd = null;
      releaseDebtFds();
    }
    const fd = openSync(file, "r");
    let dev: bigint | null = null, ino: bigint | null = null;
    try { const stat = fstatSync(fd, { bigint: true }); dev = stat.dev; ino = stat.ino; }
    catch (error) { logDebtFailure(error); } // retained with unknown identity, never evidence of replacement
    indexFd = { fd, file, dev, ino };
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
  if (indexFd) { try { closeSync(indexFd.fd); } catch { /* closed */ } indexFd = null; }
  if (!debtFd) return;
  try { closeSync(debtFd.fd); } catch { /* closed */ }
  debtFd = null;
}

/** One PASSIVE checkpoint in the worker. At most one runs at a time (callers share it); never rejects. A worker that is not
 * running answers "busy" at once. */
export function checkpointPassive(): Promise<PassiveResult> {
  const m = active;
  if (!m || !m.ready || m.failed) return Promise.resolve(UNAVAILABLE);
  // Refresh the verdict for this request. If the ledger lock is busy the worker is inside its own copy admission: that miss must not store the strict
  // verdict for an ACTIVE server, or the request posted below is refused by its own refresh before SQLite runs (log -1, a first-try settle answering
  // false). An idle verdict computed by this refresh is still stored on the miss, so a stale active mark never admits work past the idle allowance.
  ioBudget.checkpointAdmissionBuffer(false);
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

/** Called for a worker whose own clock has not moved for the stall bound. Replaces it at most once per window; a worker that stalls again inside the
 * window is kept and writes are paused (honestly refused) until its progress resumes. Returns true when it was replaced. */
function replaceStalled(m: Maintenance, why: string): boolean {
  const at = Date.now();
  if (lastStallReplaceAt !== null && at - lastStallReplaceAt < stallWindowMs()) {
    if (!writesPaused) { writesPaused = true; console.warn("[wal] the replacement checkpointer is stalled too; writes at the log ceiling are paused until it recovers"); }
    return false;
  }
  lastStallReplaceAt = at; writesPaused = false;
  m.fail(new Error(why));
  return true;
}

function tick(m: Maintenance) {
  if (m.failed || active !== m) return;
  // A worker that is alive but not running its clock (stuck in a loop or a call) never copies and never exits: replace it through the failure path.
  const beat = Atomics.load(m.shared, HEARTBEAT_SLOT);
  if (beat !== m.lastBeat) { m.lastBeat = beat; m.beatAt = Date.now(); writesPaused = false; }
  else if (Date.now() - m.beatAt >= stallMs && replaceStalled(m, `checkpointer stalled for ${Date.now() - m.beatAt} ms`)) return;
  // A rebuild that found the lock busy at the checkpointer start is retried here (an atomic read when the ledger is clean).
  ioBudget.admissionTick();
  let size = 0;
  try { size = statSync(m.walFile).size; } catch { size = 0; }
  const copied = m.copied ? Atomics.load(m.copied, 0) : 0n;
  releaseWalReaders(m, copied < 0n ? size : Math.max(0, size - Number(copied)), Date.now());
  // W4: an event-driven worker retries a held-back log itself at a doubling wait; re-requesting it here every second would undo that
  const behind = !m.notice && Boolean(m.lastResult && m.lastResult.log > m.lastResult.checkpointed);
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
  ioBudget.setWalBacklog(null); ioBudget.setIndexDebtDisk(null);
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


