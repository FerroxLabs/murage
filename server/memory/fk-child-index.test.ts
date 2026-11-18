// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.19 R12 T4 (MAIN ruling 2026-11-17T00:49Z): an insert into memory_scopes plans a check of every table that references it. Without a
// child-key index that check is a SCAN of memory_sources / memory_scope_bindings (deny.ts noteThreadDeletion, revoke-window T4). A new file
// makes both indexes with its empty tables; a file that lacks them gets them before listen; validation accepts the file either way and a
// downgrade takes them away.
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { buildPreListenIndexes, optionalIndexReady } from "./optional-index.ts";
import { BINDINGS_SCOPE_INDEX, downgradeMemorySchema, FK_CHILD_INDEXES, migrateMemorySchema, SOURCES_SCOPE_INDEX, validateMemorySchema } from "./schema.ts";
import { fullScans } from "./testing/sql-work.ts";

const INSERT_SCOPE = "INSERT OR IGNORE INTO memory_scopes VALUES(?,'workspace','system:thread-deletion-clock','[]',0)";
const plan = (db: DatabaseSync, sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("s") as Array<{ detail: string }>).map(row => String(row.detail));
const fresh = () => { const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON"); migrateMemorySchema(db, "active"); return db; };

it("covers every table that references memory_scopes(id)", () => {
  const db = fresh();
  try {
    const children = (db.prepare("SELECT m.name AS tbl, f.\"from\" AS col FROM sqlite_schema m, pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f.\"table\"='memory_scopes' ORDER BY 1").all() as Array<{ tbl: string; col: string }>);
    expect(children.map(child => child.tbl)).toEqual(["memory_records", "memory_scope_bindings", "memory_sources"]);
    // each child column leads some index (memory_records: memory_records_scope)
    for (const { tbl, col } of children) {
      const led = (db.prepare("SELECT il.name FROM pragma_index_list(?) il WHERE (SELECT ii.name FROM pragma_index_info(il.name) ii WHERE ii.seqno=0)=?").all(tbl, col) as Array<{ name: string }>);
      expect(led.length, tbl).toBeGreaterThan(0);
    }
  } finally { db.close(); }
});

it("a new file's scope insert checks its child tables by index, not by scan", () => {
  const db = fresh();
  try {
    for (const index of FK_CHILD_INDEXES) expect(optionalIndexReady(db, index.name)).toBe(true);
    const detail = plan(db, INSERT_SCOPE);
    expect(detail.filter(line => /^SCAN memory_(sources|scope_bindings)\b/.test(line))).toEqual([]);
    expect(detail.some(line => line.includes(SOURCES_SCOPE_INDEX))).toBe(true);
    expect(detail.some(line => line.includes(BINDINGS_SCOPE_INDEX))).toBe(true);
    expect(fullScans(db, [INSERT_SCOPE]).scans).toEqual([]);
    expect(() => validateMemorySchema(db, { structuralOnly: true })).not.toThrow();
  } finally { db.close(); }
});

it("a file without them scans until the pre-listen build makes them; validation accepts both; a downgrade takes them", () => {
  const db = fresh();
  try {
    for (const index of FK_CHILD_INDEXES) db.exec(`DROP INDEX ${index.name}`);
    expect(() => validateMemorySchema(db, { structuralOnly: true })).not.toThrow();
    expect(plan(db, INSERT_SCOPE).filter(line => /^SCAN memory_(sources|scope_bindings)\b/.test(line)).sort()).toEqual(["SCAN memory_scope_bindings", "SCAN memory_sources"]);
    expect(buildPreListenIndexes(db, { log: false })).toEqual(expect.arrayContaining(FK_CHILD_INDEXES.map(index => index.name)));
    expect(plan(db, INSERT_SCOPE).filter(line => /^SCAN memory_(sources|scope_bindings)\b/.test(line))).toEqual([]);
    expect(() => validateMemorySchema(db, { structuralOnly: true })).not.toThrow();
    // the next launch finds them: nothing is built again
    expect(buildPreListenIndexes(db, { log: false })).not.toEqual(expect.arrayContaining([SOURCES_SCOPE_INDEX]));
    downgradeMemorySchema(db, 1);
    for (const index of FK_CHILD_INDEXES) expect(optionalIndexReady(db, index.name)).toBe(false);
  } finally { db.close(); }
});
