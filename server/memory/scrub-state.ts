// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where the 1.0.4 number scrub keeps its place (scrub-pass.ts): one row of messages.db outside the memory schema (its name does not start
// with memory_, so the exact-schema check of the memory tables never sees it; listed as an app table in installation-database-snapshot.ts).
// A leaf module, so the migration can record a new file's pass as done inside its own transaction.
import type { DatabaseSync } from "node:sqlite";
import { FINANCIAL_RULE_VERSION } from "../../shared/financial-ids.ts";

export const SCRUB_PASS_TABLE = "upgrade_scrub_pass";
export const SCRUB_PASS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${SCRUB_PASS_TABLE}(
  id INTEGER PRIMARY KEY CHECK(id=1), rule_version INTEGER NOT NULL, phase TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, finished_at INTEGER)`;
export const SCRUB_PHASES = ["versions", "records", "details", "feedback", "settle", "done"] as const;
export type ScrubPhase = (typeof SCRUB_PHASES)[number];
export interface ScrubPassRow { ruleVersion: number; phase: ScrubPhase; cursor: number; changed: number; skipped: number; total: number; startedAt: number; finishedAt: number | null }

export function ensureScrubPassTable(db: DatabaseSync): void { db.exec(SCRUB_PASS_SCHEMA); }
function hasTable(db: DatabaseSync): boolean { return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(SCRUB_PASS_TABLE)); }

export function readScrubPass(db: DatabaseSync): ScrubPassRow | null {
  if (!hasTable(db)) return null;
  const row = db.prepare(`SELECT * FROM ${SCRUB_PASS_TABLE} WHERE id=1`).get();
  if (!row) return null;
  return { ruleVersion: Number(row.rule_version), phase: String(row.phase) as ScrubPhase, cursor: Number(row.cursor), changed: Number(row.changed), skipped: Number(row.skipped),
    total: Number(row.total), startedAt: Number(row.started_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at) };
}

/** Whether this file still owes the scrub: no pass row (a file 1.0.3 or earlier wrote, or a restore of one: D10), a row of an older rule
 * version (a new rule reruns the whole pass), or a pass not yet done. */
export function scrubPassPending(db: DatabaseSync): boolean {
  const row = readScrubPass(db);
  return row === null || row.ruleVersion < FINANCIAL_RULE_VERSION || row.phase !== "done";
}

/** A new file has nothing to scrub: its pass is recorded as done in the transaction that makes it (schema.ts). */
export function seedScrubPassDone(db: DatabaseSync, now = Date.now()): void {
  ensureScrubPassTable(db);
  db.prepare(`INSERT OR IGNORE INTO ${SCRUB_PASS_TABLE}(id,rule_version,phase,cursor,changed,skipped,total,started_at,finished_at) VALUES(1,?,'done',0,0,0,0,?,?)`).run(FINANCIAL_RULE_VERSION, now, now);
}
