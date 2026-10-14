// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, 1.0.2 S6: the read-time lineage judge (replay-lineage.ts: receipt groups, root sets, taint, the verdict cache) is
// RETIRED on a file where write-time lineage is written (deny-read.ts lineageLive) or the root sets were handed back
// (root-set-reclaim.ts). Retired means the judge's entry points answer from the write-time lookups (denyLookup, memoryLookup, sessionLookup)
// or, where they only fed the root sets, answer "nothing". A file with no line row yet (a brand new one, an upgraded one the first writer has
// not reached) keeps the judge as the only line judge until its first row is written.
import type { DatabaseSync } from "node:sqlite";
import { lineageLive } from "./deny-read.ts";

/** The root-set tables the idle reclaim drops (root-set-reclaim.ts). Their temp triggers and readers must not name them once gone. */
export const RETIRED_ROOT_SET_TABLES = ["memory_output_roots", "memory_session_roots", "memory_root_sets", "memory_root_set_members", "memory_root_set_parents"] as const;

/** The reclaim started or finished: memory_lineage_lsn_meta root_sets_dropped (written in the first batch's transaction). */
export function rootSetsDropped(db: DatabaseSync): boolean {
  try { return Number(db.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'").get()?.value ?? 0) === 1; } catch { return false; }
}
/** The read-time judge no longer decides on this file. One seek on a file that is live. */
export function readTimeRetired(db: DatabaseSync): boolean {
  if (judgeForcedForTest) return false;
  if (retired.has(db)) return true;
  // (monotone for a connection: once retired the judge is not asked again, even if every line row is deleted with its conversations)
  if (lineageLive(db) || rootSetsDropped(db)) { retired.add(db); return true; }
  return false;
}
const retired = new WeakSet<DatabaseSync>();

/** `sql` (one trigger per statement, each on one line, or a list of statements) without the temp triggers on a root-set table that no longer
 * exists: creating one on a dropped table fails the whole batch. */
export function withoutDroppedTableTriggers(db: DatabaseSync, sql: string): string {
  const gone = RETIRED_ROOT_SET_TABLES.filter(table => !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
  if (!gone.length) return sql;
  const names = new RegExp(`\\bON main\\.(?:${gone.join("|")})\\b`);
  return sql.split("\n").filter(line => !names.test(line)).join("\n");
}

let judgeForcedForTest = false;
/** Test support: keeps the read-time judge deciding on a file that has write-time lineage, for the unit tests whose subject is the root-set
 * machinery itself (chains, proofs, conversion) that stays in the tree until the mechanical deletion that follows the S6 gate. Production never
 * calls it; a test that does must undo it. */
export function forceReadTimeJudgeForTest(on: boolean): void { judgeForcedForTest = on; }
