// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, 1.0.2: handing back the space of the root sets (STORAGE-AUDIT 4; 1.0.1 (v6) files carry memory_root_set_members too).
//
// Root sets are never written from v10 on (replay-lineage.ts ROOT_SETS_FROZEN). Once the write-time backfill has certified the file
// (memory_lineage_cert past U1s, or ready: U1 and U1s have read every old set they need) nothing new reads them (S6: the read-time judge is retired, see
// read-time-retired.ts), and they are handed back:
// - SLICED. A single DROP of the owner's 4.2 GB of sets held the write lock 1.1-2.0 s. The rows go out in batches (DELETE in primary-key or rowid
//   order, each a short transaction sized to RECLAIM_BATCH_MS, the index going down with them), then the emptied index and tables are dropped,
//   then the free pages are given back (PRAGMA incremental_vacuum in slices of the same size). Between batches the worker naps at least
//   RECLAIM_PAUSE_MS, so an owner write waits for at most the batch already running. The worker takes the write lock with NO wait: when the owner's
//   connection holds it, the batch is tried again shortly.
// - A file that was not made incremental (every file from before 1.0.1) needs ONE VACUUM to switch; it is the one statement that cannot be sliced.
//   It runs last, after the rows are gone (it rewrites only what is left), only when the owner has been idle 10 minutes, with owner writes held
//   asynchronously (health and reads keep answering), and only with the disk room a rewrite needs.
// - The state is what the file holds (IF EXISTS everywhere): a run killed at any point resumes at the first object still there.
// - Each run is a worker on a connection of its own, with secure_delete=FAST (the main connection's secure_delete=ON would zero-write every freed
//   page through the log). The gate (owner idle 10 minutes, no live turn, no typing hold, no routine due in the next 2 minutes, health answered,
//   the integrity pass done, no revocation job waiting) is asked every 200 ms while it runs: an owner who comes back stops it.
// - Armed at start (index.ts setReadTimeJudgeRetired). Objects other lanes retired register by name (registerRetiredObjects).
// - The validator accepts a v10 file with any of these objects gone (schema.ts ROOT_SET_RECLAIM_TABLES); a downgrade to v9 makes them again,
//   empty, and marks every generated line unprovable (lineage-backfill.ts), so an older build withholds what it can no longer prove.
import type { DatabaseSync } from "node:sqlite";
import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";

/** The v6 member index, then the tables, in drop order (a table's own indexes and triggers go with it). */
export const ROOT_SET_MEMBER_INDEX = "memory_root_set_members_root";
export const ROOT_SET_RECLAIM_TABLES = ["memory_root_set_members", "memory_root_set_parents", "memory_root_sets", "memory_output_roots", "memory_session_roots", "memory_root_set_compaction"] as const;
/** The tables emptied in slices before they are dropped (rowid = false: WITHOUT ROWID, sliced by primary-key order). The compaction row is one row. */
const CLEAR_TABLES: ReadonlyArray<{ name: string; key: readonly string[]; rowid: boolean }> = [
  { name: "memory_root_set_members", key: ["set_id", "root_thread_id", "root_message_id"], rowid: false },
  { name: "memory_root_set_parents", key: ["set_id"], rowid: false },
  { name: "memory_root_sets", key: [], rowid: true },
  { name: "memory_output_roots", key: [], rowid: true },
  { name: "memory_session_roots", key: [], rowid: true },
];
const VACUUM_SPARE_BYTES = 64 * 1024 * 1024;
/** Written in the transaction of every batch: a downgrade then knows the old lines can no longer be proven (schema.ts downgradeMemorySchema). */
const DROPPED_MARK = "UPDATE memory_lineage_lsn_meta SET value=1 WHERE key='root_sets_dropped'";
export const RECLAIM_IDLE_MS = 10 * 60_000;
export const RECLAIM_ROUTINE_HORIZON_MS = 2 * 60_000;
/** One write transaction of the reclaim holds the write lock for about this long (rows are deleted, and free pages given back, in batches
 * sized to it), then lets the owner's writes in for at least RECLAIM_PAUSE_MS: no write waits much longer than a batch. */
export const RECLAIM_BATCH_MS = 60;
export const RECLAIM_PAUSE_MS = 40;

export type ReclaimStep = { kind: "clear"; name: string } | { kind: "drop-index"; name: string } | { kind: "drop-table"; name: string } | { kind: "shrink" } | { kind: "vacuum" } | { kind: "done" };

/** What the reclaim hands back: tables emptied in slices, then these indexes and tables dropped. */
interface ReclaimPlan { clear: ReadonlyArray<{ name: string; key: readonly string[]; rowid: boolean }>; indexes: readonly string[]; tables: readonly string[] }
const extraObjects = new Map<string, { indexes: readonly string[]; tables: ReadonlyArray<{ name: string; key?: readonly string[] }> }>();
/** The hook for objects other lanes retired (the same idle, sliced hand-back, the same gate): msearch2's `dropLegacyOwnerTailIndex` (an index) and
 * hotpath's retired inbox tables are NOT in this branch (neither helper exists here), so they register here when their lanes merge, by name:
 *   registerRetiredObjects("msearch2", { indexes: [<the owner tail index>] });
 *   registerRetiredObjects("hotpath", { tables: [{ name: <inbox table> }, ...] });
 * A table with a key is WITHOUT ROWID and is emptied in primary-key order; one without is emptied by rowid. Every name must be an object nothing
 * reads any more (the registrant's own lane guarantees it); IF EXISTS everywhere, so one already gone is no step. */
export function registerRetiredObjects(owner: string, objects: { indexes?: readonly string[]; tables?: ReadonlyArray<{ name: string; key?: readonly string[] }> }): void {
  const clean = (name: string) => { if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`MEMORY_RECLAIM_BAD_OBJECT: ${name}`); return name; };
  extraObjects.set(owner, { indexes: (objects.indexes ?? []).map(clean), tables: (objects.tables ?? []).map(table => ({ name: clean(table.name), ...(table.key ? { key: table.key.map(clean) } : {}) })) });
}
export function registeredRetiredObjects(): string[] { return [...extraObjects.keys()]; }
function currentPlan(): ReclaimPlan {
  const clear = [...CLEAR_TABLES], indexes = [ROOT_SET_MEMBER_INDEX], tables: string[] = [...ROOT_SET_RECLAIM_TABLES];
  for (const extra of extraObjects.values()) {
    indexes.push(...extra.indexes);
    for (const table of extra.tables) { clear.push({ name: table.name, key: table.key ?? [], rowid: !table.key }); tables.push(table.name); }
  }
  return { clear, indexes, tables };
}

const has = (db: DatabaseSync, type: "table" | "index", name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type=? AND name=?").get(type, name));
const pragma = (db: DatabaseSync, name: string) => { const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined; return row ? Number(Object.values(row)[0] ?? 0) : 0; };

/** The next step this file needs (read from the file itself): rows out in batches (the index goes down with them), then the emptied index
 * and tables, then the free pages given back (incremental, in slices) or, on a file that cannot do that yet, one VACUUM. */
export function nextReclaimStep(db: DatabaseSync): ReclaimStep { return engine.nextStep(db, currentPlan()); }

/** Whether the write-time backfill no longer needs the root sets. Only U1 (line()) and U1s (sessions()) read them; the phases after U1s (U1m, U1f
 * and U2) never do, so the hand-back may begin the moment U1s is over, not when the whole certificate is ready. The DROPPED_MARK written in every
 * batch keeps a downgrade correct. A certificate in the middle of a downgrade (phase 'down') counts only when it is ready. */
export function reclaimCertified(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT ready,phase FROM memory_lineage_cert WHERE id=1").get();
    return Number(row?.ready ?? 0) === 1 || ["u1m", "u1f", "u2", "done"].includes(String(row?.phase ?? ""));
  } catch { return false; }
}
/** Whether this file has the v10 certificate at all (the real reclaim applies; below v10 the v7 conversion does). */
export function reclaimApplies(db: DatabaseSync): boolean {
  try { return Boolean(db.prepare("SELECT 1 AS x FROM memory_lineage_cert WHERE id=1").get()); } catch { return false; }
}
/** True when the next step is the one VACUUM and the disk has less room than it needs. */
export function reclaimShortOfDisk(db: DatabaseSync, freeDiskBytes: (file: string) => number | null = diskFree): boolean {
  if (nextReclaimStep(db).kind !== "vacuum") return false;
  const file = String((db.prepare("PRAGMA database_list").all() as Array<Record<string, unknown>>).find(row => row.name === "main")?.file ?? "");
  const live = (pragma(db, "page_count") - pragma(db, "freelist_count")) * pragma(db, "page_size");
  const room = freeDiskBytes(file);
  return room !== null && room < live + VACUUM_SPARE_BYTES;
}

let judgeRetired = false;
/** S6 retires the read-time judge (the last reader of the root sets): from then on the reclaim may run. */
export function setReadTimeJudgeRetired(retired: boolean): void { judgeRetired = retired; }
export function readTimeJudgeRetired(): boolean { return judgeRetired; }

/** What the owner is doing, asked before every step. */
export interface ReclaimGate {
  /** ms since the last owner action (any request that changes something, any typing). */
  ownerIdleMs(): number;
  liveTurn(): boolean;
  typingHeld(): boolean;
  /** A routine is due within `ms`. */
  routineDueWithin(ms: number): boolean;
  /** /api/health has answered since this process started. */
  healthAnswered(): boolean;
  /** The integrity pass is still going (a VACUUM renumbers the rowids it names). */
  integrityPending(): boolean;
  /** A revocation or marker job is waiting (its cursors use rowids). */
  revocationWaiting(): boolean;
}
export function reclaimAllowed(gate: ReclaimGate, idleMs = RECLAIM_IDLE_MS): boolean {
  return judgeRetired && gate.healthAnswered() && !gate.liveTurn() && !gate.typingHeld() && gate.ownerIdleMs() >= idleMs
    && !gate.routineDueWithin(RECLAIM_ROUTINE_HORIZON_MS) && !gate.integrityPending() && !gate.revocationWaiting();
}

/** The engine: ONE source for what a step does, run in the reclaim worker on its own connection and, through runReclaimStep, on a caller's
 * connection (tests). Plain JavaScript in a string so the worker (an eval'd script, nothing to import) and the module share it. A batch is one
 * short write transaction taken with no wait: if the owner's connection holds the lock the batch throws BUSY and tries again later. */
const ENGINE_SOURCE = `
const MARK = ${JSON.stringify(DROPPED_MARK)};
const pragma = (db, name) => { const row = db.prepare("PRAGMA " + name).get(); return row ? Number(Object.values(row)[0] || 0) : 0; };
const has = (db, type, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type=? AND name=?").get(type, name));
const TARGET = ${RECLAIM_BATCH_MS};
function nextStep(db, plan) {
  for (const spec of plan.clear) if (has(db, "table", spec.name) && db.prepare("SELECT 1 FROM " + spec.name + " LIMIT 1").get()) return { kind: "clear", name: spec.name };
  for (const name of plan.indexes) if (has(db, "index", name)) return { kind: "drop-index", name };
  for (const name of plan.tables) if (has(db, "table", name)) return { kind: "drop-table", name };
  if (pragma(db, "auto_vacuum") !== 2) return { kind: "vacuum" };
  return pragma(db, "freelist_count") > 0 && pragma(db, "page_count") > 0 ? { kind: "shrink" } : { kind: "done" };
}
const grow = (n, ms, lo, hi) => Math.max(lo, Math.min(hi, Math.min(n * 2, Math.round(n * TARGET / Math.max(ms, 1)))));
// one batch of rows out of a table (its indexes go down with them) or one slice of free pages given back; returns the write-lock time in ms
function batch(db, step, size, plan) {
  const started = performance.now();
  if (step.kind === "shrink") { db.exec("PRAGMA incremental_vacuum(" + size.pages + ")"); const ms = performance.now() - started; size.pages = grow(size.pages, ms, 16, 65536); return ms; }
  const spec = plan.clear.find(item => item.name === step.name);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(MARK);
    const cols = spec.rowid ? "rowid" : spec.key.join(",");
    const edge = db.prepare("SELECT " + cols + " FROM " + spec.name + " ORDER BY " + cols + " LIMIT 1 OFFSET ?").get(size.rows - 1);
    if (!edge) db.exec("DELETE FROM " + spec.name);
    else db.prepare("DELETE FROM " + spec.name + " WHERE (" + cols + ")<=(" + (spec.rowid ? "?" : spec.key.map(() => "?").join(",")) + ")").run(...Object.values(edge));
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  const ms = performance.now() - started; size.rows = grow(size.rows, ms, 32, 100000); return ms;
}
function once(db, step, size, plan) {
  const started = performance.now();
  if (step.kind === "clear" || step.kind === "shrink") return batch(db, step, size, plan);
  if (step.kind === "drop-index" || step.kind === "drop-table") {
    db.exec("BEGIN IMMEDIATE");
    try { db.exec(MARK); db.exec("DROP " + (step.kind === "drop-index" ? "INDEX" : "TABLE") + " IF EXISTS " + step.name); db.exec("COMMIT"); }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  } else if (step.kind === "vacuum") {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.exec("PRAGMA auto_vacuum=INCREMENTAL"); db.exec("VACUUM"); db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  return performance.now() - started;
}
const busy = error => /locked|busy/i.test(String(error && error.message || error));
`;
const engine = new Function("performance", `${ENGINE_SOURCE}; return { nextStep, once, busy };`)(performance) as {
  nextStep(db: DatabaseSync, plan: ReclaimPlan): ReclaimStep; once(db: DatabaseSync, step: ReclaimStep, size: { rows: number; pages: number }, plan: ReclaimPlan): number; busy(error: unknown): boolean;
};
const sizes = new WeakMap<DatabaseSync, { rows: number; pages: number }>();
const sizeOf = (db: DatabaseSync) => { let size = sizes.get(db); if (!size) { size = { rows: 256, pages: 128 }; sizes.set(db, size); } return size; };

/** One step on `db` itself (a test's connection): a batch, a drop, a slice of free pages or the VACUUM. Returns the step taken and how long it
 * held the write lock. */
export function runReclaimStep(db: DatabaseSync, options: { freeDiskBytes?: (file: string) => number | null } = {}): { step: ReclaimStep; ms: number; skippedForDisk?: true } {
  const plan = currentPlan(), step = engine.nextStep(db, plan);
  if (step.kind === "done") return { step, ms: 0 };
  if (step.kind === "vacuum") {
    const file = String((db.prepare("PRAGMA database_list").all() as Array<Record<string, unknown>>).find(row => row.name === "main")?.file ?? "");
    const live = (pragma(db, "page_count") - pragma(db, "freelist_count")) * pragma(db, "page_size");
    const room = (options.freeDiskBytes ?? diskFree)(file);
    if (room !== null && room < live + VACUUM_SPARE_BYTES) return { step, ms: 0, skippedForDisk: true };
  }
  db.exec("PRAGMA secure_delete=FAST");
  return { step, ms: engine.once(db, step, sizeOf(db), plan) };
}
function diskFree(file: string): number | null {
  try { const stat = statfsSync(dirname(file)); return Number(stat.bavail) * Number(stat.bsize); } catch { return null; }
}

/** The reclaim's state for the maintenance status (root-set-compaction.ts lineageStorageStatus shows it as the storage conversion). */
export interface ReclaimStatus { running: boolean; step: ReclaimStep["kind"] | "idle"; done: number; total: number }
const status: ReclaimStatus = { running: false, step: "idle", done: 0, total: 0 };
export function rootSetReclaimStatus(): ReclaimStatus { return { ...status }; }
/** What the last run measured: batches taken, the longest single batch (the longest the owner's writes waited on the reclaim), time busy. */
export interface ReclaimStats { batches: number; maxBatchMs: number; totalMs: number }
let lastStats: ReclaimStats = { batches: 0, maxBatchMs: 0, totalMs: 0 };
export function lastReclaimStats(): ReclaimStats { return { ...lastStats }; }

const WORKER_PRE = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
`;
const WORKER_BODY = `
let db;
try {
  db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout=0");
  db.exec("PRAGMA secure_delete=FAST");
  const stop = new Int32Array(workerData.stop);
  const size = { rows: 256, pages: 128 };
  const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const stats = { batches: 0, maxBatchMs: 0, totalMs: 0 };
  const deadline = performance.now() + workerData.runMs;
  for (;;) {
    if (Atomics.load(stop, 0) || performance.now() > deadline) break;
    const step = nextStep(db, workerData.plan);
    if (step.kind === "done" || step.kind === "vacuum") break; // the parent decides about the VACUUM (disk room, held writers)
    try { const ms = once(db, step, size, workerData.plan); stats.batches++; stats.totalMs += ms; if (ms > stats.maxBatchMs) stats.maxBatchMs = ms; nap(Math.max(workerData.pauseMs, Math.round(ms / 2))); }
    catch (error) { if (busy(error)) { nap(50); continue; } throw error; }
  }
  db.close();
  parentPort.postMessage({ ok: true, stats });
} catch (error) {
  try { db && db.close(); } catch {}
  parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
}
`;
const VACUUM_WORKER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout=60000");
  db.exec("PRAGMA secure_delete=FAST");
  const started = performance.now();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.exec("PRAGMA auto_vacuum=INCREMENTAL"); db.exec("VACUUM"); db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  parentPort.postMessage({ ok: true, ms: performance.now() - started });
} catch (error) {
  try { db && db.close(); } catch {}
  parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
}
`;
const SLICED_WORKER_SOURCE = WORKER_PRE + ENGINE_SOURCE + WORKER_BODY;

function runWorker(source: string, workerData: Record<string, unknown>, poll?: () => void): Promise<{ ok: boolean; stats?: ReclaimStats; ms?: number; message?: string }> {
  return new Promise(resolve => {
    let settled = false, timer: ReturnType<typeof setInterval> | undefined;
    const finish = (value: { ok: boolean; stats?: ReclaimStats; ms?: number; message?: string }) => { if (settled) return; settled = true; if (timer) clearInterval(timer); resolve(value); };
    try {
      const worker = new Worker(source, { eval: true, workerData });
      worker.on("message", (message: { ok: boolean; stats?: ReclaimStats; ms?: number; message?: string }) => finish(message));
      worker.on("error", (error: Error) => finish({ ok: false, message: error.message }));
      worker.on("exit", () => finish({ ok: false, message: "the worker ended early" }));
      worker.unref();
      if (poll) { timer = setInterval(poll, 200); timer.unref?.(); }
    } catch (error) { finish({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
  });
}

/** The idle-time reclaim: batches until done, only while the gate allows it (asked every 200 ms while the worker runs: an owner who comes back
 * stops it, and waits for at most the one batch already running). The worker takes the write lock for one short batch at a time with no wait,
 * so the owner's writes interleave; only the final VACUUM (a file that was not made incremental) holds writes, asynchronously. Called by the
 * memory worker's idle sweep; resolves when it stops (done, the owner came back, the disk is short, or a step failed: the next sweep carries
 * on from what the file holds). */
export async function reclaimRootSetsWhenIdle(db: DatabaseSync, gate: ReclaimGate, options: { hold?: (on: boolean) => void; idleMs?: number; freeDiskBytes?: (file: string) => number | null; runMs?: number } = {}): Promise<ReclaimStep["kind"] | "waiting"> {
  if (status.running || !reclaimCertified(db)) return "waiting";
  const file = String((db.prepare("PRAGMA database_list").all() as Array<Record<string, unknown>>).find(row => row.name === "main")?.file ?? "");
  if (!file) return "waiting";
  status.running = true; status.done = 0;
  lastStats = { batches: 0, maxBatchMs: 0, totalMs: 0 };
  const remaining = () => { const plan = currentPlan(); return plan.tables.filter(name => has(db, "table", name)).length + plan.indexes.filter(name => has(db, "index", name)).length; };
  const total = remaining() + 1;
  try {
    for (;;) {
      const step = nextReclaimStep(db);
      status.step = step.kind; status.total = total; status.done = Math.max(0, total - remaining() - (step.kind === "done" ? 0 : 1));
      if (step.kind === "done") return "done";
      if (!reclaimAllowed(gate, options.idleMs)) return "waiting";
      if (step.kind === "vacuum") {
        const live = (pragma(db, "page_count") - pragma(db, "freelist_count")) * pragma(db, "page_size");
        const room = (options.freeDiskBytes ?? diskFree)(file);
        if (room !== null && room < live + VACUUM_SPARE_BYTES) { console.warn("[memory] handing back space waits for free disk space (about the size of your memory)"); return "waiting"; }
        try { options.hold?.(true); } catch { /* not held */ }
        const result = await runWorker(VACUUM_WORKER_SOURCE, { file });
        try { options.hold?.(false); } catch { /* released */ }
        if (!result.ok) { console.warn(`[memory] handing back space: ${result.message ?? "the rewrite failed"}; the next idle pass carries on`); return "waiting"; }
        console.log(`[memory] handing back space: rewrote the file in ${Math.round(result.ms ?? 0)} ms`);
        continue;
      }
      const stop = new SharedArrayBuffer(4);
      const flag = new Int32Array(stop);
      const result = await runWorker(SLICED_WORKER_SOURCE, { file, plan: currentPlan(), stop, runMs: options.runMs ?? 30_000, pauseMs: RECLAIM_PAUSE_MS }, () => { if (!reclaimAllowed(gate, options.idleMs)) Atomics.store(flag, 0, 1); });
      if (!result.ok) { console.warn(`[memory] handing back space: ${result.message ?? "a step failed"}; the next idle pass carries on`); return "waiting"; }
      const stats = result.stats!;
      lastStats = { batches: lastStats.batches + stats.batches, maxBatchMs: Math.max(lastStats.maxBatchMs, stats.maxBatchMs), totalMs: lastStats.totalMs + stats.totalMs };
      if (!stats.batches && Atomics.load(flag, 0)) return "waiting";
    }
  } finally { status.running = false; status.step = "idle"; }
}

/** Bytes the file takes on disk and the bytes its live pages hold (the gate: file <= 1.25 x live after the hand-back). */
export function fileAndLiveBytes(db: DatabaseSync): { file: number; live: number } {
  const file = String((db.prepare("PRAGMA database_list").all() as Array<Record<string, unknown>>).find(row => row.name === "main")?.file ?? "");
  let size = 0;
  try { size = statSync(file).size; } catch { /* in memory */ }
  return { file: size, live: (pragma(db, "page_count") - pragma(db, "freelist_count")) * pragma(db, "page_size") };
}
