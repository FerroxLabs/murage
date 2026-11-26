// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane I (W-COMPAT, MEMORY-V2-DESIGN 3.5 and gate G-COMPAT). Every V2 path lane I owns runs on the fixture (migration to
// the end, retention, a turn, an import, a forget); then (1) every sqlite_schema row is text-equal to the row before V2 ran;
// (2) the untouched file passes validateMemorySchema and inspectInstallationDatabase (schema.ts and the snapshot inspector are
// byte-identical to f6ae52c670 on this branch); (3) a VACUUM INTO copy (the snapshot shape) passes the inspector; (4) a reopen
// through this build's open path serves the file and still refuses the forgotten notebook. (4) with the f6ae52c670 BUILD's own modules:
// compat-v2-oldbuild.test.ts. Vendoring the 1.0.19 and 1.0.20
// validators: server/memory/schema.ts and server/installation-database-snapshot.ts are byte-identical at tag v1.0.20, at f6ae52c670 and
// on this branch (md5 3249cb89 / 56cd58c9), so the ones run here ARE the vendored 1.0.20 and base ones; no 1.0.19 tag exists in the hub.
// (3, second test) the real backup archive, restore preparation, review/activation and installation downgrade entry points.
// RED on f6ae52c670: the runner (migration-v2.ts) does not exist.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { activateInstallation, reviewInstallation } from "../installation-activation.ts";
import { writeInstallationArchive } from "../installation-archive.ts";
import { inspectInstallationDatabase, snapshotInstallationDatabase } from "../installation-database-snapshot.ts";
import { isInboxProjectionObject } from "../inbox.ts";
import { downgradeInstallationMemorySchema } from "../installation-memory-downgrade.ts";
import { restoreInstallation } from "../installation-restore.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { migrationV2Progress, resetMigrationV2ForTests, runMigrationSlice } from "./migration-v2.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { validateMemorySchema } from "./schema.ts";
import { runRevocationJobsNow } from "./memory-revocation.ts";
import { captureTurn, fixtureRoster, importNotebook, notebookLine, schemaRows } from "./testing/memv2-retention-fixture.ts";

const DAY = 24 * 60 * 60 * 1000, T0 = Date.parse("2026-09-01T00:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(fixtureRoster); database().exec("UPDATE memory_meta SET mode='active'");
  resetMigrationV2ForTests();
});
afterEach(() => { vi.useRealTimers(); resetMigrationV2ForTests(); });

it("G-COMPAT: V2 migration and retention leave sqlite_schema text-equal and the file valid for the base validators and open path", async () => {
  for (let i = 0; i < 5; i++) { vi.setSystemTime(T0 + i * 60_000); importNotebook(4 + i); captureTurn(i); }
  const before = schemaRows();
  vi.setSystemTime(T0 + 8 * DAY);
  for (let n = 0; runMigrationSlice().more; n++) if (n > 1000) throw new Error("no end");
  expect(migrationV2Progress().M5).toBe("done");
  captureTurn(99); importNotebook(12);
  const source = String(database().prepare("SELECT id FROM memory_sources WHERE id LIKE 'legacy:%'").get()!.id);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: source });
  // (1) no persisted object added, dropped or edited (rule C1: TEMP objects live in sqlite_temp_schema, never here)
  expect(schemaRows()).toBe(before);
  // (2) the base validators accept the file as it is
  expect(() => validateMemorySchema(database())).not.toThrow();
  expect(() => inspectInstallationDatabase(database())).not.toThrow();
  // (3) the snapshot copy
  const copy = join(DATA_DIR, "compat-copy.db");
  database().exec(`VACUUM INTO '${copy}'`);
  const snapshot = new DatabaseSync(copy);
  try { expect(() => inspectInstallationDatabase(snapshot)).not.toThrow(); expect(schemaRows(snapshot)).toBe(before); }
  finally { snapshot.close(); }
  // (3b) the real backup entry point (snapshotInstallationDatabase: offline installation, its own copy and inspection). The backup
  // leaves the Inbox projection out of its copy before its first delete (derived data every restore drops and rebuilds): every
  // other object is text-equal, and the projection the source holds is not in the copy.
  const outsideProjection = JSON.stringify((JSON.parse(before) as Array<{ type: string; name: string; tbl_name: string }>).filter(row => !isInboxProjectionObject(row)));
  expect(outsideProjection).not.toBe(before);
  closeDatabase(); resetMigrationV2ForTests();
  const backup = join(DATA_DIR, "..", `compat-backup-${process.pid}.db`);
  await snapshotInstallationDatabase(DATA_DIR, backup);
  const restored = new DatabaseSync(backup);
  try { expect(() => inspectInstallationDatabase(restored)).not.toThrow(); expect(() => validateMemorySchema(restored)).not.toThrow(); expect(schemaRows(restored)).toBe(outsideProjection); }
  finally { restored.close(); rmSync(backup, { force: true }); }
  // (4) a restart through the open path: the marker rows are ignored, the forgotten notebook stays refused
  closeDatabase(); resetMigrationV2ForTests();
  const db = database();
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_records WHERE state IN ('active','candidate') AND text LIKE ?").get(`%${notebookLine(0).slice(0, 20)}%`)!.n)).toBe(0);
  expect(() => importNotebook(4)).toThrow(/MEMORY_IMPORT_FOR/);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id LIKE 'memory-v2:%' AND subject_type='system' AND subject_id='memory-v2'").get()!.n)).toBeGreaterThan(0);
});

const memorySchemaRows = (file: string | DatabaseSync) => {
  const db = typeof file === "string" ? new DatabaseSync(file, { readOnly: true }) : file;
  try { return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name LIKE 'memory%' ORDER BY type,name").all()); }
  finally { if (typeof file === "string") db.close(); }
};

/** The installation offline as the entry points require it: workers joined, the log folded. */
async function offline() {
  database().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase(); resetMigrationV2ForTests();
  await stopSearchIndex(); await stopWalMaintenance();
}

it("G-COMPAT (3): the real backup archive, restore preparation, review/activation and installation downgrade entry points accept the V2 file", async () => {
  writeFileSync(join(DATA_DIR, "config.json"), '{"profile":{"name":"Fixture"}}');
  for (let i = 0; i < 4; i++) { vi.setSystemTime(T0 + i * 60_000); importNotebook(4 + i); captureTurn(i); }
  const before = schemaRows();
  // the pre-V2 file kept aside, to compare the restored candidate's memory objects with
  const beforeFile = join(DATA_DIR, "..", `compat-before-${process.pid}.db`); rmSync(beforeFile, { force: true });
  database().exec(`VACUUM INTO '${beforeFile}'`);
  // the owner's forget comes BEFORE V2 runs, so every V2 batch (retention included) runs over its tombstone and deny rows, which the
  // restored and the downgraded file must still refuse with
  const source = String(database().prepare("SELECT id FROM memory_sources WHERE id LIKE 'legacy:%'").get()!.id);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: source }); runRevocationJobsNow(database());
  vi.setSystemTime(T0 + 8 * DAY);
  for (let n = 0; runMigrationSlice().more; n++) if (n > 1000) throw new Error("no end");
  expect(migrationV2Progress().M5).toBe("done");
  const markers = Number(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id LIKE 'memory-v2:%'").get()!.n);
  expect(markers).toBeGreaterThan(0);
  expect(schemaRows()).toBe(before);
  const tombstoneRows = "SELECT target_type,target_id,revision,content_hash FROM memory_tombstones ORDER BY 1,2,3,4";
  const tombstones = JSON.stringify(database().prepare(tombstoneRows).all());
  let restoredTombstones = "";
  await offline();
  // backup archive -> restore preparation into a new target -> review -> activation (the operator's restore path)
  const parent = join(DATA_DIR, "..", `compat-restore-${process.pid}`); rmSync(parent, { recursive: true, force: true }); mkdirSync(parent);
  try {
    const archive = join(parent, "backup.zip"), saved = await writeInstallationArchive(DATA_DIR, archive);
    const target = join(parent, "target"); mkdirSync(target);
    expect(await restoreInstallation(target, archive, saved.sha256)).toMatchObject({ status: "restored-review-required" });
    const restored = new DatabaseSync(join(target, "messages.db"), { readOnly: true });
    try {
      // restore preparation reshapes some non-memory objects of its candidate; every memory object is text-equal to before V2 ran
      expect(memorySchemaRows(restored)).toBe(memorySchemaRows(beforeFile));
      expect(() => validateMemorySchema(restored)).not.toThrow();
      expect(Number(restored.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id LIKE 'memory-v2:%'").get()!.n)).toBe(markers);
      restoredTombstones = JSON.stringify(restored.prepare(tombstoneRows).all()); // the restored candidate refuses by the same tombstones
    } finally { restored.close(); }
    const review = reviewInstallation(target);
    expect(review.status).toBe("ready-for-review");
    expect(activateInstallation(target, review.reviewHash).status).toBe("reviewed-engines-disabled");
  } finally { rmSync(parent, { recursive: true, force: true }); rmSync(beforeFile, { force: true }); }
  // the installation downgrade (to the 1.0.17 memory schema) takes the file with its marker rows; the open path then serves it
  // and the forgotten notebook stays refused
  expect(await downgradeInstallationMemorySchema(DATA_DIR, 13)).toMatchObject({ status: "downgraded" });
  const db = database();
  expect(() => validateMemorySchema(db)).not.toThrow();
  expect(() => importNotebook(4)).toThrow(/MEMORY_IMPORT_FOR/);
  expect([restoredTombstones, JSON.parse(tombstones).length > 0]).toEqual([tombstones, true]);
});

