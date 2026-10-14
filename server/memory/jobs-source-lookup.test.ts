// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc3f P2 #2: the capture's lookup of a source's open jobs is a seek (the UNIQUE(source_id,source_revision,stage,stage_version) key leads with
// source_id), so a capture does the same statements and reads the same rows with 100 and with 100,000 jobs, and no memory_jobs lookup on
// the turn or capture path scans the table.
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { migrateMemorySchema } from "./schema.ts";
import { captureSource } from "./capture.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function open(jobs: number): DatabaseSync {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  db.exec("PRAGMA foreign_keys=OFF");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  db.exec("UPDATE memory_meta SET mode='active'");
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch)
    SELECT 'j'||i,'s'||i,1,'capture','1',CASE WHEN i%1000=0 THEN 'pending' ELSE 'complete' END,0,0 FROM n`).run(jobs);
  return db;
}
const LOOKUPS = [
  "UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1 WHERE source_id=? AND status NOT IN ('complete','cancelled')",
  "SELECT status FROM memory_jobs WHERE source_id=? AND source_revision=? AND stage='capture'",
  "SELECT 1 FROM memory_jobs j WHERE j.source_id=? AND j.source_revision=? AND j.stage='capture' AND j.status='complete'",
  "UPDATE memory_jobs SET error=NULL WHERE source_id=? AND +status='cancelled' AND substr(error,1,7)='parked:'",
];
it("every per-source memory_jobs lookup on the capture and turn paths is an index seek, never a scan", () => {
  const db = open(100);
  for (const sql of LOOKUPS) {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.includes("source_revision") ? ["s1", 1] : ["s1"]) as never[]) as Array<{ detail: string }>).map(row => row.detail).join(" | ");
    expect(plan, sql).toMatch(/SEARCH \w+ USING INDEX sqlite_autoindex_memory_jobs_2 \(source_id=\?/);
    expect(plan, sql).not.toMatch(/SCAN memory_jobs/);
  }
});
it("a capture runs the same statements and reads the same rows at 100 and at 100,000 jobs", () => {
  const run = (jobs: number) => {
    const db = open(jobs);
    const seen: string[] = [];
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = (sql: string) => { seen.push(sql.replace(/\s+/g, " ")); return real(sql); };
    captureSource(db, { id: "s-new", threadId: "t", kind: "message", speaker: "owner", outcome: "completed", text: "hello world" });
    expect(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE source_id='s-new'").get()?.n).toBe(1);
    const plans = LOOKUPS.map(sql => (real(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.includes("source_revision") ? ["s1", 1] : ["s1"]) as never[]) as Array<{ detail: string }>).map(row => row.detail).join("|"));
    return { seen, plans };
  };
  const small = run(100), large = run(100_000);
  expect(large.seen).toEqual(small.seen);
  expect(large.plans).toEqual(small.plans);
});
