import { windowsHidePrelude } from "../../shared/win-hide-child-process.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deferred indexes over history-sized tables (including required ones with a bounded fallback): built after listen, unless marked preListen.
// A missing preListen index is attempted at every open. Other indexes are never built at open or on the main
// thread. A CREATE INDEX reads the whole table (hundreds of ms for the owner's 155,809 jobs / 186,697 records), so it runs in a worker thread on a
// connection of its own (the root-set reclaim pattern), after the server listens. SQLite makes the index in ONE atomic statement, so an index
// that exists IS complete: readiness is "the name is in sqlite_schema", and a reader that wants the index checks optionalIndexReady() and
// otherwise takes its bounded fallback. A downgrade to 1.0.1 drops every registered index (dropOptionalIndexes in the downgrade's transaction).
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import { quietForSmallWork, reclaimAllowed, type ReclaimGate } from "./root-set-reclaim.ts";

export type OptionalIndex = { name: string; table: string; sql: string; minSchemaVersion: number; /** small partial index: built at the first moment with no live turn and no typing, without the idle wait */ eager?: boolean; /** made on the opening connection before the server listens, on EVERY launch where it is missing (buildPreListenIndexes):
 * for a small partial index a turn's first read needs, whose build is cheap next to the walk its absence costs */ preListen?: boolean; /** also logs the build hold as `[<logTag>] index build ms=<n> ok=<0|1>` (a greppable line per owner of the index) */ logTag?: string };
/** Every optional index. The exact text SQLite stores (sql without IF NOT EXISTS) is what validation accepts. */
export const OPTIONAL_INDEXES: OptionalIndex[] = [];
/** Required for the normal owner path. Failure keeps the bounded fallback active until a build succeeds. */
export const REQUIRED_INDEXES: OptionalIndex[] = [];
export function registerRequiredIndex(index: OptionalIndex): OptionalIndex {
  if (!REQUIRED_INDEXES.some(item => item.name === index.name)) REQUIRED_INDEXES.push(index);
  return index;
}
const registeredIndexes = () => [...REQUIRED_INDEXES, ...OPTIONAL_INDEXES];
const pendingRequired = new WeakMap<DatabaseSync, Set<string>>();
/** In memory only: owner writes never query schema or attempt CREATE INDEX. */
export function requiredIndexRebuildPending(db: DatabaseSync, name: string): boolean {
  return pendingRequired.get(db)?.has(name) ?? false;
}
function requiredBuildResult(db: DatabaseSync, index: OptionalIndex, ok: boolean, error?: unknown): void {
  if (!REQUIRED_INDEXES.includes(index)) return;
  if (ok) { pendingRequired.get(db)?.delete(index.name); return; }
  let pending = pendingRequired.get(db);
  if (!pending) { pending = new Set(); pendingRequired.set(db, pending); }
  if (!pending.has(index.name)) {
    const failure = error as { code?: string; errcode?: number; name?: string } | null;
    const errorClass = ({ 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 13: 'SQLITE_FULL' } as Record<number, string>)[Number(failure?.errcode) & 255] ?? failure?.code ?? failure?.name ?? 'Error';
    console.warn(`[memory] required index build failed name=${index.name} class=${errorClass}; rebuild pending`);
  }
  pending.add(index.name);
}
export function registerOptionalIndex(index: OptionalIndex): OptionalIndex {
  if (!OPTIONAL_INDEXES.some(item => item.name === index.name)) OPTIONAL_INDEXES.push(index);
  return index;
}
export const optionalIndexText = (index: OptionalIndex) => index.sql.replace(" IF NOT EXISTS", "");
const WORKER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout=60000");
  db.exec(workerData.sql);
  db.close();
  parentPort.postMessage({ ok: true });
} catch (error) {
  try { db && db.close(); } catch {}
  parentPort.postMessage({ ok: false, message: String(error && error.message || error), code: error && error.code, errcode: error && error.errcode, name: error && error.name });
}
`;
/** The file a connection is attached to, "" for an in-memory or temporary database. */
export function databaseFile(db: DatabaseSync): string {
  try { return String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")?.file ?? ""); } catch { return ""; }
}
/** True when the index exists (so it is complete). */
export function optionalIndexReady(db: DatabaseSync, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(name)); } catch { return false; }
}
const inFlight = new Map<string, Promise<boolean>>();
export const optionalIndexStats = { started: 0, built: 0, failed: 0, gated: 0 };
/** Builds `index` on a worker thread with its own connection; resolves true once it exists. A failure (a lock held past the busy timeout) is
 * retried a few times with a growing pause, never on the caller's thread. One build per name at a time. `inline: true` (an in-memory database,
 * which a worker cannot open) builds on the caller's connection: tests only. */
export function buildOptionalIndexOffThread(db: DatabaseSync, index: OptionalIndex, options: { retries?: number; retryMs?: number; inline?: boolean; canStart?: () => boolean; hold?: (on: boolean) => void } = {}): Promise<boolean> {
  if (index.minSchemaVersion > 0 && Number(db.prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()?.v) < index.minSchemaVersion) return Promise.resolve(false);
  if (optionalIndexReady(db, index.name)) { requiredBuildResult(db, index, true); return Promise.resolve(true); }
  const file = databaseFile(db);
  const key = `${file}\0${index.name}`;
  const running = inFlight.get(key);
  if (running) return running;
  if (!file || options.inline) {
    const began = performance.now();
    try { db.exec(index.sql); requiredBuildResult(db, index, true); }
    catch (error) { if (!REQUIRED_INDEXES.includes(index)) throw error; requiredBuildResult(db, index, false, error); return Promise.resolve(false); }
    if (index.logTag) console.log(`[${index.logTag}] index build ms=${Math.round(performance.now() - began)} ok=1 inline=1`);
    return Promise.resolve(true);
  }
  const attempt = (left: number, pause: number): Promise<boolean> => new Promise<boolean>(resolve => {
    // every attempt, a retry included, passes the same gate as the first: a closed gate counts as a failed attempt (no worker starts), the next idle sweep builds
    if (options.canStart && !options.canStart()) { optionalIndexStats.gated++; optionalIndexStats.failed++; if (left <= 0) { resolve(false); return; } const t = setTimeout(() => { void attempt(left - 1, pause * 2).then(resolve); }, pause); t.unref?.(); return; }
    optionalIndexStats.started++;
    // the CREATE INDEX holds the write lock for its whole run: it declares itself (the writer hold, so write-bearing requests wait asynchronously
    // and background writers stay off the serving thread) and brackets itself in the log
    const began = performance.now();
    console.log(`[memory] index build start name=${index.name}`);
    try { options.hold?.(true); } catch { /* not held */ }
    const done = (ok: boolean, error?: unknown) => {
      requiredBuildResult(db, index, ok, error);
      try { options.hold?.(false); } catch { /* released */ }
      const held = Math.round(performance.now() - began);
      console.log(`[memory] index build done name=${index.name} ms=${held}${ok ? "" : " failed"}`);
      if (index.logTag) console.log(`[${index.logTag}] index build ms=${held} ok=${ok ? 1 : 0}`);
      if (ok) { optionalIndexStats.built++; resolve(true); return; }
      optionalIndexStats.failed++;
      if (left <= 0) { resolve(false); return; }
      const timer = setTimeout(() => { void attempt(left - 1, pause * 2).then(resolve); }, pause); timer.unref?.();
    };
    try {
      const worker = new Worker(windowsHidePrelude + WORKER_SOURCE, { eval: true, workerData: { file, sql: index.sql } });
      let settled = false;
      const finish = (ok: boolean, error?: unknown) => { if (settled) return; settled = true; done(ok, error); };
      worker.on("message", (message: { ok: boolean; code?: string; errcode?: number; name?: string }) => finish(message.ok, message));
      worker.on("error", error => finish(false, error));
      worker.on("exit", () => finish(false));
      worker.unref();
    } catch (error) { done(false, error); }
  });
  const promise = attempt(options.retries ?? 3, options.retryMs ?? 60_000).finally(() => { inFlight.delete(key); });
  inFlight.set(key, promise);
  return promise;
}
/** Drops every registered optional index (a downgrade to a build that accepts none of them). */
export function dropOptionalIndexes(db: DatabaseSync): void {
  for (const index of registeredIndexes()) db.exec(`DROP INDEX IF EXISTS ${index.name}`);
}

let windowBuilt = false;
/** The idle-time build: called from the memory worker's idle sweep. A CREATE INDEX holds the write lock for its whole run (a table of 187k
 * rows is seconds), so it starts only while the SAME gate as the root-set VACUUM allows it (reclaimAllowed: owner idle, no live turn, no typing,
 * no routine due in 2 minutes), and at most ONE index per idle window (the flag resets the first time the gate is seen closed). Readers fall
 * back to their bounded path meanwhile, so waiting costs nothing. Resolves with the name built, or null. */
export async function buildOptionalIndexesWhenIdle(db: DatabaseSync, gate: ReclaimGate, options: { idleMs?: number; inline?: boolean; retryMs?: number; hold?: (on: boolean) => void } = {}): Promise<string | null> {
  if (!reclaimAllowed(gate, options.idleMs)) { windowBuilt = false; return null; }
  // Required retries precede the optional one-per-window budget, including a previous failed attempt.
  for (const index of registeredIndexes()) {
    const required = REQUIRED_INDEXES.includes(index);
    if (!required && windowBuilt) return null;
    if (optionalIndexReady(db, index.name)) { requiredBuildResult(db, index, true); continue; }
    // an index over a table this file does not have (a memory-only file) waits for it, without spending the window
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(index.table)) continue;
    if (index.minSchemaVersion > 0 && Number(db.prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()?.v) < index.minSchemaVersion) continue;
    if (!required) windowBuilt = true;
    return (await buildOptionalIndexOffThread(db, index, options.inline ? { inline: true } : { ...(required ? { retries: 0 } : {}), canStart: () => reclaimAllowed(gate, options.idleMs), ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}), ...(options.hold ? { hold: options.hold } : {}) })) ? index.name : null;
  }
  return null;
}
/** Eager indexes (small partial ones a safety check waits on): built at the first moment no turn is live and the owner is not typing, without
 * the idle wait and outside the one-per-window rule, still on a worker thread. Resolves with the names built. */
export async function buildEagerIndexes(db: DatabaseSync, gate: ReclaimGate, options: { inline?: boolean; retryMs?: number; hold?: (on: boolean) => void } = {}): Promise<string[]> {
  const built: string[] = [];
  // ONE writer hold for the whole run of eager builds (rc13): a hold released and taken again between two indexes let a write-bearing request
  // pass the gate in the gap and then meet the next hold (a group turn is refused as busy while one is in force)
  let held = false;
  try {
    for (const index of OPTIONAL_INDEXES) {
      if (!index.eager || optionalIndexReady(db, index.name)) continue;
      const open = () => quietForSmallWork(gate);
      if (!open()) break;
      // the CREATE INDEX holds the write lock: write-bearing requests wait asynchronously meanwhile, so the main thread never meets the lock in its busy wait
      if (!held) { try { options.hold?.(true); held = true; } catch { /* not held */ } }
      if (await buildOptionalIndexOffThread(db, index, options.inline ? { inline: true } : { canStart: open, retries: 1, ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}) })) built.push(index.name);
    }
  } finally { if (held) { try { options.hold?.(false); } catch { /* released */ } } }
  return built;
}
/** The eager indexes made on the opening connection while the start-up note is up, before the server listens (the upgrade launch: the migration
 * already holds the app closed, a responder thread answers health with the progress, and nothing else writes). After listen the same builds held
 * the write lock for 137, 179 and 302 ms on the owner's data (rc13 real-data run), and the serving thread met that lock; made here, they are done
 * before the first request, and no reader takes its fallback for them. A failure leaves the index to the after-listen build, as before.
 * Resolves nothing asynchronously: each is one CREATE INDEX on `db`. Returns the names built. */
export function buildEagerIndexesBeforeListen(db: DatabaseSync, options: { log?: boolean } = {}): string[] {
  return buildBeforeListen(db, index => Boolean(index.eager), options);
}
/** The preListen indexes, made on the opening connection before listen on every launch (an ordinary start included) where they are missing.
 * One CREATE INDEX each, once per install: the next launches find them. A failure leaves the index to the idle-gated build, as before. */
export function buildPreListenIndexes(db: DatabaseSync, options: { log?: boolean } = {}): string[] {
  return buildBeforeListen(db, index => Boolean(index.preListen), options);
}
/** True when this launch would build a preListen index: the caller keeps the start-up note moving for the build, which blocks the server thread. Two
 * schema-table seeks, and any failure reads as nothing to build. */
export function preListenIndexMissing(db: DatabaseSync): boolean {
  try { return registeredIndexes().some(index => index.preListen && dueBeforeListen(db, index)); } catch { return false; }
}
function dueBeforeListen(db: DatabaseSync, index: OptionalIndex): boolean {
  if (index.minSchemaVersion > 0 && Number(db.prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()?.v) < index.minSchemaVersion) return false;
  return !optionalIndexReady(db, index.name);
}
function buildBeforeListen(db: DatabaseSync, pick: (index: OptionalIndex) => boolean, options: { log?: boolean }): string[] {
  const built: string[] = [];
  for (const index of registeredIndexes()) {
    if (!pick(index)) continue;
    try {
      if (!dueBeforeListen(db, index)) { requiredBuildResult(db, index, true); continue; }
      const began = performance.now();
      db.exec(index.sql);
      requiredBuildResult(db, index, true);
      built.push(index.name);
      if (options.log !== false) console.log(`[memory] index build before listen name=${index.name} ms=${Math.round(performance.now() - began)}`);
    } catch (error) { requiredBuildResult(db, index, false, error); /* left to the next idle build or start */ }
  }
  return built;
}
/** Test hook: a new idle window. */
export function resetOptionalIndexWindow(): void { windowBuilt = false; }
