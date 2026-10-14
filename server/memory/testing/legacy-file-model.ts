// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test support: models a file the 1.0.1 read-time machinery still runs on. On a v10 file the root-set repair and the root-set compaction do
// nothing (root-set-compaction.ts, schema.ts lineageRepairPending): they stop when memory_lineage_cert exists. A test whose subject is that
// retired machinery over legacy rows takes the certificate away on its own connection, which is the one thing a pre-v10 file lacks. The
// machinery goes at S6 and these tests with it. Production paths never use this: they must pass on the real v10 file.
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, database, transaction } from "../../database.ts";
import { addTurnParents, closeTurnLineage, memberTurnId, openTurnLineage, writeSessionLineage } from "../lineage-write.ts";
import { linkMemoryDisclosureOutput, receiptLineageRef } from "../disclosures.ts";
import { thawRootSetWritesForTest } from "../replay-lineage.ts";

const held = new WeakMap<object, { sql: string; row: Record<string, unknown> }>();
/** Takes the certificate away on this connection (root-set writes thawed too): the connection now behaves as a file 1.0.1 left. */
export function legacyFile(db: DatabaseSync): DatabaseSync {
  thawRootSetWritesForTest(true);
  if (held.has(db)) return db;
  const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_lineage_cert'").get()?.sql ?? "");
  const row = (db.prepare("SELECT * FROM memory_lineage_cert WHERE id=1").get() ?? {}) as Record<string, unknown>;
  db.exec("DROP TABLE memory_lineage_cert");
  held.set(db, { sql, row });
  return db;
}
/** Puts the certificate back (a v10 file validates only with it). */
export function v10Again(db: DatabaseSync): DatabaseSync {
  const saved = held.get(db);
  if (!saved) return db;
  db.exec(saved.sql);
  db.prepare("INSERT INTO memory_lineage_cert(id,phase,cursor,done,total,ready) VALUES(1,?,?,?,?,?)").run(String(saved.row.phase ?? "u1"), String(saved.row.cursor ?? ""), Number(saved.row.done ?? 0), Number(saved.row.total ?? 0), Number(saved.row.ready ?? 0));
  held.delete(db);
  return db;
}
/** A restart of a legacy file: closes the connection (certificate back, so the file validates), opens it again and takes the certificate away. */
export function restartLegacy(): DatabaseSync {
  const db = database();
  v10Again(db);
  closeDatabase();
  return legacyFile(database());
}

/** What index.ts does when a session starts or resumes in 1.0.2 (retainSession): writes the session's lineage row inside an open turn. The read-time
 * judge tells a session 1.0.2 started from a legacy one by this row (replay-lineage.ts sessionLineageKnown); recordSessionRoots no longer writes it. */
export function markSessionKnown(threadId: string, driverInstance: string, nativeSession: string, botId = "bot"): void {
  const turn = openTurnLineage(database(), { threadId, turnId: memberTurnId(botId) });
  try { transaction(tx => writeSessionLineage(tx, { threadId, driverInstance, nativeSession }, turn)); } finally { closeTurnLineage(turn); }
}

/** What index.ts does around a bot's turn that was shown memory (write-time privacy, DESIGN-WRITETIME 2.2): the turn opens when its prompt is
 * built, the receipts it was given join its parents, and every line written inside `write` rests on them (mem_lsn, footprint). A test that
 * lays down a reply "made with memory" by inserting the receipt row and the line directly (the 1.0.1 fixture shape) writes the line here so the
 * line carries what the production writer gives it. `botId` is the member the lines are from. */
export function writtenWithReceipts<T>(threadId: string, botId: string, bundleIds: readonly string[], write: () => T, outputOf: (written: T) => string | readonly string[] = () => []): T {
  const turn = openTurnLineage(database(), { threadId, turnId: memberTurnId(botId) });
  let written: T;
  try {
    const refs = bundleIds.map(id => receiptLineageRef(database(), id)).filter((ref): ref is NonNullable<typeof ref> => ref !== null);
    addTurnParents(turn, refs);
    written = write();
  } finally { closeTurnLineage(turn); }
  // what receipt.output(messageId) does for each line the receipt produced: the output index a record's forget walks from
  const outputs = outputOf(written);
  for (const messageId of typeof outputs === "string" ? [outputs] : outputs) for (const bundleId of bundleIds) linkMemoryDisclosureOutput(bundleId, messageId);
  return written;
}
