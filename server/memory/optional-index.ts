// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Optional indexes over history-sized tables (memory_disclosures_live, and every later one): never built at open and never on the main
// thread. A CREATE INDEX reads the whole table (hundreds of ms for the owner's 155,809 jobs / 186,697 records), so it runs in a worker thread on a
// connection of its own (the root-set reclaim pattern), after the server listens. SQLite makes the index in ONE atomic statement, so an index
// that exists IS complete: readiness is "the name is in sqlite_schema", and a reader that wants the index checks optionalIndexReady() and
// otherwise takes its bounded fallback. A downgrade to 1.0.1 drops every registered index (dropOptionalIndexes in the downgrade's transaction).
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import { quietForSmallWork, reclaimAllowed, type ReclaimGate } from "./root-set-reclaim.ts";

export type OptionalIndex = { name: string; table: string; sql: string; minSchemaVersion: number; /** small partial index: built at the first moment with no live turn and no typing, without the idle wait */ eager?: boolean };
/** Every optional index. The exact text SQLite stores (sql without IF NOT EXISTS) is what validation accepts. */
export const OPTIONAL_INDEXES: OptionalIndex[] = [];
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
  parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
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
export function buildOptionalIndexOffThread(db: DatabaseSync, index: OptionalIndex, options: { retries?: number; retryMs?: number; inline?: boolean; canStart?: () => boolean } = {}): Promise<boolean> {
  if (Number(db.prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()?.v) < index.minSchemaVersion) return Promise.resolve(false);
  if (optionalIndexReady(db, index.name)) return Promise.resolve(true);
  const file = databaseFile(db);
  const key = `${file}\0${index.name}`;
  const running = inFlight.get(key);
  if (running) return running;
  if (!file || options.inline) { db.exec(index.sql); return Promise.resolve(true); }
  const attempt = (left: number, pause: number): Promise<boolean> => new Promise<boolean>(resolve => {
    // every attempt, a retry included, passes the same gate as the first: a closed gate counts as a failed attempt (no worker starts), the next idle sweep builds
    if (options.canStart && !options.canStart()) { optionalIndexStats.gated++; optionalIndexStats.failed++; if (left <= 0) { resolve(false); return; } const t = setTimeout(() => { void attempt(left - 1, pause * 2).then(resolve); }, pause); t.unref?.(); return; }
    optionalIndexStats.started++;
    const done = (ok: boolean) => {
      if (ok) { optionalIndexStats.built++; resolve(true); return; }
      optionalIndexStats.failed++;
      if (left <= 0) { resolve(false); return; }
      const timer = setTimeout(() => { void attempt(left - 1, pause * 2).then(resolve); }, pause); timer.unref?.();
    };
    try {
      const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { file, sql: index.sql } });
      let settled = false;
      const finish = (ok: boolean) => { if (settled) return; settled = true; done(ok); };
      worker.on("message", (message: { ok: boolean }) => finish(message.ok));
      worker.on("error", () => finish(false));
      worker.on("exit", () => finish(false));
      worker.unref();
    } catch { done(false); }
  });
  const promise = attempt(options.retries ?? 3, options.retryMs ?? 60_000).finally(() => { inFlight.delete(key); });
  inFlight.set(key, promise);
  return promise;
}
/** Drops every registered optional index (a downgrade to a build that accepts none of them). */
export function dropOptionalIndexes(db: DatabaseSync): void {
  for (const index of OPTIONAL_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index.name}`);
}

let windowBuilt = false;
/** The idle-time build: called from the memory worker's idle sweep. A CREATE INDEX holds the write lock for its whole run (a table of 187k
 * rows is seconds), so it starts only while the SAME gate as the root-set VACUUM allows it (reclaimAllowed: owner idle, no live turn, no typing,
 * no routine due in 2 minutes), and at most ONE index per idle window (the flag resets the first time the gate is seen closed). Readers fall
 * back to their bounded path meanwhile, so waiting costs nothing. Resolves with the name built, or null. */
export async function buildOptionalIndexesWhenIdle(db: DatabaseSync, gate: ReclaimGate, options: { idleMs?: number; inline?: boolean; retryMs?: number } = {}): Promise<string | null> {
  if (!reclaimAllowed(gate, options.idleMs)) { windowBuilt = false; return null; }
  if (windowBuilt) return null;
  for (const index of OPTIONAL_INDEXES) {
    if (optionalIndexReady(db, index.name)) continue;
    if (Number(db.prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()?.v) < index.minSchemaVersion) continue;
    windowBuilt = true;
    return (await buildOptionalIndexOffThread(db, index, options.inline ? { inline: true } : { canStart: () => reclaimAllowed(gate, options.idleMs), ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}) })) ? index.name : null;
  }
  return null;
}
/** Eager indexes (small partial ones a safety check waits on): built at the first moment no turn is live and the owner is not typing, without
 * the idle wait and outside the one-per-window rule, still on a worker thread. Resolves with the names built. */
export async function buildEagerIndexes(db: DatabaseSync, gate: ReclaimGate, options: { inline?: boolean; retryMs?: number } = {}): Promise<string[]> {
  const built: string[] = [];
  for (const index of OPTIONAL_INDEXES) {
    if (!index.eager || optionalIndexReady(db, index.name)) continue;
    const open = () => quietForSmallWork(gate);
    if (!open()) break;
    if (await buildOptionalIndexOffThread(db, index, options.inline ? { inline: true } : { canStart: open, retries: 1, ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}) })) built.push(index.name);
  }
  return built;
}
/** Test hook: a new idle window. */
export function resetOptionalIndexWindow(): void { windowBuilt = false; }
