// SPDX-License-Identifier: AGPL-3.0-or-later
// The main connection appends fixed-size references only. FTS lives in search.db,
// written by one worker; its commits cannot change messages.db's data_version.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { windowsHidePrelude } from "../shared/win-hide-child-process.mjs";
import { MESSAGE_SEARCH_DDL } from "./message-tables.ts";
import { SEARCH_INDEX_WORKER_SOURCE } from "./search-index-worker.ts";
import { ioBudget } from "./io-budget.ts";
import { ownerFirst } from "./owner-first.ts";
import { isDatabaseBusy, writersHeldForIndexBuild } from "./db-busy.ts";
import { assertWalWriteAdmission, walMaintenanceCounters, scrubWalAfterDelete } from "./wal-maintenance.ts";
import { beginWrite, endWrite, undoWrite } from "./write-tx.ts";
import { BACKGROUND_BUSY_MS, DEFAULT_BUSY_MS, setBusy } from "./db-busy.ts";
import { registerTestHandle, pathIsWithin } from "./test-handle-registry.ts";

export const SEARCH_FILES = ["search.db", "search.db-wal", "search.db-shm"] as const;
export const MESSAGE_SEARCH_TABLE = "messages_fts";
export const MIN_INDEXED_QUERY_CODEPOINTS = 3;
export const INTENT_MAX_BYTES = 120;
export const PRUNE_PER_COMMIT = 2;
export const IDLE_PRUNE_ROWS = 64;
export const RETIRE_CHUNK_BYTES = 256 * 1024;
export const PENDING_MAX = 2_000;
export const SEARCH_RECOVERY_CONSECUTIVE = 8;
export const SEARCH_RECOVERY_ATTEMPTS = SEARCH_RECOVERY_CONSECUTIVE;
export const SEARCH_RECOVERY_WINDOW_MS = 24 * 3600_000;
export const SEARCH_RECOVERY_WINDOW_MAX = 12;
// Self-contained so serializing the pure function also survives bundle minification.
export function scrubDelay(n: number): number {
  const base = 50, cap = 30_000;
  return Math.min(base * 2 ** Math.min(Math.max(0, n - 1), 10), cap);
}
export const SCRUB_BACKOFF_BASE_MS = scrubDelay(1);
export const SCRUB_BACKOFF_CAP_MS = scrubDelay(50);
export function searchRetryDelay(n: number): number { return Math.max(10, Math.min(SCRUB_BACKOFF_CAP_MS, n)); }
export { MESSAGE_SEARCH_DDL };
export function intentCount(db: DatabaseSync): number {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE name='search_intents'").get()
    ? Number(db.prepare("SELECT COUNT(*) AS n FROM search_intents").get()!.n) : 0;
}
export function searchDbPath(dir: string): string { return join(dir, SEARCH_FILES[0]); }
export function openSearchIndex(dir: string): DatabaseSync { return new DatabaseSync(searchDbPath(dir), { readOnly: true }); }
type RecoveryState = "HEALTHY" | "RECOVERING" | "DEFERRED" | "THROTTLED" | "PARKED";
interface Recovery { state: RecoveryState; consecutive: number; cycleStarts: number[]; markerSeq?: number }
export function recovery(db: DatabaseSync): { state: RecoveryState; consecutive: number; windowCount: number } {
  const current = runs.get(db)?.recovery;
  return { state: current?.state ?? "HEALTHY", consecutive: current?.consecutive ?? 0,
    windowCount: current?.cycleStarts.filter(at => at > searchIndexTestHooks.now() - SEARCH_RECOVERY_WINDOW_MS).length ?? 0 };
}
export const PRUNE_SQL = "DELETE FROM search_intents WHERE seq < ? AND seq IN (SELECT seq FROM search_intents WHERE seq>0 ORDER BY seq LIMIT ?)";
// LIMIT applies BEFORE filtering drops or deduplicating rowids.
export const PENDING_SQL = "SELECT seq,rowid FROM search_intents WHERE seq > ? ORDER BY seq DESC LIMIT ?";
export function threadKey(id: string): string {
  // Hash every id: raw h:<digest> identifiers cannot collide with hashed ids.
  return "h:" + createHash("sha256").update(id).digest("hex").slice(0, 32);
}
export function trigramQuery(needle: string): string {
  const points = [...needle.toLowerCase()], grams = new Set<string>();
  for (let i = 0; i + 3 <= points.length && grams.size < 16; i++) grams.add(points.slice(i, i + 3).join(""));
  return [...grams].map(gram => `"${gram.replace(/"/g, '""')}"`).join(" AND ");
}
export function searchableText(message: { kind: string; text?: string | null; tool?: { name?: unknown } }): string | null {
  if (message.kind === "text") return typeof message.text === "string" && message.text !== "" ? message.text : null;
  const name = message.kind === "activity" ? message.tool?.name : null;
  return typeof name === "string" && name !== "" ? name : null;
}
const nonce = () => randomBytes(8).readBigUInt64BE() & ((1n << 63n) - 1n);
const retirementWarnings = new WeakSet<DatabaseSync>();
// No catch here: losing an intent must roll back the owner's message as well.
export function syncMessageSearchRow(db: DatabaseSync, rowid: number, _text: string | null): void {
  db.prepare("INSERT INTO search_intents(nonce,rowid) VALUES(?,?)").run(nonce(), rowid);
  nudge(db);
}
export function dropThreadSearchRows(db: DatabaseSync, threadId: string): boolean {
  db.prepare("INSERT INTO search_intents(nonce,thread_key) VALUES(?,?)").run(nonce(), threadKey(threadId));
  nudge(db);
  return true;
}
/** Compatibility entry point: no FTS, merge, or checkpoint runs on main. */
export function mergeMessageSearchIndex(_db: DatabaseSync): void { /* worker debt owns cleanup */ }

/** Retire the inherited owner atomically. Once the replacement worker proves
 * its backfill complete, idle passes erase the inert shadows and drop them. */
export function settleInheritedSearchMerge(db: DatabaseSync, _firstOpen: boolean): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts' AND type='table'").get()) return;
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_owner',?,0,0)").run(randomUUID());
    db.prepare("DELETE FROM transcript_index_state WHERE name='search_merge'").run();
    db.prepare("INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_fts',0,0,0)").run();
    let renamed = false;
    for (let i = 1; i <= 8; i++) {
      const name = "messages_fts_retired" + (i === 1 ? "" : `_${i}`);
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name)) continue;
      db.exec("SAVEPOINT search_retire_name");
      try {
        db.exec(`ALTER TABLE messages_fts RENAME TO ${name}`);
        db.exec("RELEASE search_retire_name");
      } catch {
        // R0a must survive a failed R0b too. Keep the old table inert and
        // retry automatic cleanup; no legacy index is ever trusted again.
        db.exec("ROLLBACK TO search_retire_name; RELEASE search_retire_name");
        break;
      }
      renamed = true; break;
    }
    if (own) db.exec("COMMIT");
    if (!renamed && !retirementWarnings.has(db)) {
      retirementWarnings.add(db);
      console.warn("[message-search] legacy index retained; Murage retries cleanup automatically");
    }
  } catch (error) { if (own) db.exec("ROLLBACK"); throw error; }
}
/** One idle transaction on an inert index, after the replacement was verified.
 * Keep FTS's two header rows until xDestroy so a crash between passes can still
 * open/drop the virtual table. Each committed pass is independently restartable.
 * The caller owns idle admission and the background busy budget. */
export function drainRetiredSearchIndexes(db: DatabaseSync): { worked: boolean; complete: boolean } {
  const names = ["messages_fts", ...Array.from({length:8},(_,i)=>"messages_fts_retired"+(i===0?"":`_${i+1}`))];
  const name = names.find(name=>db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  if (!name) return {worked:false,complete:true};
  db.exec("PRAGMA secure_delete=ON");
  try {
    // Recent Node SQLite connections protect FTS shadows by default. Disable
    // that protection only for this synchronous, closed-name migration slice.
    db.enableDefensive?.(false);
    beginWrite(db, "retired_search_cleanup");
    // Shadow names come only from the closed list above, never from input.
    let changed = Number(db.prepare(`DELETE FROM ${name}_data WHERE id IN (SELECT id FROM ${name}_data WHERE id NOT IN(1,10) LIMIT 64)`).run().changes);
    if (!changed) changed = Number(db.prepare(`DELETE FROM ${name}_idx WHERE (segid,term) IN (SELECT segid,term FROM ${name}_idx LIMIT 64)`).run().changes);
    if (!changed) changed = Number(db.prepare(`DELETE FROM ${name}_docsize WHERE id IN (SELECT id FROM ${name}_docsize LIMIT 64)`).run().changes);
    if (!changed) db.exec(`DROP TABLE ${name}`);
    endWrite(db,"retired_search_cleanup");
    return {worked:true,complete:!searchRetirementPending(db)};
  } catch(error) { undoWrite(db,"retired_search_cleanup"); throw error; }
  finally { db.enableDefensive?.(true); }
}
/** Offline recovery route, deliberately never called by the server. The caller
 * must close Murage, acquire EXCLUSIVE locking, BEGIN EXCLUSIVE, invoke this,
 * COMMIT, then require a successful TRUNCATE before publishing completion. */
export function dropRetiredSearchIndexesOffline(db: DatabaseSync): void {
  if (!db.isTransaction || String(db.prepare("PRAGMA locking_mode").get()?.locking_mode).toLowerCase() !== "exclusive")
    throw new Error("offline search cleanup requires exclusive locking and a transaction");
  db.exec("PRAGMA secure_delete=ON");
  const names = ["messages_fts", ...Array.from({ length: 8 }, (_, i) => "messages_fts_retired" + (i === 0 ? "" : `_${i+1}`))];
  for (const name of names) if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)) db.exec(`DROP TABLE ${name}`);
}
export function prepareMessageSearchBackfill(db: DatabaseSync): boolean {
  db.prepare("INSERT OR IGNORE INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_owner',?,0,0)").run(randomUUID());
  return true;
}
interface Cache { indexId: string; applied: number; at: number }
interface SearchRun {
  db: DatabaseSync; file: string; token: string; worker: Worker; reader: DatabaseSync | null;
  indexId: string | null; cache: Cache | null; stopped: boolean; exited: Promise<void>;
  recovery: Recovery; resetMarker?: { seq: number; nonce: string };
  inflight: boolean; scrubTimer?: boolean; nudged?: boolean; ioState?: RecoveryState; timer?: ReturnType<typeof setTimeout>; firstDeferredAt?: number;
}
const runs = new WeakMap<DatabaseSync, SearchRun>();
const live = new Set<SearchRun>();
const sessions = new Set<SearchRun>();
const pendingStarts = new Map<DatabaseSync, { file: string; timer?: ReturnType<typeof setTimeout> }>();
export const searchIndexTestHooks: {
  barrier: { name: string; shared: SharedArrayBuffer } | null;
  event: ((event: { type: string; token: string; [key: string]: unknown }) => void) | null;
  halted: boolean;
  failStart: boolean;
  candidateSnapshot: (() => void) | null;
  fence: () => boolean;
  now: () => number;
  recovery: typeof recovery;
} = { now: () => Date.now(), recovery, barrier: null, event: null, halted: false, failStart: false, candidateSnapshot: null, fence: () => writersHeldForIndexBuild() || walMaintenanceCounters()?.resetWant === 1 };

/** Kept pure to pin ordering and starvation age independently of wall time. */
export function dispatchSearchStep(run: { firstDeferredAt?: number }, now: number, ports: {
  fenced(): boolean; deferred(): number; admit(waitedMs: number): boolean; post(): void;
}): boolean {
  run.firstDeferredAt ??= now;
  if (ports.fenced() || ports.deferred() > 0) return false;
  if (!ports.admit(now - run.firstDeferredAt)) return false;
  ports.post(); run.firstDeferredAt = undefined;
  return true;
}
// Appends only replace the existing scrub timer. An in-flight response also
// observes the wake, so an append cannot be lost between dispatch and reply.
function nudge(db: DatabaseSync): void {
  const run = runs.get(db);
  if (!run || run.stopped || !["HEALTHY", "RECOVERING"].includes(run.recovery.state)) return;
  run.nudged = true;
  if (run.timer && run.scrubTimer) {
    clearTimeout(run.timer); run.timer = undefined;
    schedule(run, 10);
  }
}
function schedule(run: SearchRun, delay = 25, scrubTimer = false): void {
  if (run.stopped || run.timer || !["HEALTHY", "RECOVERING"].includes(run.recovery.state)) return;
  run.scrubTimer = scrubTimer;
  run.timer = setTimeout(() => {
    run.timer = undefined; run.scrubTimer = false;
    searchIndexTestHooks.event?.({ type: "timer", token: run.token });
    if (run.stopped || run.inflight) return;
    const sent = !searchIndexTestHooks.halted && dispatchSearchStep(run, performance.now(), {
      fenced: searchIndexTestHooks.fence,
      deferred: () => ioBudget.deferredForMs("search-index"),
      admit: waitedMs => ownerFirst.admit("search-index", { waitedMs }).admitted,
      post: () => { run.nudged = false; run.inflight = true; run.worker.postMessage({ type: "step", token: run.token }); },
    });
    if (!sent) schedule(run, 100);
  }, delay);
  run.timer.unref();
}
function closeReader(run: SearchRun): void {
  // Cache invalidation precedes the reset ack and every worker unlink.
  run.cache = null; run.indexId = null;
  try { run.reader?.close(); } catch { /* already closed */ } run.reader = null;
}
/** A failed derived index may stay unavailable, but cannot write forever.
 * Explicit stop/start permits another bounded recovery session. */
function recoveryWarning(error: unknown): void {
  console.warn("[message-search] recovery failed:", error instanceof Error ? error.message : String(error));
}
function recoveryBudget(run: SearchRun): boolean {
  if (run.recovery.state === "PARKED") return false;
  if (run.recovery.consecutive >= SEARCH_RECOVERY_CONSECUTIVE) {
    run.recovery.state = "PARKED";
    recoveryWarning("retry limit reached; search remains partial until reopened");
    return false;
  }
  const now = searchIndexTestHooks.now();
  run.recovery.cycleStarts = run.recovery.cycleStarts.filter(at => at > now - SEARCH_RECOVERY_WINDOW_MS);
  if (run.recovery.cycleStarts.length >= SEARCH_RECOVERY_WINDOW_MAX) {
    run.recovery.state = "THROTTLED";
    const delay = run.recovery.cycleStarts[0] + SEARCH_RECOVERY_WINDOW_MS - now;
    console.warn(`[message-search] recovery paused; resumes in ${Math.ceil(delay / 60_000)} min`);
    searchIndexTestHooks.event?.({ type: "recovery-throttled", token: run.token, delay });
    run.timer = setTimeout(() => { run.timer = undefined; if (!run.stopped) acknowledgeSearchReset(run); }, delay);
    run.timer.unref();
    return false;
  }
  return true;
}
function retryRecovery(run: SearchRun, retry: () => void): void {
  if (run.stopped || run.timer || !recoveryBudget(run)) return;
  const delay = Math.min(100 * 2 ** run.recovery.consecutive, 5000);
  run.timer = setTimeout(() => { run.timer = undefined; if (!run.stopped) retry(); }, delay);
  run.timer.unref();
}
function acknowledgeSearchReset(run: SearchRun): void {
  if (run.stopped || (!run.ioState && !recoveryBudget(run))) return;
  const { db } = run;
  if (db.isTransaction || searchIndexTestHooks.fence() || ioBudget.deferredForMs("search-index") > 0 ||
      !ownerFirst.admit("search-index-reset").admitted) {
    run.recovery.state = "DEFERRED";
    retryRecovery(run, () => acknowledgeSearchReset(run)); return;
  }
  let began = false;
  try {
    // A single retained marker serves every retry until ready. Admission refusal
    // and failed marker transactions do not consume a reset cycle.
    assertWalWriteAdmission(run.file);
    if (!run.resetMarker) {
      db.exec("BEGIN IMMEDIATE"); began = true;
      const n = nonce();
      const inserted = db.prepare("INSERT INTO search_intents(nonce,rowid) VALUES(?,0)").run(n);
      db.exec("COMMIT"); began = false;
      run.resetMarker = { seq: Number(inserted.lastInsertRowid), nonce: String(n) };
    }
    if (run.ioState) { run.recovery.state = run.ioState; run.ioState = undefined; }
    run.recovery.consecutive++;
    run.recovery.cycleStarts.push(searchIndexTestHooks.now());
    run.recovery.markerSeq = run.resetMarker.seq;
    run.recovery.state = "RECOVERING";
    searchIndexTestHooks.event?.({ type: "reset-ack", token: run.token, readerClosed: run.reader === null, cacheCleared: run.cache === null });
    run.worker.postMessage({ type: "reset", token: run.token, marker: run.resetMarker });
  } catch (error) {
    if (began) try { db.exec("ROLLBACK"); } catch { /* keep the original failure */ }
    recoveryWarning(error);
    if (storageFull(error)) {
      throttleStorage(run, () => acknowledgeSearchReset(run), 1000); return;
    }
    run.recovery.state = "DEFERRED";
    retryRecovery(run, () => acknowledgeSearchReset(run));
  }
}
function throttleStorage(run: SearchRun, retry: () => void, delay: number): void {
  run.ioState ??= run.recovery.state;
  run.recovery.state = "THROTTLED";
  if (run.timer) clearTimeout(run.timer);
  run.timer = setTimeout(() => { run.timer = undefined; if (!run.stopped) retry(); }, searchRetryDelay(delay));
  run.timer.unref();
}
function retryStorageOperation(run: SearchRun, operation: string): void {
  if (run.db.isTransaction || searchIndexTestHooks.fence() || ioBudget.deferredForMs("search-index") > 0 ||
      !ownerFirst.admit(operation === "step" ? "search-index" : "search-index-reset").admitted) {
    throttleStorage(run, () => retryStorageOperation(run, operation), 100); return;
  }
  run.worker.postMessage({ type: operation, token: run.token, marker: run.resetMarker });
}
function storageFull(error: unknown): boolean {
  const e = error as { code?: string; errcode?: number };
  return e?.code === "ENOSPC" || e?.code === "SQLITE_FULL" || (typeof e?.errcode === "number" && (e.errcode & 255) === 13);
}
function openSearchReader(run: SearchRun, indexId: string): void {
  if (run.stopped) return;
  closeReader(run);
  try {
    run.reader = new DatabaseSync(join(dirname(run.file), SEARCH_FILES[0]), { readOnly: true });
    run.reader.exec("PRAGMA busy_timeout=0; PRAGMA query_only=ON");
    run.indexId = indexId; run.inflight = false;
    // Ready only proves the empty index opened. A persistent error can recur
    // on its first step, so it must not replenish the recovery write budget.
    run.resetMarker = undefined;
    schedule(run);
  } catch (error) {
    closeReader(run); run.inflight = true;
    recoveryWarning(error);
    retryRecovery(run, () => { if (!run.stopped) run.worker.postMessage({ type: "reset-request", token: run.token }); });
  }
}
export function startSearchIndex(db: DatabaseSync, file: string): void {
  const existing = runs.get(db);
  if (existing && !existing.stopped) return;
  if (pendingStarts.has(db)) return;
  const prior = [...live].filter(run => run.file === file && run.db !== db);
  if (prior.length) {
    const pending = { file }; pendingStarts.set(db, pending);
    for (const run of prior) {
      run.stopped = true; sessions.delete(run); closeReader(run);
      if (run.timer) clearTimeout(run.timer);
      run.worker.postMessage({ type: "stop", token: run.token });
      const timer = setTimeout(() => { void run.worker.terminate(); }, 1500); timer.unref();
      void run.exited.then(() => clearTimeout(timer));
    }
    void Promise.all(prior.map(run => run.exited)).then(() => {
      if (pendingStarts.get(db) !== pending) return;
      pendingStarts.delete(db);
      try { if (db.isOpen) startSearchIndex(db, file); } catch { /* a closed handle cannot reactivate */ }
    });
    return;
  }
  prepareMessageSearchBackfill(db);
  const token = randomUUID();
  let worker: Worker;
  try {
    if (searchIndexTestHooks.failStart) throw new Error("fixture worker start failure");
    worker = new Worker(windowsHidePrelude + SEARCH_INDEX_WORKER_SOURCE, { eval: true, workerData: {
    file, searchFile: join(dirname(file), SEARCH_FILES[0]), ddl: MESSAGE_SEARCH_DDL, token, barrier: searchIndexTestHooks.barrier,
    scrubDelaySource: scrubDelay.toString(), scrubBase: SCRUB_BACKOFF_BASE_MS, scrubCap: SCRUB_BACKOFF_CAP_MS,
    recoveryConsecutive: SEARCH_RECOVERY_CONSECUTIVE, recoveryWindowMs: SEARCH_RECOVERY_WINDOW_MS, recoveryWindowMax: SEARCH_RECOVERY_WINDOW_MAX,
    } });
  } catch (error) {
    console.warn("[message-search] worker stopped:", error instanceof Error ? error.message : String(error));
    const pending: { file: string; timer?: ReturnType<typeof setTimeout> } = { file };
    pendingStarts.set(db, pending);
    pending.timer = setTimeout(() => {
      if (pendingStarts.get(db) !== pending) return;
      pendingStarts.delete(db);
      if (db.isOpen) startSearchIndex(db, file);
    }, 1000);
    pending.timer.unref();
    return;
  }
  worker.unref();
  let exited!: () => void;
  const run: SearchRun = { db, file, token, worker, reader: null, indexId: null, cache: null, stopped: false, inflight: true, recovery: { state: "HEALTHY", consecutive: 0, cycleStarts: [] },
    exited: new Promise<void>(resolve => { exited = resolve; }) };
  runs.set(db, run); live.add(run); sessions.add(run);
  worker.on("message", (event: { type: string; token: string; index_id?: string; worked?: boolean; rebuilding?: boolean; applied?: number; retryInMs?: number; operation?: string; message?: string }) => {
    if (event.token !== token || run.stopped || runs.get(db) !== run) return;
    searchIndexTestHooks.event?.(event);
    if ((event.type === "ready" || event.type === "stepped") && run.ioState) {
      run.recovery.state = run.ioState; run.ioState = undefined;
    }
    if (event.type === "storage-full") {
      recoveryWarning(event.message);
      // Retry the same operation, retaining its marker and cycle. No reset is
      // requested for a full disk, and repeated failures spend no reset budget.
      throttleStorage(run, () => retryStorageOperation(run, event.operation ?? "step"), event.retryInMs ?? 1000);
    } else if (event.type === "failure") {
      recoveryWarning(event.message ?? "worker failure");
    } else if (event.type === "reset-needed" || event.type === "reset-retry") {
      closeReader(run); run.inflight = true;
      if (run.timer) { clearTimeout(run.timer); run.timer = undefined; }
      // A busy reset stays a reset: no step can run until it has succeeded.
      if (run.recovery.consecutive === 0) setImmediate(() => acknowledgeSearchReset(run));
      else retryRecovery(run, () => acknowledgeSearchReset(run));
    } else if (event.type === "ready") {
      openSearchReader(run, String(event.index_id));
    } else if (event.type === "stepped") {
      run.inflight = false;
      if (run.recovery.state === "RECOVERING" && event.rebuilding === false && run.reader &&
          event.applied !== undefined && event.applied >= (run.recovery.markerSeq ?? Infinity)) {
        run.recovery.state = "HEALTHY";
        run.recovery.consecutive = 0;
        run.recovery.markerSeq = undefined;
      }
      // Pruning is idle admitted and never paid by a small owner commit.
      try {
        if (!event.worked && !db.isTransaction && !searchIndexTestHooks.fence() && ioBudget.deferredForMs("search-index") === 0 &&
            ownerFirst.admit("search-index-prune").admitted) {
          assertWalWriteAdmission(file);
          ioBudget.withSource("search-index", () => {
          pruneMessageSearchIntents(db, IDLE_PRUNE_ROWS);
          // A ready event alone only proves an empty index. An idle completed
          // step proves the replacement backfill before any inherited bytes go.
          if (event.rebuilding === false && run.reader && searchRetirementPending(db)) {
            setBusy(db, BACKGROUND_BUSY_MS);
            try {
              const retired = drainRetiredSearchIndexes(db);
              if (retired.complete) void scrubWalAfterDelete().catch(recoveryWarning);
            } finally { setBusy(db, DEFAULT_BUSY_MS); }
          }
          });
        }
      } catch (error) { recoveryWarning(error); }
      schedule(run, event.worked || run.nudged ? 10 : searchRetryDelay(event.retryInMs ?? 250),
        !event.worked && !run.nudged && event.retryInMs !== undefined);
    }
  });
  worker.on("error", error => { console.warn("[message-search] worker stopped:", error instanceof Error ? error.message : String(error)); });
  worker.on("exit", () => {
    closeReader(run); live.delete(run); exited();
    if (run.timer) clearTimeout(run.timer);
    if (!run.stopped && runs.get(db) === run) {
      run.stopped = true;
      run.timer = setTimeout(() => {
        run.timer = undefined;
        if (!run.stopped || runs.get(db) !== run) return;
        sessions.delete(run);
        try { startSearchIndex(db, file); } catch { /* next open retries */ }
      }, 1000);
      run.timer.unref();
    } else { sessions.delete(run);
    }
  });
}
export function pruneMessageSearchIntents(db: DatabaseSync, count = PRUNE_PER_COMMIT): void {
  const run = runs.get(db);
  if (!run?.reader || !run.indexId) return;
  if (!run.cache || performance.now() - run.cache.at >= 1000) {
    try {
      const row = run.reader.prepare("SELECT (SELECT v FROM search_state WHERE k='index_id') AS id,(SELECT v FROM search_state WHERE k='applied_seq') AS seq").get();
      if (row?.id !== run.indexId) { run.cache = null; return; }
      run.cache = { indexId: String(row.id), applied: Number(row.seq), at: performance.now() };
    } catch { run.cache = null; return; }
  }
  if (run.cache.indexId === run.indexId) db.prepare(PRUNE_SQL).run(run.cache.applied, Math.min(count, IDLE_PRUNE_ROWS));
}
export function messageSearchIndexReady(db: DatabaseSync): boolean { return !!runs.get(db)?.reader; }
export function disableMessageSearchIndex(db: DatabaseSync, _error: unknown): void {
  const run = runs.get(db);
  if (run && !run.stopped) { closeReader(run); run.worker.postMessage({ type: "reset-request", token: run.token }); }
}
/** Index candidates AND progress come from ONE search.db snapshot. No ATTACH,
 * FTS writes, pending-text copies or fallback history walks run on main. */
export function readMessageSearchCandidates(db: DatabaseSync, match: string, cap: number): { rowids: number[]; partial: boolean } {
  const run = runs.get(db); let applied = 0, partial = true, rowids: number[] = [];
  if (run?.reader) {
    const reader = run.reader;
    try {
      reader.exec("BEGIN");
      const progress = reader.prepare("SELECT (SELECT v FROM search_state WHERE k='index_id') AS id,(SELECT v FROM search_state WHERE k='applied_seq') AS seq, EXISTS(SELECT 1 FROM search_state WHERE k='built') AS building, EXISTS(SELECT 1 FROM docs WHERE oversized=1) AS oversized").get()!;
      if (progress.id !== run.indexId) throw new Error("search index generation changed");
      applied = Number(progress.seq); partial = !!progress.building || !!progress.oversized;
      rowids = reader.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT ?").all(match, cap + 1).map(row => Number(row.rowid));
      if (rowids.length > cap) { rowids.length = cap; partial = true; }
      searchIndexTestHooks.candidateSnapshot?.();
      reader.exec("COMMIT");
    } catch (error) {
      if (reader.isTransaction) reader.exec("ROLLBACK");
      if (!isDatabaseBusy(error)) disableMessageSearchIndex(db, error);
      applied = 0; partial = true; rowids = [];
    }
  }
  const pending = db.prepare(PENDING_SQL).all(applied, PENDING_MAX + 1);
  if (pending.length > PENDING_MAX) { pending.length = PENDING_MAX; partial = true; }
  for (const row of pending) if (row.rowid !== null && Number(row.rowid) !== 0) rowids.push(Number(row.rowid));
  return { rowids: [...new Set(rowids)], partial };
}
export function searchRetirementPending(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name GLOB 'messages_fts_retired*' OR name='messages_fts' LIMIT 1").get();
}
export function searchCleanupPending(db: DatabaseSync): boolean {
  if (searchRetirementPending(db)) return true;
  const run = runs.get(db);
  if (!run?.reader) {
    if (pendingStarts.has(db) || (run && !run.stopped)) return true;
    // Offline/test callers may supply a pre-upgrade database with no queue.
    // A real deletion always leaves its drop intent until the worker applies it.
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='search_intents'").get()) return false;
    return db.prepare("SELECT 1 FROM search_intents LIMIT 1").get() !== undefined;
  }
  try {
    const state = run.reader.prepare("SELECT (SELECT v FROM search_state WHERE k='applied_seq') AS seq,EXISTS(SELECT 1 FROM search_state WHERE k IN ('debt','drop_cursor','built')) AS owed").get()!;
    const newest = Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM search_intents").get()!.n);
    return !!state.owed || Number(state.seq) < newest;
  } catch { return true; }
}
/** Close reader first; the writer is last and can checkpoint search.db on close.
 * Resolves true ONLY after every thread has actually exited. */
export async function stopSearchIndex(): Promise<boolean> {
  for (const pending of pendingStarts.values()) if (pending.timer) clearTimeout(pending.timer);
  pendingStarts.clear();
  const stopping = [...new Set([...sessions, ...live])];
  for (const run of stopping) {
    run.stopped = true; sessions.delete(run);
    if (run.timer) clearTimeout(run.timer);
    closeReader(run); run.worker.postMessage({ type: "stop", token: run.token });
  }
  const joined = Promise.all(stopping.map(async run => {
    const timer = setTimeout(() => { void run.worker.terminate(); }, 1500); timer.unref();
    try { await run.exited; return true; } finally { clearTimeout(timer); }
  }));
  return (await joined).every(Boolean);
}
registerTestHandle("close", dir => {
  for (const [db, pending] of pendingStarts) if (dir === undefined || pathIsWithin(pending.file, dir)) { if (pending.timer) clearTimeout(pending.timer); pendingStarts.delete(db); }
  // Include threads already stopping: closeDatabase requests their stop without waiting.
  // A fixture may reuse this path only after every old SQLite connection has actually left.
  const stopping = [...live].filter(run => dir === undefined || pathIsWithin(run.file, dir));
  for (const run of stopping) {
    run.stopped = true; sessions.delete(run); closeReader(run); if (run.timer) clearTimeout(run.timer); void run.worker.terminate();
  }
  return Promise.all(stopping.map(run => run.exited));
});
// A close request removes a session before its thread exits. Async test cleanup must join those live threads too.
registerTestHandle("stop", async dir => {
  await Promise.all([...live].filter(run => dir === undefined || pathIsWithin(run.file, dir)).map(run => run.exited));
});
// Legacy background API stays inert: all rebuilding belongs to the worker.
export function messageSearchFillPending(_db: DatabaseSync): boolean { return false; }
export function stepMessageSearchBackfill(_db: DatabaseSync, _rows = 256): { more: boolean; done: number; total: number } { return { more: false, done: 0, total: 0 }; }
export function backfillMessageSearchIndex(_db: DatabaseSync, _options: { onProgress?: (p: { done: number; total: number }) => void } = {}): number { return 0; }
export function rebuildMessageSearchIndex(db: DatabaseSync): number {
  db.prepare("UPDATE transcript_index_state SET done=? WHERE name='search_owner'").run(randomUUID());
  return 0;
}
