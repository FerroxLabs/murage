// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A real-sized file goes down a schema step and up again: no chat message and no memory row of the owner's is lost, and the
// downgrade validates a file whose message-line triggers or root sets are not there (never made, or handed back).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { storm } from "./testing/revoke-storm-fixture.ts";
import type { WritetimeFixture } from "./testing/writetime-fixture.ts";

const KEPT = ["messages", "memory_scopes", "memory_records", "memory_sources", "memory_disclosures", "memory_tombstones", "memory_line_lineage", "memory_thread_no", "memory_lsn"];
const count = (db: DatabaseSync, table: string): number => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
const pathOf = (db: DatabaseSync) => String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);
const has = (db: DatabaseSync, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
const snapshot = (db: DatabaseSync) => Object.fromEntries(KEPT.filter(t => has(db, t)).map(t => [t, count(db, t)]));

let fixture: WritetimeFixture | undefined;
afterEach(() => { fixture?.close(); fixture = undefined; });

/** 200,000 chat lines over a few threads, beside the storm fixture's receipts, records and sources. */
function realShapes(fx: WritetimeFixture): WritetimeFixture {
  // the shapes a real file has (the step down validates the file first)
  fx.db.exec("UPDATE memory_scopes SET audience='[]'; UPDATE memory_records SET assertion='owner-statement'");
  fx.db.exec("INSERT OR IGNORE INTO memory_record_details(record_id,record_version,partition,attention,claim_status) SELECT id,version,'semantic','current','current' FROM memory_records");
  return fx;
}
function realSized(): WritetimeFixture {
  const fx = realShapes(storm(500));
  fx.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200000)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'bulk-'||(i%8),'m'||i,i,CASE WHEN i%2 THEN 'user' ELSE 'bot' END,'text','line '||i,'{"id":"m'||i||'"}' FROM n`);
  return fx;
}

describe("a downgrade and the next upgrade keep every row", () => {
  for (const to of [10, 9] as const) {
    it(`v13 -> v${to} -> v13 on a file of 200,000 lines`, () => {
      fixture = realSized();
      const path = pathOf(fixture.db);
      const before = snapshot(fixture.db);
      expect(before.messages).toBeGreaterThanOrEqual(200_000);
      fixture.db.close();
      const down = new DatabaseSync(path);
      try {
        expect(downgradeMemorySchema(down, to).status).toBe("downgraded");
        expect(() => validateMemorySchema(down)).not.toThrow();
        const mid = snapshot(down);
        for (const table of ["messages", "memory_scopes", "memory_records", "memory_sources", "memory_disclosures"]) expect(mid[table], table).toBe(before[table]);
      } finally { down.close(); }
      const up = new DatabaseSync(path);
      try {
        migrateMemorySchema(up, "active");
        expect(() => validateMemorySchema(up)).not.toThrow();
        const after = snapshot(up);
        for (const table of ["messages", "memory_scopes", "memory_records", "memory_sources", "memory_disclosures", "memory_tombstones"]) expect(after[table], table).toBe(before[table]);
      } finally { up.close(); }
      fixture = undefined;
    }, 120_000);
  }

  it("validates and downgrades a file whose root sets were handed back and whose message-line triggers were never made", () => {
    fixture = realShapes(storm(20));
    const db = fixture.db;
    db.exec("DROP TRIGGER IF EXISTS memory_session_proof_line_update; DROP TRIGGER IF EXISTS memory_session_proof_line_delete; DROP TABLE IF EXISTS memory_session_roots");
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(downgradeMemorySchema(db, 10).status).toBe("downgraded");
  });

  it("still refuses a proof set with a gap that is not a whole pair of an absent table", () => {
    fixture = storm(20);
    fixture.db.exec("DROP TRIGGER memory_session_proof_source");
    expect(() => validateMemorySchema(fixture!.db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  });
});
