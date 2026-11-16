// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 PIP-PERF (Astra Medium, MurageMain ruling 11-07): a source version with no stamp under a pending window is bounded by the floor of
// the source stamps, min(created_lsn) of memory_source_lsn (deny-read.ts sourceUnstampedBound). The table's key is (source_id,revision), so
// that read visited every stamp. The registered optional index memory_source_lsn_created (schema.ts SOURCE_LSN_FLOOR_INDEX) makes it one
// seek. Proven here on a 1.0.17-shaped v13 file that already holds stamps: the plan seeks the index, the work is the same at 1k and 1M
// stamps, the build is idempotent and keeps the file valid, the floor is unchanged, and the downgrade takes the index away.
// node:sqlite has no sqlite3_stmt_status (testing/sql-work.ts), so the flat proof is the plan plus statements and rows; the VM-step count at
// 1k vs 1M is measured outside vitest (FIX-LEDGER PIP-PERF index row).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SOURCE_FLOOR_SQL, sourceUnstampedBound } from "./deny-read.ts";
import { buildPreListenIndexes, REQUIRED_INDEXES, OPTIONAL_INDEXES, optionalIndexReady } from "./optional-index.ts";
import { downgradeMemorySchema, MEMORY_SCHEMA_VERSION, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { sqlWork } from "./testing/sql-work.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

// literal on purpose: the same text on the base commit, where the index and its constant do not exist yet
const INDEX = "memory_source_lsn_created";
const FLOOR = "SELECT min(created_lsn) AS m FROM memory_source_lsn";
const dirs: string[] = [], dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) try { db.close(); } catch { /* closed */ } for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

/** A v13 file as 1.0.17 leaves it: migrated, no floor index, `stamps` source stamps already in it (ids in a scrambled order, so the key
 *  order is not the lsn order), the lowest created lsn 1001. */
function file17(stamps: number): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "srcfloor-")); dirs.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  db.prepare(`INSERT INTO memory_source_lsn(source_id,revision,created_lsn) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    SELECT printf('s%07d',(i*7919)%1000003),1,1000+i FROM n`).run(stamps);
  return db;
}
const planOf = (db: DatabaseSync, sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => String(row.detail)).join(" | ");

it("a 1.0.17 file with stamps gets the floor index before listen, once; the floor read then seeks it; the file stays valid", () => {
  const db = file17(5000);
  expect(() => validateMemorySchema(db, { structuralOnly: true })).not.toThrow();
  const before = Number((db.prepare(FLOOR).get() as { m: number }).m);
  expect(planOf(db, FLOOR)).not.toMatch(new RegExp(INDEX)); // the old read: every stamp, in key order (4,000,010 VM steps at 1M stamps)
  expect(buildPreListenIndexes(db, { log: false })).toContain(INDEX);
  expect(optionalIndexReady(db, INDEX)).toBe(true);
  expect(buildPreListenIndexes(db, { log: false })).not.toContain(INDEX); // idempotent: the next launch finds it
  expect(() => validateMemorySchema(db, { structuralOnly: true })).not.toThrow();
  expect(() => validateMemorySchema(db)).not.toThrow();
  const plan = planOf(db, FLOOR);
  expect(plan).toMatch(new RegExp(`SEARCH memory_source_lsn USING COVERING INDEX ${INDEX}`));
  expect(plan).not.toMatch(/\bSCAN\b/);
  expect(Number((db.prepare(FLOOR).get() as { m: number }).m)).toBe(before);
  expect(before).toBe(1001);
});

it("the product's floor read is that statement, and its work is the same at 1k and 1M stamps (cold handle each time)", () => {
  expect(SOURCE_FLOOR_SQL).toBe(FLOOR);
  const measure = (stamps: number) => {
    const db = file17(stamps);
    buildPreListenIndexes(db, { log: false });
    expect(planOf(db, SOURCE_FLOOR_SQL)).toMatch(new RegExp(`SEARCH memory_source_lsn USING COVERING INDEX ${INDEX}`));
    const { result, work } = sqlWork(db, () => sourceUnstampedBound(db));
    // a second read on the same handle is served by the per-handle floor (no floor statement at all)
    const again = sqlWork(db, () => sourceUnstampedBound(db));
    return { floor: result, statements: work.statements, returned: work.returned, sqls: [...work.sqls.keys()].sort(), again: again.work.sqls.has(SOURCE_FLOOR_SQL) };
  };
  const small = measure(1000), large = measure(1_000_000);
  expect(small.floor).toBe(1001);
  expect(large.floor).toBe(1001);
  expect(large.statements).toBe(small.statements);
  expect(large.returned).toBe(small.returned);
  expect(large.sqls).toEqual(small.sqls);
  expect(small.sqls).toContain(SOURCE_FLOOR_SQL);
  expect(large.again).toBe(false);
}, 180_000);

it("the downgrade to v12 takes the index with the stamps; the next v13 open is valid without it and the pre-listen build makes it again", () => {
  const db = file17(200);
  buildPreListenIndexes(db, { log: false });
  expect(optionalIndexReady(db, INDEX)).toBe(true);
  expect(downgradeMemorySchema(db, 12)).toMatchObject({ status: "downgraded", from: MEMORY_SCHEMA_VERSION, to: 12 });
  expect(optionalIndexReady(db, INDEX)).toBe(false);
  expect(() => validateMemorySchema(db)).not.toThrow();
  // the pre-listen build skips a file below v13 (no stamps table to index)
  expect(buildPreListenIndexes(db, { log: false })).not.toContain(INDEX);
  migrateMemorySchema(db, "active");
  expect(optionalIndexReady(db, INDEX)).toBe(false);
  expect(() => validateMemorySchema(db)).not.toThrow();
  expect(buildPreListenIndexes(db, { log: false })).toContain(INDEX);
  expect(() => validateMemorySchema(db)).not.toThrow();
});

it("the step back to 1.0.17 (--to 13) takes only the floor index, in one step, and keeps every stamp; the next pre-listen build makes it again", () => {
  const db = file17(5000);
  expect(db.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type='table' AND name='memory_thread_flow_last'").get()).toEqual({ ok: 1 }); // a v13 table the step to 12 would take; this step keeps it
  const tables = () => (db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type<>'index' AND name<>'memory_capture_deferred' ORDER BY name").all() as Array<Record<string, unknown>>).map(row => JSON.stringify(row));
  const stamps = () => db.prepare("SELECT count(*) AS n, min(created_lsn) AS lo, sum(created_lsn) AS sum FROM memory_source_lsn").get();
  expect(buildPreListenIndexes(db, { log: false })).toContain(INDEX);
  const known117 = new Set(["memory_disclosures_live", "memory_records_pinned", "memory_records_canon", "memory_details_identity", "memory_records_waiting_review", "memory_bindings_scope"]);
  const newerIndexes = new Set(["memory_capture_deferred_order", ...[...REQUIRED_INDEXES,...OPTIONAL_INDEXES].filter(index=>index.table.startsWith('memory_')&&!known117.has(index.name)).map(index=>index.name)]);
  const before = { tables: tables(), stamps: stamps(), indexes: (db.prepare("SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name).filter(name=>!newerIndexes.has(name)) };
  expect(before.stamps).toMatchObject({ n: 5000, lo: 1001 });
  expect(downgradeMemorySchema(db, 13)).toMatchObject({ status: "downgraded", from: MEMORY_SCHEMA_VERSION, to: 13 });
  expect(optionalIndexReady(db, INDEX)).toBe(false);
  expect(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()).toEqual({ schema_version: 13 });
  // every stamp and the flow table stay, whichever version the file came from
  expect(stamps()).toEqual(before.stamps);
  expect(db.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type='table' AND name='memory_thread_flow_last'").get()).toEqual({ ok: 1 });
  // The derived capture queue and indexes unknown to 1.0.17 leave. Every authoritative table, trigger and older index stays. A newer tree reaches 13
  // through its own step, which takes that version's own objects as well.
  if (MEMORY_SCHEMA_VERSION === 13) {
    expect(tables()).toEqual(before.tables);
    expect((db.prepare("SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)).toEqual(before.indexes);
  }
  // no 1.0.18 optional index on a memory table is left for 1.0.17's validator to refuse
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_capture_deferred'").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_capture_deferred_order'").get()).toBeUndefined();
  for (const index of [...REQUIRED_INDEXES,...OPTIONAL_INDEXES]) if (index.table.startsWith("memory_") && !known117.has(index.name)) expect(optionalIndexReady(db, index.name)).toBe(false);
  expect(() => validateMemorySchema(db)).not.toThrow();
  expect(downgradeMemorySchema(db, 13)).toMatchObject({ status: "already-v13", from: 13, to: 13 });
  // the next 1.0.18 start: the build makes it again before listen, over the same stamps, and the floor is unchanged
  migrateMemorySchema(db, "active");
  expect(buildPreListenIndexes(db, { log: false })).toContain(INDEX);
  expect(Number((db.prepare(FLOOR).get() as { m: number }).m)).toBe(1001);
  expect(stamps()).toEqual(before.stamps);
  expect(() => validateMemorySchema(db)).not.toThrow();
});
