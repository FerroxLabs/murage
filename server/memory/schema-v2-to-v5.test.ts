// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shipped 0.1.61/0.1.62 file is memory schema v2 and 0.1.63 jumps to v5. This walks that jump with the
// frozen 0.1.61 schema text and validator (testdata/v0161-schema.ts): a verified copy exists before any
// rewrite, the upgrade keeps the data, and the downgrade gives a file the 0.1.61 validator accepts.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { MEMORY_PRE_V3_SNAPSHOT, MEMORY_SCHEMA_VERSION, downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import * as shipped from "./testdata/v0161-schema.ts";

const roots: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } } for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const open = (file: string) => { const db = new DatabaseSync(file); dbs.push(db); db.exec("PRAGMA foreign_keys=ON"); return db; };

/** A real 0.1.61 installation on disk: created by the frozen 0.1.61 code, with a scope and a source row. */
function installation() {
  const root = mkdtempSync(join(tmpdir(), "murage-v2v5-")); roots.push(root);
  const file = join(root, "messages.db");
  const db = open(file);
  shipped.migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('s','conversation','t','[]',0)");
  db.exec("INSERT INTO memory_sources VALUES('src1','s','t1','m1',NULL,1,'h','message','owner','ok',NULL,'active')");
  return { root, file, db };
}
const shape = (db: DatabaseSync) => (db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'memory_%' OR tbl_name LIKE 'memory_%' ORDER BY name").all() as unknown[]);

it("a verified v2 copy exists before the file is rewritten; upgrade keeps the data; downgrade is accepted by the 0.1.61 validator", () => {
  const f = installation();
  expect(MEMORY_SCHEMA_VERSION).toBe(6);
  expect(f.db.prepare("SELECT schema_version v FROM memory_meta").get()?.v).toBe(2);
  const before = shape(f.db);
  const snapshot = join(f.root, MEMORY_PRE_V3_SNAPSHOT);
  let copyExistedAtRewrite = false;
  migrateMemorySchema(f.db, "off", { snapshotV2Path: snapshot, freeBytes: () => 1024 ** 4, onPhase: e => { if (e.phase === "migrating") copyExistedAtRewrite = existsSync(snapshot); } });
  expect(copyExistedAtRewrite).toBe(true);
  expect(f.db.prepare("SELECT schema_version v FROM memory_meta").get()?.v).toBe(6);
  expect(f.db.prepare("SELECT message_id c FROM memory_sources WHERE id='src1'").get()?.c).toBe("m1");
  const copy = open(snapshot);
  expect(shipped.validateMemorySchema(copy).size).toBeGreaterThan(0);
  expect(copy.prepare("SELECT schema_version v FROM memory_meta").get()?.v).toBe(2);
  expect(copy.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  expect(shape(copy)).toEqual(before);
  // back down to the shipped version
  expect(downgradeMemorySchema(f.db, 2)).toEqual({ status: "downgraded", from: 6, to: 2 });
  expect(shipped.validateMemorySchema(f.db).size).toBeGreaterThan(0);
  expect(shape(f.db)).toEqual(before);
  expect(f.db.prepare("SELECT message_id c FROM memory_sources WHERE id='src1'").get()?.c).toBe("m1");
  // and forward again
  migrateMemorySchema(f.db, "off", { snapshotV2Path: join(f.root, "again.db"), freeBytes: () => 1024 ** 4 });
  validateMemorySchema(f.db);
  expect(f.db.prepare("SELECT schema_version v FROM memory_meta").get()?.v).toBe(6);
});

it("a copy that is not a readable v2 file stops the upgrade before any rewrite", () => {
  const f = installation();
  const snapshot = join(f.root, MEMORY_PRE_V3_SNAPSHOT);
  expect(() => migrateMemorySchema(f.db, "off", { snapshotV2Path: snapshot, freeBytes: () => 1024 ** 4, copy: (_db, target) => writeFileSync(target, "not a database") })).toThrow(/MEMORY_SCHEMA_SNAPSHOT_FAILED/);
  expect(existsSync(snapshot)).toBe(false);
  expect(f.db.prepare("SELECT schema_version v FROM memory_meta").get()?.v).toBe(2);
});

it("an old copy left by an earlier attempt is checked too, not trusted", () => {
  const f = installation();
  const snapshot = join(f.root, MEMORY_PRE_V3_SNAPSHOT);
  writeFileSync(snapshot, "garbage");
  expect(() => migrateMemorySchema(f.db, "off", { snapshotV2Path: snapshot, freeBytes: () => 1024 ** 4 })).toThrow(/MEMORY_SCHEMA_SNAPSHOT_FAILED/);
  expect(f.db.prepare("SELECT schema_version v FROM memory_meta").get()?.v).toBe(2);
});
