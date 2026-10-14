// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where the background integrity pass keeps its place (integrity-pass.ts). An upgrade from memory v6 or later no longer reads every
// row of the file before the app opens: the proofs that need whole tables run after the server listens, in slices, and the features
// that depend on a proof stay held until it has passed. The place lives in this one-row table of messages.db, outside the memory schema
// (its name does not start with memory_, so the exact-schema check of the memory tables never sees it, and it is listed as an app
// table for the archive inspector in installation-database-snapshot.ts). A leaf module: no imports from the memory schema, so the
// migration can write the row inside its own transaction.
import type { DatabaseSync } from "node:sqlite";

export const INTEGRITY_PASS_TABLE = "upgrade_integrity_pass";
export const INTEGRITY_PASS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${INTEGRITY_PASS_TABLE}(
  id INTEGER PRIMARY KEY CHECK(id=1), phase TEXT NOT NULL, cursor TEXT, done INTEGER NOT NULL, total INTEGER NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT, repaired INTEGER NOT NULL DEFAULT 0,
  lessons_floor INTEGER, feedback_floor INTEGER, events_floor INTEGER)`;
/** The three admission floors (see beginIntegrityPass): the highest rowid each table held when the pass began. */
const FLOOR_COLUMNS = ["lessons_floor", "feedback_floor", "events_floor"] as const;

/** The proofs, in the order the pass runs them. */
export const INTEGRITY_PHASES = ["output-index", "references", "shapes", "learning", "done"] as const;
export type IntegrityPhase = (typeof INTEGRITY_PHASES)[number];

export interface IntegrityPassRow {
  phase: IntegrityPhase;
  cursor: string | null;
  /** Progress in thousandths of the whole pass (see integrity-pass.ts), so one bar covers all three proofs. */
  done: number;
  total: number;
  startedAt: number;
  finishedAt: number | null;
  /** null while running; "passed"; or "held:<code>" when a proof found a source row that is not valid (nothing is deleted). */
  result: string | null;
  /** Rows of the derived output index rewritten from the receipts' JSON. */
  repaired: number;
  /** Highest rowid of memory_lessons, memory_feedback and memory_learning_events when the pass began, or null for a pass an earlier build began (the
   * connection then takes the floors as they are on first load). A row at or below its floor was written before the pass proved anything. */
  lessonsFloor: number | null;
  feedbackFloor: number | null;
  eventsFloor: number | null;
}

export const INTEGRITY_TOTAL = 1000;

export function ensureIntegrityPassTable(db: DatabaseSync): void {
  db.exec(INTEGRITY_PASS_SCHEMA);
  // A row begun by an earlier build has no floor columns.
  const have = new Set((db.prepare(`PRAGMA table_info(${INTEGRITY_PASS_TABLE})`).all() as Array<{ name: string }>).map(column => String(column.name)));
  for (const column of FLOOR_COLUMNS) if (!have.has(column)) db.exec(`ALTER TABLE ${INTEGRITY_PASS_TABLE} ADD COLUMN ${column} INTEGER`);
}

/** The highest rowid of a table (one seek), 0 when it is empty or missing. */
export function maxRowid(db: DatabaseSync, table: string): number {
  try { return Number(db.prepare(`SELECT MAX(rowid) m FROM ${table}`).get()?.m ?? 0); } catch { return 0; }
}

function hasTable(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(INTEGRITY_PASS_TABLE));
}

/** Starts (or restarts) the pass. Called by the migration inside its transaction whenever it skipped the full sweep. */
export function beginIntegrityPass(db: DatabaseSync, now = Date.now()): void {
  ensureIntegrityPassTable(db);
  // The floors are taken in the same transaction as the pass row: what a table holds at or below them was written before the pass proved anything,
  // whatever its created_at says (a clock can be wrong; a rowid cannot be backdated).
  db.prepare(`INSERT OR REPLACE INTO ${INTEGRITY_PASS_TABLE}(id,phase,cursor,done,total,started_at,finished_at,result,repaired,lessons_floor,feedback_floor,events_floor) VALUES(1,'output-index',NULL,0,?,?,NULL,NULL,0,?,?,?)`)
    .run(INTEGRITY_TOTAL, now, maxRowid(db, "memory_lessons"), maxRowid(db, "memory_feedback"), maxRowid(db, "memory_learning_events"));
}

export function readIntegrityPass(db: DatabaseSync): IntegrityPassRow | null {
  try {
    if (!hasTable(db)) return null;
    const row = db.prepare(`SELECT * FROM ${INTEGRITY_PASS_TABLE} WHERE id=1`).get();
    if (!row) return null;
    const phase = INTEGRITY_PHASES.includes(row.phase as IntegrityPhase) ? row.phase as IntegrityPhase : "output-index";
    return { phase, cursor: row.cursor === null ? null : String(row.cursor), done: Number(row.done), total: Number(row.total), startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at), result: row.result === null ? null : String(row.result), repaired: Number(row.repaired),
      lessonsFloor: row.lessons_floor === null || row.lessons_floor === undefined ? null : Number(row.lessons_floor),
      feedbackFloor: row.feedback_floor === null || row.feedback_floor === undefined ? null : Number(row.feedback_floor),
      eventsFloor: row.events_floor === null || row.events_floor === undefined ? null : Number(row.events_floor) };
  } catch { return null; }
}

export function writeIntegrityPass(db: DatabaseSync, patch: Partial<Pick<IntegrityPassRow, "phase" | "cursor" | "done" | "finishedAt" | "result" | "repaired" | "lessonsFloor" | "feedbackFloor" | "eventsFloor">>): void {
  const sets: string[] = [], values: Array<string | number | null> = [];
  if (patch.phase !== undefined) { sets.push("phase=?"); values.push(patch.phase); }
  if (patch.cursor !== undefined) { sets.push("cursor=?"); values.push(patch.cursor); }
  if (patch.done !== undefined) { sets.push("done=?"); values.push(Math.max(0, Math.min(INTEGRITY_TOTAL, Math.round(patch.done)))); }
  if (patch.finishedAt !== undefined) { sets.push("finished_at=?"); values.push(patch.finishedAt); }
  if (patch.result !== undefined) { sets.push("result=?"); values.push(patch.result); }
  if (patch.repaired !== undefined) { sets.push("repaired=?"); values.push(patch.repaired); }
  if (patch.lessonsFloor !== undefined) { sets.push("lessons_floor=?"); values.push(patch.lessonsFloor); }
  if (patch.feedbackFloor !== undefined) { sets.push("feedback_floor=?"); values.push(patch.feedbackFloor); }
  if (patch.eventsFloor !== undefined) { sets.push("events_floor=?"); values.push(patch.eventsFloor); }
  if (sets.length) db.prepare(`UPDATE ${INTEGRITY_PASS_TABLE} SET ${sets.join(",")} WHERE id=1`).run(...values);
}

/** The hold code a finished pass left ("held:CODE"), or null. */
export function integrityHoldOf(row: IntegrityPassRow | null): string | null {
  return row?.result?.startsWith("held:") ? row.result.slice(5) : null;
}
/** True while the pass has not finished (a held pass is finished). */
export function integrityRunning(row: IntegrityPassRow | null): boolean { return row !== null && row.finishedAt === null; }

/** A file whose rows were proven in full by other means (a restore, whose inspection validates everything before the file is used) has nothing left for the pass. */
export function markIntegrityPassProven(db: DatabaseSync, now = Date.now()): void {
  if (!hasTable(db)) return;
  db.prepare(`UPDATE ${INTEGRITY_PASS_TABLE} SET phase='done',cursor=NULL,done=?,finished_at=?,result='passed' WHERE id=1`).run(INTEGRITY_TOTAL, now);
}
