// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW 1.13 / OPEN-5 (MurageMain: drop on downgrade): index_overrun is a 1.0.18 table in messages.db. A restore of a 1.0.18 archive accepts
// it; "Prepare to reinstall" drops it, whatever the target, so the file 1.0.17 opens has no object 1.0.17 does not know; and an upgrade
// back to 1.0.18 finds no row, which reads as an unknown history: the first stop the helper reports again resets at once with the most
// conservative k (multiplier 8), never as "no overruns".
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { inspectInstallationDatabase } from "../installation-database-snapshot.ts";
import { downgradeInstallationMemorySchema } from "../installation-memory-downgrade.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { OVERRUN_K_UNKNOWN, resetMultiplier } from "./memw-steps.ts";
import { INDEX_OVERRUN_TABLE, ensureIndexOverrun } from "./schema.ts";
import { completeIndexReset, indexResetDue, indexResetPending, noteIndexStop } from "./worker-controller.ts";

const D = 24 * 3_600_000;
const file = () => join(DATA_DIR, "messages.db");
const hasTable = (db: DatabaseSync) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(INDEX_OVERRUN_TABLE));
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

/** A 1.0.18 file with a known overrun history: one stop, its reset complete, more than 7 days ago (kept, the next stop would be k = 1). */
async function file118(now: number) {
  ensureIndexOverrun(database());
  database().prepare(`INSERT INTO ${INDEX_OVERRUN_TABLE}(id,resets,reset_id,state,due_at,kind,stop_file_id,stop_seq,last_stop_at) VALUES(1,1,7,'complete',?,'fill','f0',1,?)`).run(now - 8 * D, now - 8 * D);
  closeDatabase();
  await stopWalMaintenance();
}

it("restore: a 1.0.18 archive with the overrun row is accepted", async () => {
  await file118(Date.now());
  const archive = join(DATA_DIR, "archive.db");
  const live = new DatabaseSync(file());
  try { live.exec(`VACUUM INTO '${archive}'`); } finally { live.close(); }
  const db = new DatabaseSync(archive);
  try {
    // At 1effcd533 the inspector refuses any 1.0.18 start's file for the speech_* tables it does not list yet (the same refusal fails
    // added-table-lifecycle.test.ts "an archive written before the cascade" on the base): they leave the copy, so only index_overrun is tested.
    const speech = db.prepare("SELECT type,name FROM sqlite_schema WHERE name LIKE 'speech\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' ORDER BY type='table'").all() as Array<{ type: string; name: string }>;
    for (const { type, name } of speech) db.exec(`DROP ${type === "table" ? "TABLE" : type === "index" ? "INDEX" : "TRIGGER"} IF EXISTS "${name}"`);
    expect(hasTable(db)).toBe(true);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
  } finally { db.close(); }
});

it("1.0.18 -> 1.0.17 -> 1.0.18: the downgrade drops the table (1.0.17 opens a file with no object it does not know), and the first reset after the re-upgrade starts conservative", async () => {
  const now = Date.parse("2026-11-08T00:00:00Z");
  await file118(now);
  expect(await downgradeInstallationMemorySchema(DATA_DIR, 12)).toMatchObject({ status: "downgraded", to: 12 });
  const old = new DatabaseSync(file(), { readOnly: true });
  try { expect(hasTable(old)).toBe(false); expect(old.prepare("SELECT name FROM sqlite_schema WHERE tbl_name=?").all(INDEX_OVERRUN_TABLE)).toEqual([]); } finally { old.close(); }
  // a second run changes nothing
  expect(await downgradeInstallationMemorySchema(DATA_DIR, 12)).toMatchObject({ to: 12 });
  // the 1.0.18 start again: no row, so no reset is formed until the helper reports its durable stop (the -walstop survives in the index file)
  database();
  expect(indexResetDue(now)).toBeNull();
  expect(indexResetPending()).toBe(false);
  expect(noteIndexStop({ fileId: "f0", seq: 1, kind: "fill" }, now)).toBe(true);
  const request = indexResetDue(now)!;
  expect(request).not.toBeNull();
  // unknown history: k = OVERRUN_K_UNKNOWN, so the rebuilt index's first fill runs at the largest multiplier, and the reset is not delayed
  expect(request.resets).toBe(OVERRUN_K_UNKNOWN);
  expect(resetMultiplier(request.resets)).toBe(8);
  expect(Number((database().prepare(`SELECT due_at FROM ${INDEX_OVERRUN_TABLE} WHERE id=1`).get() as { due_at: number }).due_at)).toBe(now);
  expect(completeIndexReset(request.resetId)).toBe("done");
});
