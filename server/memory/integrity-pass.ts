// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The background integrity pass. An upgrade from memory v6 or later used to read every row of the file twice before the app opened (a
// 48 GB history took six minutes of that). The upgrade steps change no existing memory row, so the proofs about row data are the same
// before and after them, and they now run here instead, in slices of a few tens of milliseconds, after the server listens:
//   1. the output index equals the receipts' JSON, one slice of receipts at a time;
//   2. every foreign key resolves, one slice of one table at a time;
//   3. the JSON columns have their shapes, every record's assertion is one of the allowed values and every record has its details row
//      (the checks the second full validation of the migration used to make), one range of rows at a time;
//   4. the learning ledger and the lessons point at rows that exist.
// Each proof still runs in full. The place reached is committed after every slice (integrity-state.ts), so a stopped server carries on
// from it. Until the pass has finished, replay of earlier outputs is withheld (the same fail-closed gate the lineage repair uses).
//   - The output index is derived data: a slice that differs is rewritten from the JSON, which is the authority, then checked again. The
//     rewrite is sliced like the proof (a few receipts, or one long receipt's rows a page at a time, each its own transaction, within the
//     same time), and it is idempotent: a stopped server proves the receipts again from the same cursor and finishes what is left. Readers
//     stay fail-closed throughout, because the pass is not finished until the rewritten part has been proven again.
//   - The other two read source data that cannot be derived from anything: a mismatch sets a hold (memory is not recalled, disclosed,
//     replayed or learned from; chats are not affected) and nothing is deleted. The owner is told in plain words.
// Writes made while the pass runs happen under foreign_keys=ON and the triggers, so a new row cannot create a defect the pass is
// looking for in a part of the file it has already passed.
import type { DatabaseSync } from "node:sqlite";
import { backgroundWrite, beginBackground } from "../db-busy.ts";
import { fillReceiptIndexPage, firstLongReceipt, nextBundleBound, outputIndexDiffers, pruneReceiptIndexPage, rebuildOutputIndexSlice, receiptBefore, receiptChangedSinceScan, receiptOutputRowsPage, receiptOutputsPiece, referencesBrokenFrom, rowChecks, startReceiptScan, type BundleRange, type ReceiptScan } from "./schema.ts";
import { INTEGRITY_TOTAL, integrityHoldOf, readIntegrityPass, writeIntegrityPass, type IntegrityPassRow, type IntegrityPhase } from "./integrity-state.ts";

/** The most receipts in one slice of the output-index proof. */
export const INTEGRITY_RECEIPT_SLICE = 1_000;
/** The output-index proof is sized by time, not by receipts: a receipt of a heavy history lists thousands of replies, so a fixed count of receipts
 * held the main loop for over 600 ms a slice on a 48 GB file. Each slice aims at this long and the next one's receipt count follows what the last one
 * measured (from one receipt up to INTEGRITY_RECEIPT_SLICE), starting small. */
export const INTEGRITY_SLICE_TARGET_MS = 20;
const FIRST_RECEIPT_SLICE = 32;
const receiptSliceByDb = new WeakMap<object, number>();
/** Rows per slice of a reference check. */
export const INTEGRITY_REFERENCE_SLICE = 2_000;
/** Rows per slice of a shape, assertion or details check. */
export const INTEGRITY_SHAPE_SLICE = 5_000;
/** Rows per slice of the ledger and lesson checks. */
export const INTEGRITY_LEARNING_SLICE = 5_000;
/** The first row window of a shape, learning or reference statement. Each later window follows what the last one measured (see adaptiveWindow). */
export const INTEGRITY_FIRST_WINDOW = 256, INTEGRITY_MIN_WINDOW = 16;
const windowsByDb = new WeakMap<object, Map<string, number>>();
/** The rows the next statement of check `key` may cover: the first is small, then it follows time, so no statement runs far past the slice budget
 * (a fixed 5,000-row window held the loop for 430 ms on a 48 GB file). */
export function adaptiveWindow(db: object, key: string, cap: number): number {
  return Math.max(1, Math.min(cap, windowsByDb.get(db)?.get(key) ?? Math.min(cap, INTEGRITY_FIRST_WINDOW)));
}
/** The rows the next statement covers after one over `size` rows took `tookMs`: halved as soon as it ran past the target, doubled when it took under a
 * quarter of it, kept otherwise (PagedScan's rule; rc13 real-data run: integrity slices of 23 to 149 ms against the 20 ms budget, each one statement
 * that the old rule, which halved only past twice the target and grew toward it, let run long). */
export function nextWindowSize(size: number, tookMs: number, cap: number, min: number): number {
  const next = tookMs > INTEGRITY_SLICE_TARGET_MS ? size / 2 : tookMs < INTEGRITY_SLICE_TARGET_MS / 4 ? size * 2 : size;
  return Math.max(Math.min(min, cap), Math.min(cap, Math.floor(next)));
}
/** Records what a statement over `size` rows took, for the next statement of the same check (nextWindowSize). */
export function adaptWindow(db: object, key: string, size: number, tookMs: number, cap: number): void {
  let map = windowsByDb.get(db); if (!map) { map = new Map(); windowsByDb.set(db, map); }
  map.set(key, nextWindowSize(size, tookMs, cap, INTEGRITY_MIN_WINDOW));
}
/** The share of the bar each proof owns (thousandths). */
export const OUTPUT_END = 300, REFERENCES_END = 700, SHAPES_END = 950;

export const HOLD_MESSAGES: Record<string, string> = {
  INVALID_MEMORY_REFERENCE: "Part of your memory points at something that is no longer there, so Murage has set memory aside until it is looked at. Your chats work as usual and nothing was deleted. To get help, make a copy of your data with the installation-recovery command (export-damaged) and send it to support.",
  INVALID_MEMORY_OUTPUT_INDEX: "Murage could not rebuild the record of which replies used your memory, so it has set memory aside until it is looked at. Your chats work as usual and nothing was deleted. To get help, make a copy of your data with the installation-recovery command (export-damaged) and send it to support.",
  INVALID_MEMORY_JSON_SHAPE: "Part of your memory is stored in a form Murage does not recognise, so it has set memory aside until it is looked at. Your chats work as usual and nothing was deleted. To get help, make a copy of your data with the installation-recovery command (export-damaged) and send it to support.",
  INVALID_MEMORY_ASSERTION: "Part of your memory is stored in a form Murage does not recognise, so it has set memory aside until it is looked at. Your chats work as usual and nothing was deleted. To get help, make a copy of your data with the installation-recovery command (export-damaged) and send it to support.",
  INVALID_MEMORY_RECORD_DETAILS: "Part of your memory is missing some of its details, so Murage has set memory aside until it is looked at. Your chats work as usual and nothing was deleted. To get help, make a copy of your data with the installation-recovery command (export-damaged) and send it to support.",
  INVALID_MEMORY_LEARNING_EVENT: "Part of what Murage learned from you points at something that is no longer there, so Murage has set memory aside until it is looked at. Your chats work as usual and nothing was deleted. To get help, make a copy of your data with the installation-recovery command (export-damaged) and send it to support.",
  INVALID_MEMORY_LESSON_EVENT: "Part of what Murage learned from you points at something that is no longer there, so Murage has set memory aside until it is looked at. Your chats work as usual and nothing was deleted. To get help, make a copy of your data with the installation-recovery command (export-damaged) and send it to support.",
};
export const holdMessage = (code: string): string => HOLD_MESSAGES[code] ?? HOLD_MESSAGES.INVALID_MEMORY_REFERENCE!;

const encodeKey = (key: unknown[]): string => JSON.stringify(key.map(value => typeof value === "bigint" ? { i: value.toString() } : value instanceof Uint8Array ? { b: Buffer.from(value).toString("hex") } : value));
const decodeKey = (text: string): unknown[] => (JSON.parse(text) as unknown[]).map(value => {
  if (value && typeof value === "object" && "i" in value) return BigInt(String((value as { i: unknown }).i));
  if (value && typeof value === "object" && "b" in value) return Buffer.from(String((value as { b: unknown }).b), "hex");
  return value;
});

export interface IntegrityStepOptions {
  /** How long one call may work before it hands back (default 50 ms). */
  budgetMs?: number;
  now?: () => number;
  /** Test hook: called after each slice commits, with the phase it was in (a kill is a throw from here). */
  afterSlice?: (phase: IntegrityPhase) => void;
  receiptSlice?: number; referenceSlice?: number; shapeSlice?: number; learningSlice?: number;
  /** Test hook: called after each page of an index rewrite with the rows it went through (a test charges a simulated cost per row here). */
  onRewriteRows?: (rows: number) => void;
}
export interface IntegrityStepResult { more: boolean; row: IntegrityPassRow | null; slices: number }

function referenceTables(db: DatabaseSync, after: string): string[] {
  return db.prepare("SELECT m.name AS name FROM sqlite_schema m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name>? AND EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name)) ORDER BY m.name").all(after).map(row => String(row.name));
}
function allReferenceTableCount(db: DatabaseSync): number {
  return Number(db.prepare("SELECT count(*) AS n FROM sqlite_schema m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name))").get()?.n ?? 0);
}
/** Where a bundle id sits in the receipts, 0..1, when its leading digits are hex (bundle ids are random); null otherwise. */
function idFraction(id: string | null): number | null {
  if (id === null) return 0;
  const lead = /^[0-9a-f]{8}/i.exec(id)?.[0];
  return lead ? parseInt(lead, 16) / 0xffffffff : null;
}
const progressByDb = new WeakMap<object, { taken: number; total: number }>();
/** Bytes of a long receipt's stored output list one piece reads, and rows of its index one piece counts. */
export const LONG_RECEIPT_BYTES_PIECE = 64 * 1024;
export const LONG_RECEIPT_ROWS_PIECE = 5_000;
const LONG_ROWS_KEY = "long-receipt-rows";
/** A long receipt being proven piece by piece (its JSON list, then its index rows), in this process: a restart begins that receipt again. */
interface LongReceipt { lo: string | null; bundle: string; scan: ReceiptScan | null; after: string | null; rows: number; distinct: number; missing: boolean; rebuilt: boolean;
  /** The sliced rewrite of this receipt's index, once its proof found it differs: rows the JSON does not name go (prune), then the rows it lacks are
   * added (fill), a page at a time in message id order. `changed` counts the rows deleted and added. */
  rewrite: { stage: "prune" | "fill"; after: string | null; changed: number; thread: string } | null }
const longReceipts = new WeakMap<object, LongReceipt>();
/** A slice of ordinary receipts whose index differs, being rewritten a few receipts at a time: the receipts in (lo, at] are done. */
interface SliceRewrite { lo: string | null; hi: string | null; at: string | null; size: number; repaired: number }
const sliceRewrites = new WeakMap<object, SliceRewrite>();
/** Index rows a rewrite page goes through at most, and the first page before anything is measured. */
export const REWRITE_PAGE_MAX = 2_000;
const REWRITE_FIRST_PAGE = 64;
/** What a rewrite page cost per row (ms) and a receipt rewrite per receipt, last measured on this connection: the next page is sized to the time left. */
const rewriteCost = new WeakMap<object, { perRow: number | null; perReceipt: number | null }>();
const costOf = (db: DatabaseSync) => { let cost = rewriteCost.get(db); if (!cost) rewriteCost.set(db, cost = { perRow: null, perReceipt: null }); return cost; };
/** How many units (rows, receipts) fit in the time left, from the last measured cost: the first is `first`, never fewer than one, never more than `max`.
 * Zero when nothing fits and this call has already done some work (the caller hands back); the first size when nothing fits but the call must move. */
function fitting(left: number, per: number | null, first: number, max: number, mustMove: boolean): number {
  if (per === null) return mustMove || left > 0 ? Math.min(first, max) : 0;
  const n = Math.floor(left / Math.max(per, 1e-6));
  if (n >= 1) return Math.min(max, n);
  // a call that must move (its first unit) takes the first-page size even with no time left: one row a call would never end a long receipt
  return mustMove ? Math.min(first, max) : 0;
}

function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  // a background slice (the upgrade queue): within the background budget; a busy start throws and the queue tries later
  beginBackground(db, "integrity-pass");
  try { const out = run(); db.exec("COMMIT"); return out; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
}

/** Runs the pass for about `budgetMs` and commits its place after every slice. A file with no unfinished pass answers `more: false`.
 * Throws on a database error (busy, full disk): the place is already committed, so the caller tries again later. */
export function stepIntegrityPass(db: DatabaseSync, options: IntegrityStepOptions = {}): IntegrityStepResult {
  const now = options.now ?? (() => performance.now());
  const started = now(), budget = options.budgetMs ?? 50;
  let row = readIntegrityPass(db), slices = 0;
  if (!row || row.finishedAt !== null) return { more: false, row, slices };
  // the pass's place is an autocommit write: within the background budget too (a held lock is "try later", the place stays where it was)
  const keepPlace = (patch: Parameters<typeof writeIntegrityPass>[1]) => backgroundWrite(db, "integrity-progress", () => writeIntegrityPass(db, patch));
  const finish = (result: string) => { keepPlace({ phase: "done", cursor: null, done: INTEGRITY_TOTAL, finishedAt: Date.now(), result }); };
  const hold = (code: string) => { keepPlace({ phase: row!.phase, finishedAt: Date.now(), result: `held:${code}` }); console.warn(`[memory] integrity pass: ${code}; memory is set aside until it is looked at (nothing was deleted)`); };
  // (at least one slice per call, so a budget of zero still moves)
  for (let first = true; first || now() - started < budget; first = false) {
    row = readIntegrityPass(db)!;
    if (row.finishedAt !== null) break;
    if (row.phase === "output-index") {
      const lo = row.cursor;
      let long = longReceipts.get(db);
      if (long && long.lo !== lo) { longReceipts.delete(db); long = undefined; }
      // a write to the receipt while its proof (or rewrite) spans slices: that receipt is begun again, from a fresh read of its list
      if (long && receiptChangedSinceScan(db, long.bundle)) { longReceipts.delete(db); long = undefined; }
      if (!long) {
        // a receipt whose list is long is proven in pieces; the receipts before it go as one slice, as before
        const ahead = nextBundleBound(db, lo, options.receiptSlice ?? receiptSliceByDb.get(db) ?? FIRST_RECEIPT_SLICE);
        const first = firstLongReceipt(db, { lo, hi: ahead });
        if (first !== null && receiptBefore(db, lo, first) === null) { long = { lo, bundle: first, scan: startReceiptScan(db, first), after: null, rows: 0, distinct: 0, missing: false, rebuilt: false, rewrite: null }; longReceipts.set(db, long); }
      }
      if (long) {
        if (long.rewrite) {
          // one page of the rewrite, sized to the time left; each page is its own transaction
          const cost = costOf(db), rewrite = long.rewrite;
          const limit = fitting(budget - (now() - started), cost.perRow, REWRITE_FIRST_PAGE, REWRITE_PAGE_MAX, first);
          if (limit === 0) break;
          const pageStarted = now();
          const page = inTransaction(db, () => rewrite.stage === "prune"
            ? (({ rows, removed, last }) => ({ rows, changed: removed, last }))(pruneReceiptIndexPage(db, long!.bundle, rewrite.thread, rewrite.after, limit))
            : (({ rows, added, last }) => ({ rows, changed: added, last }))(fillReceiptIndexPage(db, long!.bundle, rewrite.thread, rewrite.after, limit)));
          options.onRewriteRows?.(page.rows);
          if (page.rows > 0) cost.perRow = (now() - pageStarted) / page.rows;
          rewrite.changed += page.changed; rewrite.after = page.last;
          if (page.rows < limit) {
            if (rewrite.stage === "prune") Object.assign(rewrite, { stage: "fill", after: null });
            else {
              // rewritten: the receipt is proven again from the start, and a second difference is a hold
              console.warn(`[memory] integrity pass: the output index differed from the receipts for a long receipt; rewrote ${rewrite.changed} rows from the receipts`);
              keepPlace({ repaired: row.repaired + rewrite.changed });
              Object.assign(long, { scan: startReceiptScan(db, long.bundle), after: null, rows: 0, distinct: 0, missing: false, rebuilt: true, rewrite: null });
            }
          }
          slices++; options.afterSlice?.("output-index");
          continue;
        }
        if (long.scan && !long.scan.done) {
          const piece = receiptOutputsPiece(db, long.scan, LONG_RECEIPT_BYTES_PIECE);
          long.missing ||= piece.missing; long.distinct += piece.added;
        } else {
          // the rows one page counts follow time too (a fixed 5,000-row page was one long statement)
          const piece = adaptiveWindow(db, LONG_ROWS_KEY, LONG_RECEIPT_ROWS_PIECE), pageStarted = now();
          const page = receiptOutputRowsPage(db, long.bundle, long.after, piece);
          adaptWindow(db, LONG_ROWS_KEY, piece, now() - pageStarted, LONG_RECEIPT_ROWS_PIECE);
          long.rows += page.rows; long.after = page.last;
          if (page.rows < piece) {
            // the whole receipt was read: its index equals its JSON when no entry lacked a row and no row is one the JSON does not name
            if (long.missing || long.rows !== long.distinct) {
              if (long.rebuilt) { longReceipts.delete(db); hold("INVALID_MEMORY_OUTPUT_INDEX"); break; }
              // never the whole receipt in one transaction: the rewrite goes a page at a time (above), from the list the proof has just tallied
              long.rewrite = { stage: "prune", after: null, changed: 0, thread: long.scan?.thread ?? "" };
            } else {
              longReceipts.delete(db);
              keepPlace({ cursor: long.bundle, done: Math.floor(OUTPUT_END * (idFraction(long.bundle) ?? 0.5)) });
            }
          }
        }
        slices++; options.afterSlice?.("output-index");
        continue;
      }
      let rewriting = sliceRewrites.get(db);
      if (rewriting && rewriting.lo !== lo) { sliceRewrites.delete(db); rewriting = undefined; }
      const sliceStarted = now();
      let size: number, hi: string | null, repaired = 0;
      if (rewriting) {
        // a slice whose index differs is rewritten a few receipts at a time (as many as the time left holds), each step its own transaction
        const cost = costOf(db), at = rewriting;
        const count = fitting(budget - (now() - started), cost.perReceipt, 1, INTEGRITY_RECEIPT_SLICE, first);
        if (count === 0) break;
        const stepStarted = now();
        let end = nextBundleBound(db, at.at, count);
        if (at.hi !== null && (end === null || end > at.hi)) end = at.hi;
        const part: BundleRange = { lo: at.at, hi: end };
        at.repaired += inTransaction(db, () => rebuildOutputIndexSlice(db, part));
        cost.perReceipt = (now() - stepStarted) / count;
        at.at = end;
        if (end !== at.hi) { slices++; options.afterSlice?.("output-index"); continue; }
        // the whole slice is rewritten: it is proven again, and a second difference is a hold
        sliceRewrites.delete(db);
        size = at.size; hi = at.hi; repaired = at.repaired;
        if (outputIndexDiffers(db, { lo, hi })) { hold("INVALID_MEMORY_OUTPUT_INDEX"); break; }
        console.warn(`[memory] integrity pass: the output index differed from the receipts for a slice of receipts; rewrote ${repaired} rows from the receipts`);
      } else {
        size = options.receiptSlice ?? receiptSliceByDb.get(db) ?? FIRST_RECEIPT_SLICE;
        hi = nextBundleBound(db, lo, size);
        // never a long receipt inside an ordinary slice: the slice ends just before it
        const longAhead = firstLongReceipt(db, { lo, hi });
        if (longAhead !== null) hi = receiptBefore(db, lo, longAhead);
        if (outputIndexDiffers(db, { lo, hi })) {
          sliceRewrites.set(db, { lo, hi, at: lo, size, repaired: 0 });
          slices++; options.afterSlice?.("output-index");
          continue;
        }
      }
      const progress = progressByDb.get(db) ?? { taken: 0, total: Math.max(1, Number(db.prepare("SELECT max(rowid) AS n FROM memory_disclosures").get()?.n ?? 1)) };
      progress.taken += size; progressByDb.set(db, progress);
      const fraction = hi === null ? 1 : idFraction(hi) ?? Math.min(0.99, progress.taken / progress.total);
      if (hi === null) { progressByDb.delete(db); keepPlace({ phase: "references", cursor: null, done: OUTPUT_END, repaired: row.repaired + repaired }); }
      else keepPlace({ cursor: hi, done: Math.floor(OUTPUT_END * fraction), repaired: row.repaired + repaired });
      if (options.receiptSlice === undefined && repaired === 0) {
        // the next slice's size from this one's time: halved as soon as it ran past the target, doubled when it ran well short
        receiptSliceByDb.set(db, nextWindowSize(size, now() - sliceStarted, INTEGRITY_RECEIPT_SLICE, 1));
      }
      slices++; options.afterSlice?.("output-index");
    } else if (row.phase === "references") {
      // cursor: {"t": table, "k": encoded key or null}; a table is done when its walk finishes
      let at: { t: string; k: string | null; d?: boolean } = { t: "", k: null };
      if (row.cursor) { try { at = JSON.parse(row.cursor) as { t: string; k: string | null; d?: boolean }; } catch { /* restart the table list */ } }
      const tables = !at.t ? referenceTables(db, "") : at.d ? referenceTables(db, at.t) : [at.t, ...referenceTables(db, at.t)];
      const table = tables[0];
      if (table === undefined) { keepPlace({ phase: "shapes", cursor: null, done: REFERENCES_END }); slices++; options.afterSlice?.("references"); continue; }
      // one statement window per call, sized by the time the last one took, so no statement runs far past the budget
      const refKey = `ref:${table}`, refSize = options.referenceSlice ?? adaptiveWindow(db, refKey, INTEGRITY_REFERENCE_SLICE), refStarted = now();
      const step = referencesBrokenFrom(db, table, at.k ? decodeKey(at.k) : null, { slice: refSize, stop: options.referenceSlice === undefined ? () => true : () => now() - started >= budget });
      if (options.referenceSlice === undefined) adaptWindow(db, refKey, refSize, now() - refStarted, INTEGRITY_REFERENCE_SLICE);
      if (step.broken) { hold("INVALID_MEMORY_REFERENCE"); break; }
      const total = Math.max(1, allReferenceTableCount(db)), index = Math.max(0, total - referenceTables(db, table).length - 1);
      const next = step.finished ? { t: table, k: null, d: true } : { t: table, k: encodeKey(step.next!), d: false };
      keepPlace({ cursor: JSON.stringify(next), done: OUTPUT_END + Math.floor((REFERENCES_END - OUTPUT_END) * Math.min(1, (index + (step.finished ? 1 : 0.5)) / total)) });
      slices++; options.afterSlice?.("references");
    } else if (row.phase === "shapes") {
      // cursor: {"i": index of the check, "lo": the last rowid checked}; a check is done when its rowids are used up
      const version = Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version ?? 0);
      const checks = rowChecks(version);
      let at = { i: 0, lo: 0 };
      if (row.cursor) { try { at = JSON.parse(row.cursor) as typeof at; } catch { /* start the list again */ } }
      const check = checks[at.i];
      if (!check) { keepPlace({ phase: "learning", cursor: null, done: SHAPES_END }); slices++; options.afterSlice?.("shapes"); continue; }
      const shapeKey = `shape:${check.table}:${check.code}`;
      const size = Math.max(1, Math.trunc(options.shapeSlice ?? adaptiveWindow(db, shapeKey, INTEGRITY_SHAPE_SLICE)));
      const newest = Number(db.prepare(`SELECT max(rowid) AS n FROM ${check.table}`).get()?.n ?? 0);
      const hi = Math.min(newest, at.lo + size);
      const shapeStarted = now();
      if (hi > at.lo && check.bad(db, at.lo, hi)) { hold(check.code); break; }
      if (options.shapeSlice === undefined && hi > at.lo) adaptWindow(db, shapeKey, size, now() - shapeStarted, INTEGRITY_SHAPE_SLICE);
      const next = hi >= newest ? { i: at.i + 1, lo: 0 } : { i: at.i, lo: hi };
      const share = (at.i + (hi >= newest ? 1 : newest > 0 ? hi / newest : 1)) / checks.length;
      keepPlace({ cursor: JSON.stringify(next), done: REFERENCES_END + Math.floor((SHAPES_END - REFERENCES_END) * Math.min(1, share)) });
      slices++; options.afterSlice?.("shapes");
    } else if (row.phase === "learning") {
      // cursor: "e:<rowid>" over the ledger, then "l:<rowid>" over the lessons
      const version = Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version ?? 0);
      const cursor = row.cursor ?? (version >= 4 ? "e:0" : "l:0");
      const table = cursor.startsWith("e:") ? "memory_learning_events" : "memory_lessons";
      const learnKey = `learning:${table}`;
      const size = options.learningSlice ?? adaptiveWindow(db, learnKey, INTEGRITY_LEARNING_SLICE);
      const learnStarted = now();
      const lo = Number(cursor.slice(2)), newest = Number(db.prepare(`SELECT max(rowid) AS n FROM ${table}`).get()?.n ?? 0), hi = Math.min(newest, lo + size);
      let bad = false;
      if (hi > lo) {
        bad = table === "memory_learning_events"
          ? Boolean(db.prepare(`SELECT 1 FROM memory_learning_events e WHERE e.rowid>? AND e.rowid<=? AND (
              NOT EXISTS(SELECT 1 FROM memory_scopes s WHERE s.id=e.scope_id)
              OR (e.record_id IS NOT NULL AND e.record_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_records r WHERE r.id=e.record_id AND r.version=e.record_version))) LIMIT 1`).get(lo, hi))
          : version >= 5 && Boolean(db.prepare(`SELECT 1 FROM memory_lessons l WHERE l.rowid>? AND l.rowid<=? AND l.state='active'
              AND (l.learning_event_id IS NULL OR NOT EXISTS(SELECT 1 FROM memory_learning_events e WHERE e.id=l.learning_event_id)) LIMIT 1`).get(lo, hi));
      }
      if (options.learningSlice === undefined && hi > lo) adaptWindow(db, learnKey, size, now() - learnStarted, INTEGRITY_LEARNING_SLICE);
      if (bad) { hold(table === "memory_learning_events" ? "INVALID_MEMORY_LEARNING_EVENT" : "INVALID_MEMORY_LESSON_EVENT"); break; }
      if (hi >= newest) {
        if (table === "memory_learning_events" && version >= 5) keepPlace({ cursor: "l:0", done: SHAPES_END + 25 });
        else { finish("passed"); slices++; options.afterSlice?.("learning"); break; }
      } else keepPlace({ cursor: `${cursor.slice(0, 2)}${hi}`, done: SHAPES_END + (table === "memory_learning_events" ? 0 : 25) + 12 });
      slices++; options.afterSlice?.("learning");
    } else { finish("passed"); break; }
  }
  row = readIntegrityPass(db);
  return { more: row !== null && row.finishedAt === null, row, slices };
}

/** Runs the pass to its end in this call (no budget). For a test, a restore that must prove a file whole, and a caller that cannot wait for the background. */
export function runIntegrityPassToEnd(db: DatabaseSync, options: IntegrityStepOptions = {}): IntegrityPassRow | null {
  for (;;) {
    const step = stepIntegrityPass(db, { ...options, budgetMs: 1_000 });
    if (!step.more) return step.row;
  }
}
export { integrityHoldOf };
