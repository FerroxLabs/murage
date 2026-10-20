// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeps messages.db's write-ahead log short WITHOUT ever holding SQLite's writer lock off the main thread.
//
// A TRUNCATE checkpoint holds the writer lock for the whole copy, so every write on the server thread would either stall
// or fail BUSY while it runs. This module never takes that lock:
//  - A worker thread runs only `wal_checkpoint(PASSIVE)`, which copies pages into the database file and never touches the
//    writer lock. The server connection itself has `journal_size_limit=0`, so the first commit after a fully copied log
//    restarts the log and cuts the file back to its own frames: an ordinary write does the shrinking.
//  - After a deletion the module copies the log with PASSIVE, then makes one tiny write (a "nudge": the same schema
//    version written again, one page-1 frame). That commit restarts the log, and the check below proves the old bytes are gone.
//  - Nothing is refused or held. A nudge that meets a lock simply means "not done yet, try again".
//
// The worker's connection also keeps the file open until the server connection has closed, so the server's close is never
// the last one (a last close would copy the whole log on the way out and hold shutdown).
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
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

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA busy_timeout=0");
db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
parentPort.on("message", (m) => {
  if (m.op === "close") { try { db.close(); } catch {} process.exit(0); }
  if (m.op !== "passive") return;
  let out = { id: m.id, busy: 1, log: -1, checkpointed: -1 };
  try {
    const r = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    out = { id: m.id, busy: Number(r.busy), log: Number(r.log), checkpointed: Number(r.checkpointed) };
  } catch {}
  if (m.holdMs) { const end = Date.now() + m.holdMs; while (Date.now() < end); }
  parentPort.postMessage(out);
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


export interface WalMaintenanceHooks {
  /** Test only: how long the worker holds each PASSIVE answer. */
  holdMs: number;
  /** Test only: milliseconds between retries of a scrub that did not finish (default 30 s). */
  retryMs: number;
  /** Test only: the pauses before each restart of a failed checkpointer (default 1 s, 5 s, 30 s, 2 min, then every 5 min for good; an empty list means no restart). */
  restartDelaysMs: number[];
  /** Test only: the next this-many reads of the log header fail as if the system refused them (EMFILE). */
  unreadableReads: number;
  /** Test only: ends the checkpointer thread abruptly. */
  terminate(): void;
}
export const walMaintenanceTestHooks: WalMaintenanceHooks = {
  holdMs: 0, retryMs: 30_000, restartDelaysMs: [1000, 5000, 30_000, 120_000, 300_000], unreadableReads: 0,
  terminate() { void active?.worker.terminate(); },
};

interface Pending { resolve: (result: PassiveResult) => void }
interface Maintenance {
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
let failedLogged = false;
const UNAVAILABLE: PassiveResult = { busy: 1, log: -1, checkpointed: -1 };

export interface WalMaintenancePorts {
  /** Sets `wal_autocheckpoint` on the server connection (a no-op once it is closed). */
  setAutocheckpoint(pages: number): void;
  /** One tiny committed write on the server connection (same schema version); false when it met a lock or the handle is gone. */
  nudge(): Promise<boolean>;
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

/** Starts the checkpointer for the server connection. Never throws; the server connection keeps `wal_autocheckpoint=1000`
 * (the 1.0.1 behaviour) until the worker reports ready, and goes back to it if the worker ever fails. A worker that fails is
 * started again a bounded number of times; scrubs it owed survive it. */
export function startWalMaintenance(file: string, given: WalMaintenancePorts): void {
  if (active) void retire(active);
  if (portsFile !== file) owed = [];
  ports = given; portsFile = file; stopped = false; restartAttempts = 0;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
  spawnWorker();
  armRetry();
}

function spawnWorker(): void {
  if (stopped || !ports || !portsFile || active) return;
  const file = portsFile, mine = ports;
  let worker: Worker;
  try { worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { file } }); }
  catch (error) { logFailure(error); scheduleRestart(Date.now()); return; }
  worker.unref();
  let markExited!: () => void;
  const m: Maintenance = {
    file, walFile: `${file}-wal`, worker, startedAt: Date.now(), ready: false, failed: false, exitedFlag: false, nextId: 0, waiting: new Map(),
    inflight: null, timer: undefined, lastSize: -1, lastResult: null,
    exited: new Promise<void>(resolve => { markExited = resolve; }),
  };
  active = m; live.add(m);
  const fail = (error?: unknown) => {
    if (m.failed) return;
    m.failed = true; m.ready = false;
    if (m.timer) clearInterval(m.timer);
    for (const pending of m.waiting.values()) pending.resolve(UNAVAILABLE);
    m.waiting.clear(); m.inflight = null;
    if (active === m) {
      active = null; logFailure(error);
      try { mine.setAutocheckpoint(1000); } catch { /* handle closed */ }
      scheduleRestart(m.startedAt);
    }
  };
  worker.on("message", (message: { type?: string } & Partial<PassiveResult> & { id?: number }) => {
    if (message.type === "ready") {
      if (m.failed || active !== m) return;
      m.ready = true;
      try { mine.setAutocheckpoint(0); } catch { /* handle closed */ }
      m.timer = setInterval(() => tick(m), 1000);
      m.timer.unref();
      return;
    }
    if (typeof message.id === "number") {
      const pending = m.waiting.get(message.id);
      if (!pending) return;
      m.waiting.delete(message.id);
      pending.resolve({ busy: Number(message.busy ?? 1), log: Number(message.log ?? -1), checkpointed: Number(message.checkpointed ?? -1) });
    }
  });
  // An error is a failure, not an exit: the thread is only known to be gone when its `exit` event fires.
  worker.on("error", error => fail(error));
  worker.on("exit", () => { fail(); m.exitedFlag = true; live.delete(m); markExited(); });
}

/** After the worker failed: start another, with a growing pause that stops growing at the last delay (a worker that ran a
 * minute before failing starts the pause again). There is no attempt limit: until one runs, the connection keeps its own
 * wal_autocheckpoint=1000 and the scrubs it owed stay pending. */
function scheduleRestart(startedAt: number) {
  if (stopped || restartTimer) return;
  if (Date.now() - startedAt > 60_000) restartAttempts = 0;
  const delays = walMaintenanceTestHooks.restartDelaysMs;
  if (!delays.length) return;
  const delay = delays[Math.min(restartAttempts++, delays.length - 1)]!;
  restartTimer = setTimeout(() => { restartTimer = undefined; spawnWorker(); }, delay);
  restartTimer.unref();
}

function logFailure(error: unknown) {
  if (failedLogged) return;
  failedLogged = true;
  console.warn(`[sqlite] the log checkpointer stopped (${error instanceof Error ? error.message : "worker ended"}); the app's own checkpoints take over`);
}

/** One PASSIVE checkpoint in the worker. At most one runs at a time (callers share it); never rejects. A worker that is not
 * running answers "busy" at once. */
export function checkpointPassive(): Promise<PassiveResult> {
  const m = active;
  if (!m || !m.ready || m.failed) return Promise.resolve(UNAVAILABLE);
  if (m.inflight) return m.inflight;
  const id = ++m.nextId;
  const promise = new Promise<PassiveResult>(resolve => {
    m.waiting.set(id, { resolve });
    try { m.worker.postMessage({ id, op: "passive", holdMs: walMaintenanceTestHooks.holdMs }); }
    catch { m.waiting.delete(id); resolve(UNAVAILABLE); }
  }).then(result => { if (m.inflight === promise) m.inflight = null; m.lastResult = result; return result; });
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
    // No checkpointer, no checkpoint: the server thread never runs one itself, so a slow disk cannot stall it. The scrub
    // stays owed and the restarted checkpointer carries it out.
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
 * independently of any worker and retried through the restarted checkpointer (never a checkpoint on the server thread),
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
  if (active === m) active = null;
  if (m.timer) clearInterval(m.timer);
  m.failed = true; m.ready = false;
  for (const pending of m.waiting.values()) pending.resolve(UNAVAILABLE);
  m.waiting.clear(); m.inflight = null;
  if (m.exitedFlag) return true;
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
  stopped = true; ports = null;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
  owed = [];
  const all = [...live];
  const results = await Promise.all(all.map(m => retire(m, grace, kill)));
  return results.every(Boolean) && live.size === 0;
}

// Under vitest only: lets test cleanup await this copy's checkpointer even after vi.resetModules() made it a stranger.
registerTestHandle("stop", dir => {
  if (dir !== undefined && ![...live].some(m => pathIsWithin(m.walFile, dir)) && !(portsFile && pathIsWithin(portsFile, dir))) return;
  return stopWalMaintenance();
}, () => [...live].flatMap(m => [m.walFile, `${m.file}-shm`]));
