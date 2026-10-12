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
//   - The output index is derived data: a slice that differs is rewritten from the JSON, which is the authority, then checked again.
//   - The other two read source data that cannot be derived from anything: a mismatch sets a hold (memory is not recalled, disclosed,
//     replayed or learned from; chats are not affected) and nothing is deleted. The owner is told in plain words.
// Writes made while the pass runs happen under foreign_keys=ON and the triggers, so a new row cannot create a defect the pass is
// looking for in a part of the file it has already passed.
import type { DatabaseSync } from "node:sqlite";
import { nextBundleBound, outputIndexDiffers, rebuildOutputIndexSlice, referencesBrokenFrom, rowChecks, type BundleRange } from "./schema.ts";
import { INTEGRITY_TOTAL, integrityHoldOf, readIntegrityPass, writeIntegrityPass, type IntegrityPassRow, type IntegrityPhase } from "./integrity-state.ts";

/** Receipts per slice of the output-index proof. */
export const INTEGRITY_RECEIPT_SLICE = 1_000;
/** Rows per slice of a reference check. */
export const INTEGRITY_REFERENCE_SLICE = 2_000;
/** Rows per slice of a shape, assertion or details check. */
export const INTEGRITY_SHAPE_SLICE = 5_000;
/** Rows per slice of the ledger and lesson checks. */
export const INTEGRITY_LEARNING_SLICE = 5_000;
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

function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
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
  const finish = (result: string) => { writeIntegrityPass(db, { phase: "done", cursor: null, done: INTEGRITY_TOTAL, finishedAt: Date.now(), result }); };
  const hold = (code: string) => { writeIntegrityPass(db, { phase: row!.phase, finishedAt: Date.now(), result: `held:${code}` }); console.warn(`[memory] integrity pass: ${code}; memory is set aside until it is looked at (nothing was deleted)`); };
  // (at least one slice per call, so a budget of zero still moves)
  for (let first = true; first || now() - started < budget; first = false) {
    row = readIntegrityPass(db)!;
    if (row.finishedAt !== null) break;
    if (row.phase === "output-index") {
      const lo = row.cursor, size = options.receiptSlice ?? INTEGRITY_RECEIPT_SLICE;
      const hi = nextBundleBound(db, lo, size), slice: BundleRange = { lo, hi };
      let repaired = 0;
      if (outputIndexDiffers(db, slice)) {
        repaired = inTransaction(db, () => rebuildOutputIndexSlice(db, slice));
        if (outputIndexDiffers(db, slice)) { hold("INVALID_MEMORY_OUTPUT_INDEX"); break; }
        console.warn(`[memory] integrity pass: the output index differed from the receipts for a slice of receipts; rewrote ${repaired} rows from the receipts`);
      }
      const progress = progressByDb.get(db) ?? { taken: 0, total: Math.max(1, Number(db.prepare("SELECT max(rowid) AS n FROM memory_disclosures").get()?.n ?? 1)) };
      progress.taken += size; progressByDb.set(db, progress);
      const fraction = hi === null ? 1 : idFraction(hi) ?? Math.min(0.99, progress.taken / progress.total);
      if (hi === null) { progressByDb.delete(db); writeIntegrityPass(db, { phase: "references", cursor: null, done: OUTPUT_END, repaired: row.repaired + repaired }); }
      else writeIntegrityPass(db, { cursor: hi, done: Math.floor(OUTPUT_END * fraction), repaired: row.repaired + repaired });
      slices++; options.afterSlice?.("output-index");
    } else if (row.phase === "references") {
      // cursor: {"t": table, "k": encoded key or null}; a table is done when its walk finishes
      let at: { t: string; k: string | null; d?: boolean } = { t: "", k: null };
      if (row.cursor) { try { at = JSON.parse(row.cursor) as { t: string; k: string | null; d?: boolean }; } catch { /* restart the table list */ } }
      const tables = !at.t ? referenceTables(db, "") : at.d ? referenceTables(db, at.t) : [at.t, ...referenceTables(db, at.t)];
      const table = tables[0];
      if (table === undefined) { writeIntegrityPass(db, { phase: "shapes", cursor: null, done: REFERENCES_END }); slices++; options.afterSlice?.("references"); continue; }
      const step = referencesBrokenFrom(db, table, at.k ? decodeKey(at.k) : null, { slice: options.referenceSlice ?? INTEGRITY_REFERENCE_SLICE, stop: () => now() - started >= budget });
      if (step.broken) { hold("INVALID_MEMORY_REFERENCE"); break; }
      const total = Math.max(1, allReferenceTableCount(db)), index = Math.max(0, total - referenceTables(db, table).length - 1);
      const next = step.finished ? { t: table, k: null, d: true } : { t: table, k: encodeKey(step.next!), d: false };
      writeIntegrityPass(db, { cursor: JSON.stringify(next), done: OUTPUT_END + Math.floor((REFERENCES_END - OUTPUT_END) * Math.min(1, (index + (step.finished ? 1 : 0.5)) / total)) });
      slices++; options.afterSlice?.("references");
    } else if (row.phase === "shapes") {
      // cursor: {"i": index of the check, "lo": the last rowid checked}; a check is done when its rowids are used up
      const version = Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version ?? 0);
      const checks = rowChecks(version);
      let at = { i: 0, lo: 0 };
      if (row.cursor) { try { at = JSON.parse(row.cursor) as typeof at; } catch { /* start the list again */ } }
      const check = checks[at.i];
      if (!check) { writeIntegrityPass(db, { phase: "learning", cursor: null, done: SHAPES_END }); slices++; options.afterSlice?.("shapes"); continue; }
      const size = Math.max(1, Math.trunc(options.shapeSlice ?? INTEGRITY_SHAPE_SLICE));
      const newest = Number(db.prepare(`SELECT max(rowid) AS n FROM ${check.table}`).get()?.n ?? 0);
      const hi = Math.min(newest, at.lo + size);
      if (hi > at.lo && check.bad(db, at.lo, hi)) { hold(check.code); break; }
      const next = hi >= newest ? { i: at.i + 1, lo: 0 } : { i: at.i, lo: hi };
      const share = (at.i + (hi >= newest ? 1 : newest > 0 ? hi / newest : 1)) / checks.length;
      writeIntegrityPass(db, { cursor: JSON.stringify(next), done: REFERENCES_END + Math.floor((SHAPES_END - REFERENCES_END) * Math.min(1, share)) });
      slices++; options.afterSlice?.("shapes");
    } else if (row.phase === "learning") {
      // cursor: "e:<rowid>" over the ledger, then "l:<rowid>" over the lessons
      const version = Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version ?? 0);
      const size = options.learningSlice ?? INTEGRITY_LEARNING_SLICE;
      const cursor = row.cursor ?? (version >= 4 ? "e:0" : "l:0");
      const table = cursor.startsWith("e:") ? "memory_learning_events" : "memory_lessons";
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
      if (bad) { hold(table === "memory_learning_events" ? "INVALID_MEMORY_LEARNING_EVENT" : "INVALID_MEMORY_LESSON_EVENT"); break; }
      if (hi >= newest) {
        if (table === "memory_learning_events" && version >= 5) writeIntegrityPass(db, { cursor: "l:0", done: SHAPES_END + 25 });
        else { finish("passed"); slices++; options.afterSlice?.("learning"); break; }
      } else writeIntegrityPass(db, { cursor: `${cursor.slice(0, 2)}${hi}`, done: SHAPES_END + (table === "memory_learning_events" ? 0 : 25) + 12 });
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
