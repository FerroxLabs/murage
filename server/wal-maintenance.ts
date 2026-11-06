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
//
// One exception to "never the writer lock" (SMOOTH-FTS-MERGE R6): the same worker runs the search index's merge in short
// committed slices (search-merge-runner.ts schedules them). Each takes the lock with BEGIN IMMEDIATE under busy_timeout=0, so it
// never waits for the server thread; a server write that meets a slice waits in its own busy handler for that one slice. It never
// checkpoints with TRUNCATE or RESTART.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { pathIsWithin, registerTestHandle } from "./test-handle-registry.ts";

/** `ms`: how long the checkpoint itself took, measured in the worker (0 when no worker answered). */
export interface PassiveResult { busy: number; log: number; checkpointed: number; ms: number }
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

// The worker also runs the search index's merge (designs/SMOOTH-FTS-MERGE-R6.md §1; the scheduler is search-merge-runner.ts). Its connection
// is the one that frees posting pages, so it zeroes them itself (secure_delete), and it is a writer now, so it must not inherit SQLite's
// automatic checkpoint hook or an unlimited log size: each pragma is read back and any other value fails the worker (it is restarted).
// Every op is one transaction under BEGIN IMMEDIATE with busy_timeout=0 (a held lock answers busy at once, never a wait) and every reply
// carries the activation token and the op id it answers.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.file);
const token = workerData.token;
const first = (sql) => { const row = db.prepare(sql).get(); return row ? Number(Object.values(row)[0]) : NaN; };
const setAndRead = (name, value, expect) => {
  db.exec("PRAGMA " + name + "=" + value);
  const got = workerData.failPragma === name ? -1 : first("PRAGMA " + name);
  if (got !== expect) throw new Error("the checkpointer connection read back " + name + "=" + got + ", not " + expect);
};
setAndRead("busy_timeout", 0, 0);
setAndRead("secure_delete", "ON", 1);
setAndRead("synchronous", "NORMAL", 1);
setAndRead("wal_autocheckpoint", 0, 0);
setAndRead("journal_size_limit", 0, 0);
db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
const message = (e) => String((e && e.message) || e);
const isBusy = (e) => Boolean(e && ((typeof e.errcode === "number" && (e.errcode & 0xff) === 5) || /database is locked|SQLITE_BUSY/i.test(message(e))));
// the structure record (id 10): a valid blob, or the op fails (a missing or odd record is never read as "nothing written")
const structure = () => {
  const row = db.prepare("SELECT block FROM messages_fts_data WHERE id = 10").get();
  if (!row || !(row.block instanceof Uint8Array)) throw new Error("the search index structure record is missing or not a blob");
  return Buffer.from(row.block);
};
const segments = () => { try { return first("SELECT count(DISTINCT segid) FROM messages_fts_idx"); } catch { return -1; } };
const hold = (ms) => { if (ms) { const end = Date.now() + ms; while (Date.now() < end); } };
// test only: m.held (an Int32Array on shared memory) is set to 1 once the op's merge ran inside its open transaction, before COMMIT
const held = (m) => { if (m.held instanceof Int32Array) Atomics.store(m.held, 0, 1); };
// one write transaction: BEGIN IMMEDIATE (busy at once), the work, COMMIT; ms is BEGIN..COMMIT
function inWrite(work) {
  const began = performance.now();
  try { db.exec("BEGIN IMMEDIATE"); }
  catch (e) { const ms = performance.now() - began; return isBusy(e) ? { busy: 1, ms, beginMs: ms } : { error: message(e), ms, beginMs: ms }; }
  const beginMs = performance.now() - began;
  try {
    const out = work();
    db.exec("COMMIT");
    return Object.assign(out, { busy: 0, ms: performance.now() - began, beginMs });
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { error: message(e), ms: performance.now() - began, beginMs };
  }
}
const pagesOf = (m) => { const n = Math.trunc(Number(m.pages)); return n >= 1 && n <= 8 ? n : 8; };
const CONFIG_SQL = "SELECT k, v FROM messages_fts_config WHERE k IN ('automerge', 'deletemerge', 'usermerge')";
const readConfig = () => { const out = {}; for (const row of db.prepare(CONFIG_SQL).all()) out[row.k] = Number(row.v); return out; };
const fast = (c) => c.automerge === 0 && c.deletemerge === 0 && c.usermerge === 4;
function run(m) {
  if (m.op === "passive") {
    const began = performance.now();
    let out = { busy: 1, log: -1, checkpointed: -1 };
    try {
      const r = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      out = { busy: Number(r.busy), log: Number(r.log), checkpointed: Number(r.checkpointed) };
    } catch {}
    out.ms = performance.now() - began;
    return out;
  }
  if (m.op === "config") {
    const began = performance.now();
    try {
      let values = readConfig();
      // (m.configReadOnly: test only, reads back without writing, so a forced default config stays and the flag reads false)
      if (!fast(values) && !m.configReadOnly) {
        // literals only: a bound parameter fails with "SQL logic error"
        const wrote = inWrite(() => {
          db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 0)");
          db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('deletemerge', 0)");
          db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('usermerge', 4)");
          return {};
        });
        if (wrote.busy) return { busy: 1, ms: performance.now() - began, values, fast: false };
        if (wrote.error) return { error: wrote.error, ms: performance.now() - began, values, fast: false };
        values = readConfig();
      }
      // the marker: done=0 the index is owed, done=1 the WAL scrub is owed, absent nothing; a failed read means owed
      let marker = null;
      try { const row = db.prepare("SELECT done FROM transcript_index_state WHERE name = 'search_merge'").get(); marker = row ? (Number(row.done) === 1 ? 1 : 0) : null; }
      catch { marker = 0; }
      return { busy: 0, ms: performance.now() - began, values, fast: fast(values), marker };
    } catch (e) { return { error: message(e), ms: performance.now() - began }; }
  }
  if (m.op === "merge-slice") {
    const n = pagesOf(m) * (m.negative ? -1 : 1);
    const out = inWrite(() => {
      const before = structure();
      db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', " + n + ")");
      held(m);
      hold(m.holdMs);
      return { wrote: !before.equals(structure()) };
    });
    if (m.segments) out.segments = segments();
    return out;
  }
  if (m.op === "merge-prove") {
    const n = -pagesOf(m);
    const out = inWrite(() => {
      const before = structure();
      db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', " + n + ")");
      const settled = before.equals(structure());
      if (settled) db.exec("UPDATE transcript_index_state SET done = 1 WHERE name = 'search_merge' AND done = 0");
      held(m);
      hold(m.holdMs);
      return { settled };
    });
    if (m.segments) out.segments = segments();
    return out;
  }
  if (m.op === "scrub-done") {
    const began = performance.now();
    try {
      const r = db.prepare("DELETE FROM transcript_index_state WHERE name = 'search_merge' AND done = 1").run();
      return { busy: 0, ms: performance.now() - began, deleted: Number(r.changes) };
    } catch (e) { return isBusy(e) ? { busy: 1, ms: performance.now() - began } : { error: message(e), ms: performance.now() - began }; }
  }
  return { error: "unknown op " + m.op, ms: 0 };
}
parentPort.on("message", (m) => {
  if (m.op === "close") { try { db.close(); } catch {} process.exit(0); }
  const out = run(m);
  if (m.op === "passive") hold(m.holdMs);
  if (m.drop) return;
  parentPort.postMessage(Object.assign(out, { id: m.id, token, op: m.op }));
});
parentPort.postMessage({ type: "ready", token });
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
  /** Test only: the next worker started reads this pragma back as a wrong value (a worker failure). */
  failPragma: string | null;
}
export const walMaintenanceTestHooks: WalMaintenanceHooks = {
  holdMs: 0, retryMs: 30_000, restartDelaysMs: [1000, 5000, 30_000, 120_000, 300_000], unreadableReads: 0, failPragma: null,
  terminate() { void active?.worker.terminate(); },
};

/** The search-merge ops the worker runs (search-merge-runner.ts posts them; designs/SMOOTH-FTS-MERGE-R6.md §1). */
export type MergeOp =
  | { op: "config" }
  | { op: "merge-slice"; negative: boolean; pages: number }
  | { op: "merge-prove"; pages: number }
  | { op: "scrub-done" };
/** A worker's answer to a MergeOp. `error` means the op did not do what it was asked (never "nothing written", never "settled");
 * `unavailable` means no worker answered it (none ready, it failed, or it was retired). */
export interface MergeReply {
  token: number; id: number; op: string; ms: number; beginMs?: number; busy?: number; error?: string; unavailable?: boolean;
  wrote?: boolean; settled?: boolean; fast?: boolean; values?: Record<string, number>; marker?: 0 | 1 | null; deleted?: number; segments?: number;
}
/** Test only: extra fields passed with each merge op (`holdMs`: hold the write lock that long inside the transaction; `drop`: never reply;
 * `held`: an Int32Array on a SharedArrayBuffer whose slot 0 the worker sets to 1 inside a slice's or prove's open transaction). */
export const mergeOpTestHooks: { extra: Record<string, unknown> } = { extra: {} };

interface Pending { resolve: (message: Record<string, unknown> | null) => void }
interface Maintenance {
  /** The activation this worker belongs to: every startWalMaintenance takes a new one. */
  token: number;
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
const UNAVAILABLE: PassiveResult = { busy: 1, log: -1, checkpointed: -1, ms: 0 };
/** One counter for every request id of every worker: a reply meant for an earlier worker can never match a later request. */
let nextRequestId = 0;
/** The activation counter: startWalMaintenance takes the next one. */
let activation = 0;

/** What the search-merge scheduler hears of the checkpointer's life (search-merge-runner.ts registers it; it is the one listener). */
export interface WalLifecycle {
  /** A new activation (a handle was opened, restored or switched): everything keyed to an older token is void. */
  activated(token: number, file: string): void;
  /** A worker of this activation is ready (the first one, or one restarted after a failure). */
  ready(token: number): void;
  /** The module was stopped: no activation is current. */
  stopped(): void;
}
let lifecycle: WalLifecycle | null = null;
export function setWalLifecycle(given: WalLifecycle | null): void { lifecycle = given; }
const tell = (fn: (l: WalLifecycle) => void) => { if (lifecycle) try { fn(lifecycle); } catch (error) { console.warn("[sqlite] search merge scheduler:", error instanceof Error ? error.message : error); } };
/** The current activation token, or 0 while stopped. */
export function walActivationToken(): number { return stopped ? 0 : activation; }

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
/** Callers waiting for one owed mark to be proven scrubbed (oweWalScrub): resolved true when the mark leaves `owed` because the log
 * was proven restarted past it, false when the list is thrown away (stop, another file) or the activation changes. */
let scrubWaiters: { token: number; mark: WalSince; resolve: (scrubbed: boolean) => void }[] = [];
function owe(mark: WalSince) {
  if (!owed.some(item => sameSince(item, mark))) owed.push(mark);
  armRetry();
}
/** After `owed` lost entries by proof: wakes the waiters whose mark is no longer owed. */
function wakeScrubWaiters() {
  const still: typeof scrubWaiters = [];
  for (const waiter of scrubWaiters) {
    if (waiter.token !== activation || stopped) waiter.resolve(false);
    else if (owed.some(item => sameSince(item, waiter.mark))) still.push(waiter);
    else waiter.resolve(true);
  }
  scrubWaiters = still;
}
/** `owed` is being thrown away without proof: every waiter hears false. */
function dropScrubWaiters() { const all = scrubWaiters; scrubWaiters = []; for (const waiter of all) waiter.resolve(false); }
function settleOwed() {
  if (!portsFile) return;
  const file = `${portsFile}-wal`;
  owed = owed.filter(mark => !walScrubbed(file, mark));
  if (!owed.length && retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
  wakeScrubWaiters();
}

/** The search merge's WAL obligation (designs/SMOOTH-FTS-MERGE-R6.md §2): owes `mark` on the same list scrubWalAfterDelete uses, so the
 * idle retry (PASSIVE, then the nudge) drives it with no deadline, and resolves true once `walScrubbed(walFile, mark)` held for it;
 * false when the activation `token` is no longer current or the module stopped (the durable `done=1` row carries it to the next start). */
export function oweWalScrub(token: number, mark: WalSince): Promise<boolean> {
  if (stopped || token !== activation || !portsFile) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    scrubWaiters.push({ token, mark, resolve });
    owe(mark);
    // already proven (an empty log, or one restarted since the mark was taken): no wait for the retry timer
    settleOwed();
  });
}

/** Starts the checkpointer for the server connection. Never throws; the server connection keeps `wal_autocheckpoint=1000`
 * (the 1.0.1 behaviour) until the worker reports ready, and goes back to it if the worker ever fails. A worker that fails is
 * started again a bounded number of times; scrubs it owed survive it. Each call is a new activation (a new token): the search
 * merge scheduler is started for it, and anything keyed to the previous one is void. */
export function startWalMaintenance(file: string, given: WalMaintenancePorts): number {
  if (active) void retire(active);
  if (portsFile !== file) owed = [];
  ports = given; portsFile = file; stopped = false; restartAttempts = 0;
  const token = ++activation;
  dropScrubWaiters();
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
  tell(l => l.activated(token, file));
  spawnWorker();
  armRetry();
  return token;
}

function spawnWorker(): void {
  if (stopped || !ports || !portsFile || active) return;
  const file = portsFile, mine = ports, token = activation;
  let worker: Worker;
  const failPragma = walMaintenanceTestHooks.failPragma;
  walMaintenanceTestHooks.failPragma = null;
  try { worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { file, token, failPragma } }); }
  catch (error) { logFailure(error); scheduleRestart(Date.now()); return; }
  worker.unref();
  let markExited!: () => void;
  const m: Maintenance = {
    token, file, walFile: `${file}-wal`, worker, startedAt: Date.now(), ready: false, failed: false, exitedFlag: false, waiting: new Map(),
    inflight: null, timer: undefined, lastSize: -1, lastResult: null,
    exited: new Promise<void>(resolve => { markExited = resolve; }),
  };
  active = m; live.add(m);
  const fail = (error?: unknown) => {
    if (m.failed) return;
    m.failed = true; m.ready = false;
    if (m.timer) clearInterval(m.timer);
    for (const pending of m.waiting.values()) pending.resolve(null);
    m.waiting.clear(); m.inflight = null;
    if (active === m) {
      active = null; logFailure(error);
      try { mine.setAutocheckpoint(1000); } catch { /* handle closed */ }
      scheduleRestart(m.startedAt);
    }
  };
  worker.on("message", (message: Record<string, unknown> & { type?: string; id?: number; token?: number }) => {
    // a message from another activation's worker is never acted on
    if (message.token !== m.token) return;
    if (message.type === "ready") {
      if (m.failed || active !== m) return;
      m.ready = true;
      try { mine.setAutocheckpoint(0); } catch { /* handle closed */ }
      m.timer = setInterval(() => tick(m), 1000);
      m.timer.unref();
      tell(l => l.ready(m.token));
      return;
    }
    if (typeof message.id === "number") {
      const pending = m.waiting.get(message.id);
      if (!pending) return;
      m.waiting.delete(message.id);
      pending.resolve(message);
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
  const id = ++nextRequestId;
  const promise = new Promise<PassiveResult>(resolve => {
    // the reply handler: the worker measured the checkpoint's own ms and it is carried through here (0 when no worker answered)
    const answer = (message: Record<string, unknown> | null) => resolve(message
      ? { busy: Number(message.busy ?? 1), log: Number(message.log ?? -1), checkpointed: Number(message.checkpointed ?? -1), ms: Number(message.ms ?? 0) }
      : UNAVAILABLE);
    m.waiting.set(id, { resolve: answer });
    try { m.worker.postMessage({ id, op: "passive", holdMs: walMaintenanceTestHooks.holdMs }); }
    catch { m.waiting.delete(id); resolve(UNAVAILABLE); }
  }).then(result => { if (m.inflight === promise) m.inflight = null; m.lastResult = result; return result; });
  m.inflight = promise;
  return promise;
}

/** Posts one search-merge op to the ready worker of activation `token`. Null when there is none (not ready yet, failed, retired, or
 * another activation is current): the scheduler waits for `ready`. The reply always resolves; a worker that fails or is retired
 * before it answers resolves `{ unavailable: true }`. The worker runs ops in the order they arrive, one at a time, so a merge
 * transaction and a PASSIVE checkpoint never overlap. */
export function postMergeOp(token: number, op: MergeOp): { id: number; reply: Promise<MergeReply> } | null {
  const m = active;
  if (!m || !m.ready || m.failed || m.token !== token || stopped) return null;
  const id = ++nextRequestId;
  const reply = new Promise<MergeReply>(resolve => {
    const answer = (message: Record<string, unknown> | null) => resolve(message
      ? { ...(message as Partial<MergeReply>), token: Number(message.token), id: Number(message.id), op: String(message.op), ms: Number(message.ms ?? 0) }
      : { token, id, op: op.op, ms: 0, unavailable: true, error: "the checkpointer did not answer" });
    m.waiting.set(id, { resolve: answer });
    try { m.worker.postMessage({ ...mergeOpTestHooks.extra, ...op, id }); }
    catch { m.waiting.delete(id); answer(null); }
  });
  return { id, reply };
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
        wakeScrubWaiters();
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
  for (const pending of m.waiting.values()) pending.resolve(null);
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
  dropScrubWaiters();
  tell(l => l.stopped());
  const all = [...live];
  const results = await Promise.all(all.map(m => retire(m, grace, kill)));
  return results.every(Boolean) && live.size === 0;
}

// Under vitest only: lets test cleanup await this copy's checkpointer even after vi.resetModules() made it a stranger.
registerTestHandle("stop", dir => {
  if (dir !== undefined && ![...live].some(m => pathIsWithin(m.walFile, dir)) && !(portsFile && pathIsWithin(portsFile, dir))) return;
  return stopWalMaintenance();
}, () => [...live].flatMap(m => [m.walFile, `${m.file}-shm`]));
