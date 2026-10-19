// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Three causes of the loop stalls seen in the real-data test, each pinned: the delivered-receipt figure no longer walks the receipts, the identity
// set follows another connection's commits by the change (not by a pass over every record), and a statement or exec that holds the loop is
// filed under its route or its own label instead of "unattributed".
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { instrumentDatabase, IoBudget, routeSource } from "../io-budget.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { memoryHealth, SUPPLIED_SMALL_ROWS } from "./health.ts";
import { ensureIdentityIndexes, identityRefreshCount, identityScanCount, identitySourceSet } from "./provenance-stamp.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { setObserveSink, startLoopStallWatch, stopLoopStallWatch } from "../observe.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
// closeDatabase stops the WAL checkpointer without waiting: one still alive when the data dir is rebuilt removes the NEW file's -wal/-shm by
// path and the previous run's rows resurface (UNIQUE bundle_id). The checkpointer is awaited after every close.
async function fresh() {
  closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
}
beforeEach(fresh);

type Seen = { sql: string; rows: number };
function record(action: () => unknown, db = database()): Seen[] {
  const seen: Seen[] = [], original = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = original(sql), entry: Seen = { sql, rows: 0 };
    seen.push(entry);
    return new Proxy(statement, { get(target, key) {
      const value = (target as never)[key] as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (key === "all") entry.rows += (out as unknown[]).length;
        else if (key === "get") entry.rows += out ? 1 : 0;
        return out;
      };
    } });
  };
  try { action(); } finally { (db as unknown as { prepare: unknown }).prepare = original; }
  return seen;
}

function fillReceipts(n: number): void {
  const db = database();
  db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_disclosures (bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'b-'||n,'thread-a','d',NULL,'[["r",1],["s",2]]','[]',0,0,5,'delivered',n FROM c`).run(n);
  db.exec("COMMIT");
}

it("the delivered-receipt figure reads the same rows with 10 and with 100,000 receipts, and never the whole table past the small-store bound", async () => {
  const reads: number[] = [];
  for (const n of [10, 100_000]) {
    await fresh(); fillReceipts(n);
    const seen = record(() => memoryHealth(null));
    const ofReceipts = seen.filter(item => /memory_disclosures/.test(item.sql));
    reads.push(ofReceipts.reduce((sum, item) => sum + item.rows, 0));
    const aggregate = ofReceipts.some(item => /json_array_length\(record_versions\)>0/.test(item.sql) && !/rowid>\?/.test(item.sql));
    expect(aggregate).toBe(n <= SUPPLIED_SMALL_ROWS);
  }
  expect(reads[1]).toBeLessThanOrEqual(reads[0] + 2);
  await fresh(); fillReceipts(SUPPLIED_SMALL_ROWS - 1);
  expect(memoryHealth(null).supplied).toMatchObject({ turns: SUPPLIED_SMALL_ROWS - 1 });
});

function fillRecords(n: number): void {
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_records
    SELECT 'h-'||n,1,?,'fact','x','owner-statement','active',0,1,NULL,NULL,n FROM c`).run(n, scope);
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT OR REPLACE INTO memory_record_details(record_id,record_version,partition,attention,claim_status)
    SELECT 'h-'||n,1,'semantic','current','current' FROM c`).run(n);
  db.prepare("INSERT INTO memory_records VALUES('canon',1,?,'character-canon','c','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  db.prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id='canon'").run();
  db.prepare("INSERT INTO memory_evidence VALUES('canon',1,'source:a',1,0,1)").run();
  db.exec("COMMIT");
}
const commitElsewhere = (sql: string) => { const other = new DatabaseSync(join(DATA_DIR, "messages.db")); try { other.exec("PRAGMA foreign_keys=OFF"); other.exec(sql); } finally { other.close(); } };

it("another connection's commit refreshes the identity set by the change: the same statements and rows with 10 and with 100,000 records", async () => {
  const costs: unknown[] = [];
  for (const n of [10, 100_000]) {
    await fresh(); fillRecords(n);
    const db = database();
    void ensureIdentityIndexes(db, { inline: true }); // runs at once on this connection (a test only: production builds off-thread)
    expect([...identitySourceSet(db)]).toEqual(["source:a:1"]);
    const scans = identityScanCount(), refreshes = identityRefreshCount();
    commitElsewhere("INSERT INTO memory_records SELECT 'later',1,scope_id,'fact','x','owner-statement','active',0,1,NULL,NULL,1 FROM memory_records WHERE id='canon'");
    const seen = record(() => expect([...identitySourceSet(db)]).toEqual(["source:a:1"]));
    expect(identityScanCount()).toBe(scans);
    expect(identityRefreshCount()).toBe(refreshes + 1);
    for (const entry of seen.filter(item => /memory_records|memory_evidence/.test(item.sql) && /^\s*(WITH|SELECT)/i.test(item.sql) && !/max\(rowid\)/.test(item.sql))) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...(entry.sql.match(/\?/g) ?? []).map(() => 0)) as Array<{ detail: string }>).map(row => row.detail);
      expect(plan.some(line => /^SCAN (r|e|memory_records|memory_evidence)\b(?! USING)/.test(line)), `${entry.sql} :: ${plan.join(" | ")}`).toBe(false);
    }
    costs.push(seen.map(item => [item.sql, item.rows]));
  }
  expect(costs[1]).toEqual(costs[0]);
});

it("the refreshed set follows what another connection added and removed", () => {
  fillRecords(50);
  const db = database();
  identitySourceSet(db);
  commitElsewhere(`INSERT INTO memory_evidence VALUES('canon',1,'source:b',1,0,1);
    INSERT INTO memory_records SELECT 'canon2',1,scope_id,'character-canon','c','owner-statement','active',0,1,NULL,NULL,1 FROM memory_records WHERE id='canon';
    INSERT INTO memory_evidence VALUES('canon2',1,'source:c',1,0,1)`);
  expect([...identitySourceSet(db)].sort()).toEqual(["source:a:1", "source:b:1", "source:c:1"]);
  commitElsewhere("DELETE FROM memory_evidence WHERE source_id='source:a'");
  expect([...identitySourceSet(db)].sort()).toEqual(["source:b:1", "source:c:1"]);
  commitElsewhere("UPDATE memory_records SET kind='fact' WHERE id IN ('canon','canon2'); UPDATE memory_record_details SET partition='semantic' WHERE record_id='canon'");
  expect([...identitySourceSet(db)]).toEqual([]);
});

it("a stall during a route's statement is filed under the route, and a long db.exec under its own label", async () => {
  expect(routeSource("GET", "/api/memory/status?x=1")).toBe("route:GET /api/memory/status");
  expect(routeSource("POST", "/api/bots/bot-12345/messages")).toBe("route:POST /api/bots/:id/messages");
  const lines: string[] = [];
  setObserveSink(line => lines.push(line));
  const budget = new IoBudget();
  const db = new DatabaseSync(":memory:");
  const restore = instrumentDatabase(db, budget);
  try {
    startLoopStallWatch(150, 20);
    await new Promise(resolve => setTimeout(resolve, 60));
    const slow = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<3000000) SELECT count(*) FROM c";
    budget.withSource(routeSource("GET", "/api/memory/status"), () => { db.prepare(slow).get(); });
    await new Promise(resolve => setTimeout(resolve, 60));
    db.exec(`CREATE TABLE t(n); WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<3000000) INSERT INTO t SELECT n FROM c`);
    await new Promise(resolve => setTimeout(resolve, 60));
  } finally { restore(); db.close(); stopLoopStallWatch(); setObserveSink(); }
  const stalls = lines.filter(line => line.startsWith("[loop] stall"));
  expect(stalls.length).toBe(2);
  expect(stalls[0]).toMatch(/holder=sqlite:route:GET \/api\/memory\/status:/);
  expect(stalls[1]).toMatch(/holder=sqlite:exec:CREATE TABLE t/);
  expect(stalls.join("\n")).not.toMatch(/unattributed/);
});
