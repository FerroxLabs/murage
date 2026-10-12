// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The v8 revocation index (memory_disclosure_refs) after an upgrade. The schema
// transaction creates the table AND its lookup index, both empty and not ready,
// with the triggers that keep every receipt written from then on (a trigger write
// is write-through into the index, so a receipt written during the build is never
// missed). This fills in the receipts that were already there, in slices of bundle
// ids, one short transaction per slice (a few tens of milliseconds, keyed by a
// persisted bundle-id cursor), so a large file never holds one huge write, a stopped
// start carries on where it left off, and the build finishes under continuous use:
// it never waits for a quiet spell. Each slice's citations are read from the JSON
// once (json_each, set based), written, and the written rows are held to them before
// the slice commits. The last slice sets the ready flag in its own transaction.
// Until then every revocation reads the JSON as 1.0.1 did (revocation.ts
// revocationIndexReady). Offline-safe: schema helpers only.
import type { DatabaseSync } from "node:sqlite";
import { bundleInRange, nextBundleBound, REVOCATION_REF_INDEX, REVOCATION_REF_INDEX_SQL, revocationRefsExpectedSql } from "./schema.ts";

/** Receipts per slice: some 40,000 citations, a fraction of a second each. */
export const REVOCATION_INDEX_SLICE = 5000;
export type RevocationIndexEvent = { phase: "indexing"; done: number; total: number };
export type RevocationIndexProgress = { ready: boolean; done: number; total: number };

type BuildRow = { ready: number; cursor: string | null; done: number; total: number; finished_at: number | null };
function buildRow(db: DatabaseSync): BuildRow | null | undefined {
  // undefined: no such table (a file below v8); null: the table without its row
  try { return (db.prepare("SELECT ready,cursor,done,total,finished_at FROM memory_revocation_index_build WHERE id=1").get() as BuildRow | undefined) ?? null; }
  catch { return undefined; }
}
const rollback = (db: DatabaseSync) => { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } };
const indexExists = (db: DatabaseSync) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name=?").get(REVOCATION_REF_INDEX));
/** A lock held by another connection or process: never a reason to end the build. */
const lockedError = (error: unknown): boolean => {
  const e = error as { errcode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.errcode === "number" && (e.errcode & 0xff) === 5) return true;
  return typeof e.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message);
};

/** Rows removed per statement while an earlier lane's whole refs table is cleared. */
export const RECOVERY_DELETE_CHUNK = 256;
/** Receipts per chunk inside a time-budgeted slice: the budget is checked between chunks, so a slice is never
 * longer than the budget plus one chunk (the chunk is the smallest unit of uninterruptible work). */
export const REVOCATION_INDEX_CHUNK = 16;
export type RevocationStepOptions = {
  /** Stop adding chunks to this transaction once this many ms have passed (checked between chunks). Unset: one pass over `slice` receipts. */
  budgetMs?: number; chunk?: number;
  /** Test seam: called after every chunk (a slow-storage stand-in). */
  afterChunk?: () => void;
};

/** One step of the backfill, in its own transaction: the next slice of receipts. The last slice
 * sets the ready flag in the same transaction. Idempotent: a slice's refs are deleted before they
 * are written, so receipts the triggers already indexed are never doubled. With `budgetMs` the
 * transaction ends after the chunk that crosses the budget, so its length is bounded by the budget
 * plus one chunk's work, not by the row count. */
export function buildRevocationIndexStep(db: DatabaseSync, slice = REVOCATION_INDEX_SLICE, options: RevocationStepOptions = {}): RevocationIndexProgress {
  let row = buildRow(db);
  if (row === undefined) return { ready: false, done: 0, total: 0 };
  if (row !== null && Number(row.ready) === 1) return { ready: true, done: Number(row.done), total: Number(row.total) };
  const started = performance.now(), budget = options.budgetMs;
  const overBudget = () => budget !== undefined && performance.now() - started >= budget;
  const rows = Math.max(1, Math.trunc(slice));
  const chunk = budget === undefined && options.chunk === undefined ? rows : Math.max(1, Math.min(rows, Math.trunc(options.chunk ?? REVOCATION_INDEX_CHUNK)));
  db.exec("BEGIN IMMEDIATE");
  try {
    if (row === null) {
      // the flag row went missing: start over, reading the JSON meanwhile
      db.prepare("INSERT INTO memory_revocation_index_build(id,ready,cursor,done,total,started_at) VALUES(1,0,NULL,0,(SELECT count(*) FROM memory_disclosures),?)").run(Date.now());
    }
    row = buildRow(db)!;
    if (!indexExists(db)) {
      // a file an earlier build of this lane left without its lookup index (it was created last, in one sort): the table is
      // emptied first, then the index is made on the empty table and every slice is read again. Emptying is chunked across
      // steps (each a bounded transaction; the not-ready flag stays until the slices are done), so it never scales with history.
      // Receipts the triggers write meanwhile are rewritten by their slice, so the emptying need not chase them.
      if (budget === undefined) db.exec("DELETE FROM memory_disclosure_refs");
      else {
        do {
          db.prepare("DELETE FROM memory_disclosure_refs WHERE rowid IN (SELECT rowid FROM memory_disclosure_refs LIMIT ?)").run(RECOVERY_DELETE_CHUNK);
          options.afterChunk?.();
        } while (!overBudget() && db.prepare("SELECT 1 AS x FROM memory_disclosure_refs LIMIT 1").get());
      }
      if (db.prepare("SELECT 1 AS x FROM memory_disclosure_refs LIMIT 1").get()) {
        db.exec("COMMIT");
        return { ready: false, done: Number(row.done), total: Number(row.total) };
      }
      db.exec(REVOCATION_REF_INDEX_SQL);
      db.prepare("UPDATE memory_revocation_index_build SET cursor=NULL,done=0,finished_at=NULL WHERE id=1").run();
      if (budget !== undefined) { db.exec("COMMIT"); return { ready: false, done: 0, total: Number(row.total) }; }
      row = buildRow(db)!;
    }
    let lo = row.cursor, hi: string | null = lo, counted = 0, taken = 0;
    for (;;) {
      const want = Math.min(chunk, rows - taken);
      hi = nextBundleBound(db, lo, want);
      const range = { lo, hi };
      const held = `SELECT bundle_id,kind,ref_id,ref_version FROM memory_disclosure_refs WHERE ${bundleInRange("bundle_id", range)}`;
      // the chunk's citations, parsed once (untyped columns: the values are kept as extracted)
      db.exec("DROP TABLE IF EXISTS temp.memory_revocation_slice; CREATE TEMP TABLE memory_revocation_slice(bundle_id,kind,ref_id,ref_version)");
      db.prepare(`INSERT INTO temp.memory_revocation_slice ${revocationRefsExpectedSql(range)}`).run(lo, hi);
      db.prepare(`DELETE FROM memory_disclosure_refs WHERE ${bundleInRange("bundle_id", range)}`).run(lo, hi);
      // in lookup order, so the insertions of one chunk meet the same index pages together
      db.exec("INSERT INTO memory_disclosure_refs(bundle_id,kind,ref_id,ref_version) SELECT bundle_id,kind,ref_id,ref_version FROM temp.memory_revocation_slice ORDER BY kind,CAST(ref_id AS TEXT)");
      // validated chunk by chunk, inside the slice's own transaction: what the table now holds for these receipts, both ways
      const differs = db.prepare(`SELECT 1 FROM (SELECT * FROM temp.memory_revocation_slice EXCEPT ${held}) UNION ALL SELECT 1 FROM (${held} EXCEPT SELECT * FROM temp.memory_revocation_slice) LIMIT 1`).get(lo, hi);
      db.exec("DROP TABLE temp.memory_revocation_slice");
      if (differs) throw new Error("INVALID_MEMORY_REVOCATION_INDEX");
      counted += Number(db.prepare(`SELECT count(*) AS n FROM memory_disclosures WHERE ${bundleInRange("bundle_id", range)}`).get(lo, hi)?.n ?? 0);
      taken += want;
      options.afterChunk?.();
      lo = hi;
      if (hi === null || taken >= rows || overBudget()) break;
    }
    const done = Number(row.done) + counted, total = Math.max(Number(row.total), done), last = hi === null;
    if (last && !indexExists(db)) throw new Error("INVALID_MEMORY_REVOCATION_INDEX");
    db.prepare("UPDATE memory_revocation_index_build SET cursor=?,done=?,total=?,finished_at=?,ready=? WHERE id=1").run(hi, done, total, last ? Date.now() : null, last ? 1 : 0);
    db.exec("COMMIT");
    return { ready: last, done, total };
  } catch (error) {
    rollback(db);
    try { db.exec("DROP TABLE IF EXISTS temp.memory_revocation_slice"); } catch { /* gone with the rollback */ }
    throw error;
  }
}

/** Runs the backfill to the end at start-up, before the server takes traffic, reporting
 * progress to the upgrade note (the desktop shows it and waits past its usual start-up
 * budget). Nothing to do on a ready or pre-v8 file. A failure leaves a correct file: the
 * flag stays unset, revocation keeps reading the JSON, and the next start carries on. */
export function finishRevocationIndexAtStartup(db: DatabaseSync, options: { onProgress?: (event: RevocationIndexEvent) => void; slice?: number } = {}): { built: boolean } {
  const row = buildRow(db);
  if (row === undefined || (row !== null && Number(row.ready) === 1)) return { built: false };
  const report = (event: RevocationIndexEvent) => { try { options.onProgress?.(event); } catch { /* a status note never stops start-up */ } };
  report({ phase: "indexing", done: Number(row?.done ?? 0), total: Number(row?.total ?? 0) });
  for (;;) {
    const step = buildRevocationIndexStep(db, options.slice);
    report({ phase: "indexing", done: Math.min(step.done, step.total), total: step.total });
    if (step.ready) return { built: true };
  }
}

/** Time budget of one background slice's transaction: the slice ends after the chunk that crosses it. */
export const BACKFILL_SLICE_TARGET_MS = 5;
/** The background slice starts this small, grows only while it stays within the target, shrinks at once on an overrun, and never passes the cap. */
export const BACKFILL_START_ROWS = 32;
export const BACKFILL_MIN_ROWS = 8;
export const BACKFILL_MAX_ROWS = 512;
/** The pause the backfill leaves the event loop between slices (always a real timer, never an immediate). */
export const BACKFILL_PAUSE_MS = 5;
/** The pause while an owner turn is live: the build slows, it never stops, so a constantly active person still gets an index. */
export const BACKFILL_BUSY_PAUSE_MS = 250;
/** A lock held by something else (another connection or process): the slice is tried again this much later. */
export const BACKFILL_LOCKED_RETRY_MS = 1000;
export type RevocationIndexBackfill = {
  done: Promise<{ built: boolean }>; stop(): void;
  stats: { slices: number; maxSliceMs: number; lockedRetries: number; maxSliceRows: number };
};

/** The next slice size from the last one: grow gently while within the target, shrink in proportion (at least by half) the moment it overran. */
export function nextBackfillSliceRows(size: number, ms: number, targetMs: number): number {
  const next = ms <= targetMs ? Math.ceil(size * 1.25) : Math.floor(size * Math.min(0.5, targetMs / Math.max(ms, 0.001)));
  return Math.max(BACKFILL_MIN_ROWS, Math.min(BACKFILL_MAX_ROWS, next));
}

/** The same backfill as finishRevocationIndexAtStartup, run in the background after the server
 * listens. Each slice is a short writer transaction whose length is bounded by TIME, not only by
 * rows: it works in chunks of a few receipts and stops after the chunk that crosses the target
 * (BACKFILL_SLICE_TARGET_MS), so even on slow storage a slice blocks the loop for at most the
 * target plus one chunk. The row count of a slice starts small, grows only while slices stay
 * within the target, shrinks at once on an overrun, and is capped. Between slices the loop is
 * handed back for a real timer (never an immediate), and `admit` (the writer gate) is awaited
 * before each slice's transaction, so a writer hold or deletion exclusion is respected. While an
 * owner turn is live (`busy`) the pause is longer, never infinite. Receipts written meanwhile are
 * captured by the triggers; the persisted cursor covers the older ones, and a stopped process
 * resumes from it. Until the ready flag flips, revocation reads the JSON, so nothing waits on this.
 * A lock held by another connection delays the slice; any other failure stops the run quietly
 * (the next start carries on). */
export function startRevocationIndexBackfill(db: DatabaseSync, options: { busy?: () => boolean; admit?: () => Promise<void>; targetMs?: number; pauseMs?: number; busyPauseMs?: number; slice?: number; afterChunk?: () => void; onError?: (error: unknown) => void } = {}): RevocationIndexBackfill {
  const target = options.targetMs ?? BACKFILL_SLICE_TARGET_MS, pause = Math.max(1, options.pauseMs ?? BACKFILL_PAUSE_MS), busyPause = Math.max(1, options.busyPauseMs ?? BACKFILL_BUSY_PAUSE_MS);
  const stats: RevocationIndexBackfill["stats"] = { slices: 0, maxSliceMs: 0, lockedRetries: 0, maxSliceRows: 0 };
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, resolve!: (value: { built: boolean }) => void;
  const done = new Promise<{ built: boolean }>(r => { resolve = r; });
  const row = buildRow(db);
  if (row === undefined || (row !== null && Number(row.ready) === 1)) { resolve({ built: false }); return { done, stop() {}, stats }; }
  let size = Math.max(1, Math.min(BACKFILL_MAX_ROWS, Math.trunc(options.slice ?? BACKFILL_START_ROWS))), reportedOnce = false;
  const finish = (built: boolean) => { stopped = true; if (timer) clearTimeout(timer); resolve({ built }); };
  const tick = async () => {
    timer = null;
    if (stopped) return;
    let delay = pause;
    try {
      if (options.admit) await options.admit();
      if (stopped) return;
      const t0 = performance.now();
      const step = buildRevocationIndexStep(db, size, { budgetMs: target, afterChunk: options.afterChunk });
      const ms = performance.now() - t0;
      stats.slices++;
      stats.maxSliceMs = Math.max(stats.maxSliceMs, ms);
      stats.maxSliceRows = Math.max(stats.maxSliceRows, size);
      if (step.ready) { finish(true); return; }
      size = nextBackfillSliceRows(size, ms, target);
      if (options.busy?.()) delay = busyPause;
    } catch (error) {
      if (lockedError(error)) { stats.lockedRetries++; delay = BACKFILL_LOCKED_RETRY_MS; }
      else {
        if (!reportedOnce) { reportedOnce = true; try { options.onError?.(error); } catch { /* reporting never throws into the loop */ } }
        finish(false); return;
      }
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, delay);
  };
  timer = setTimeout(() => { void tick(); }, 0);
  return { done, stop() { finish(false); }, stats };
}
