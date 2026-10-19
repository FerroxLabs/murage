// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RC7 branch B (RC6-SPEED-DIAG.md 2c, 2d, 2f, 3): the background upgrade work is bounded by what one statement may cost, and its progress moves.
// These tests count statements and rows, never wall time: the cost of each step is flat in the size of the data, and the progress is monotonic.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgottenTextsAll, forgottenTextsReader, FORGOTTEN_PAGE_TOMBSTONES } from "../harness/event-log.ts";
import { stepIntegrityPass, INTEGRITY_SHAPE_SLICE, adaptWindow, adaptiveWindow } from "./integrity-pass.ts";
import { beginIntegrityPass, writeIntegrityPass } from "./integrity-state.ts";
import { MEMORY_CLAIM_SQL, CLAIM_WINDOW } from "./jobs.ts";
import { enqueueNode, markerSlice, upgradeMarkerWalked } from "./revoke-marker.ts";
import { openBulkRevoke } from "./revoke-commit.ts";
import { upgradeMarkerWork } from "./lineage-backfill.ts";
import { BACKGROUND_SEED_RETRY_MAX_MS } from "./upgrade-background.ts";
import { migrateMemorySchema } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dirs: string[] = [], dbs: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});
function fresh(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "murage-rc7bg-")); dirs.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
  migrateMemorySchema(db, "active");
  return db;
}

describe("2c: the integrity checks size their window to measured time", () => {
  /** Runs the shapes phase's first check (memory_scopes.audience) over a table whose newest rowid is far past any window, and returns the rows each statement covered. */
  function windows(costMs: number, slices: number): number[] {
    const db = fresh();
    db.exec("INSERT INTO memory_scopes(rowid,id,kind,owner_key,audience,revision) VALUES(100000,'z','bot','o','[]',0)");
    beginIntegrityPass(db);
    writeIntegrityPass(db, { phase: "shapes", cursor: null });
    const clock = { t: 0 }, seen: number[] = [];
    const real = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = real.call(this, sql);
      if (!/FROM memory_scopes WHERE rowid>\? AND rowid<=\?/.test(sql)) return statement;
      const get = statement.get.bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as { get: (...args: unknown[]) => unknown }).get = (...args) => { seen.push(Number(args[1]) - Number(args[0])); clock.t += costMs; return get(...args); };
      return statement;
    } as typeof real);
    for (let i = 0; i < slices; i++) stepIntegrityPass(db, { budgetMs: 0, now: () => clock.t });
    return seen;
  }

  it("a statement that runs 100 ms halves the next window down to 16 and never below", () => {
    const seen = windows(100, 7);
    expect(seen.slice(0, 7)).toEqual([256, 128, 64, 32, 16, 16, 16]);
  });
  it("a statement that runs 1 ms doubles the window up to the cap", () => {
    const seen = windows(1, 8);
    expect(seen[0]).toBe(256);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(Math.min(INTEGRITY_SHAPE_SLICE, seen[i - 1]! * 2));
    expect(seen.at(-1)).toBe(INTEGRITY_SHAPE_SLICE);
  });
  it("the first statement over a 20,000-row table covers at most 256 rows", () => {
    expect(windows(5, 1)[0]).toBeLessThanOrEqual(256);
  });
  it("the window rule is kept per check and clamped", () => {
    const owner = {};
    expect(adaptiveWindow(owner, "a", 5_000)).toBe(256);
    adaptWindow(owner, "a", 256, 1000, 5_000);
    expect(adaptiveWindow(owner, "a", 5_000)).toBe(128);
    expect(adaptiveWindow(owner, "b", 5_000)).toBe(256);
    expect(adaptiveWindow(owner, "a", 64)).toBe(64);
  });
});

describe("2d(i): the event-log prune reads forgotten messages a page at a time", () => {
  function history(count: number): DatabaseSync {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id)); CREATE TABLE memory_sources(id TEXT PRIMARY KEY, message_id TEXT); CREATE TABLE memory_tombstones(id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT)");
    db.exec("BEGIN");
    const message = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'user','text',?,?)"), source = db.prepare("INSERT INTO memory_sources VALUES(?,?)"), tomb = db.prepare("INSERT INTO memory_tombstones VALUES(?,?,?)");
    for (let i = 0; i < count; i++) {
      message.run(`t${i % 7}`, `m${i}`, `forget ${i}`, JSON.stringify({ turnId: `u${i}` })); source.run(`s${i}`, `m${i}`);
      tomb.run(`x${String(i).padStart(6, "0")}`, i % 10 === 9 ? "import" : "source", `s${i}`);
    }
    db.exec("COMMIT");
    return db;
  }
  function paged(db: DatabaseSync) {
    const statements: number[] = [];
    const real = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = real(sql);
      if (!/memory_tombstones/.test(sql)) return statement;
      const all = statement.all.bind(statement) as (...args: unknown[]) => unknown[];
      (statement as unknown as { all: (...args: unknown[]) => unknown[] }).all = (...args) => { const rows = all(...args); statements.push(rows.length); return rows; };
      return statement;
    }) as typeof db.prepare);
    const items = []; let calls = 0;
    const next = forgottenTextsReader(db);
    for (;;) { const page = next(); calls++; items.push(...page.items); if (page.last === null) break; }
    return { items, statements, calls };
  }
  const key = (item: { threadId: string; text?: string }) => `${item.threadId}|${item.text}`;

  it("5,000 tombstoned messages: no statement returns more than 200 rows, and the pages add up to the old function's set", () => {
    const db = history(5_000);
    const expected = forgottenTextsAll(db).map(key).sort();
    const { items, statements } = paged(db);
    expect(Math.max(...statements)).toBeLessThanOrEqual(FORGOTTEN_PAGE_TOMBSTONES);
    expect(statements.length).toBeGreaterThanOrEqual(25);
    expect(items.map(key).sort()).toEqual(expected);
    expect(items.length).toBe(4_500); // the import tombstones name no message
  });
  it("the cost per page does not grow with history: 5,000 and 20,000 messages give the same row counts per statement", () => {
    const small = paged(history(5_000)).statements, large = paged(history(20_000)).statements;
    expect(Math.max(...large)).toBe(Math.max(...small));
  });
});

describe("2f: memory.claim looks at a bounded window of waiting jobs", () => {
  const NOW = 1_000_000;
  function backlog(db: DatabaseSync, count: number): void {
    db.exec("BEGIN");
    for (let s = 0; s < 40; s++) db.prepare("INSERT INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(`scope-${String(s).padStart(3, "0")}`, `owner-${s}`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${count - 1})
      INSERT INTO memory_sources SELECT 'src-'||i,'scope-'||substr('000'||(i%40),-3),'thread-'||(i%50),'m'||i,NULL,1,'h'||i,'text','owner','recorded',NULL,'active' FROM n`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${count - 1})
      INSERT INTO memory_source_versions SELECT 'src-'||i,1,'h'||i,'{"text":"x"}',1 FROM n`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${count - 1})
      INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) SELECT 'job-'||i,'src-'||i,1,'capture','1','pending',0,0,0,0,0 FROM n`);
    db.exec("COMMIT");
  }
  const windowIds = (db: DatabaseSync) => {
    const rids: string[] = [];
    for (const status of ["deferred", "leased", "partial", "pending"]) for (const row of db.prepare(MEMORY_CLAIM_SQL.window).all(status, NOW, CLAIM_WINDOW - rids.length)) rids.push(String(row.rid));
    return JSON.stringify(rids);
  };
  for (const count of [300, 30_000]) {
    it(`a backlog of ${count}: a window pages ${CLAIM_WINDOW} jobs, and the scope and head statements read only those, with the same plan`, () => {
      const db = fresh();
      db.exec("PRAGMA synchronous=OFF");
      backlog(db, count);
      const ids = windowIds(db);
      const pick = db.prepare(MEMORY_CLAIM_SQL.scope).get("", ids, NOW)!;
      expect(Number(pick.window)).toBe(CLAIM_WINDOW);
      expect(pick.first).toBe("scope-000");
      const plan = (sql: string, params: Array<string | number>) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => String(row.detail)).join(" | ");
      const windowPlan = plan(MEMORY_CLAIM_SQL.window, ["pending", NOW, CLAIM_WINDOW]);
      expect(windowPlan).toMatch(/USING (COVERING )?INDEX memory_jobs_pending/); expect(windowPlan).not.toMatch(/\bSCAN (j|memory_jobs)\b(?! USING)/);
      for (const text of [plan(MEMORY_CLAIM_SQL.scope, ["", ids, NOW]), plan(MEMORY_CLAIM_SQL.head, [ids, "scope-000", NOW])]) expect(text).not.toMatch(/\bSCAN (j|memory_jobs)\b(?! USING)/);
      expect(MEMORY_CLAIM_SQL.window).toContain("LIMIT ?3");
      expect(db.prepare(MEMORY_CLAIM_SQL.head).get(ids, "scope-000", NOW)!.rid).not.toBeNull();
    });
  }
  it("the round robin moves on past the last scope served, within the window", () => {
    const db = fresh();
    backlog(db, 300);
    const ids = windowIds(db);
    const after = db.prepare(MEMORY_CLAIM_SQL.scope).get("scope-005", ids, NOW)!;
    expect(after.after).toBe("scope-006");
    const wrapped = db.prepare(MEMORY_CLAIM_SQL.scope).get("scope-999", ids, NOW)!;
    expect(wrapped.after).toBeNull();
    expect(wrapped.first).toBe("scope-000");
  });
});

describe("3: the upgrade strip counts work done, not the queue's shrinkage", () => {
  it("a walk whose queue refills as fast as it drains still moves done on every slice", () => {
    const db = fresh();
    const R = openBulkRevoke(db, "upgrade-seed", false);
    expect(R).toBeGreaterThan(0);
    db.prepare("UPDATE memory_revoke_jobs SET state='active',phase='mark' WHERE revoke_id=?").run(R);
    let next = 0;
    for (let i = 0; i < 400; i++) enqueueNode(db, R, { kind: "scope", scopeId: `s${next++}` });
    const queued = upgradeMarkerWork(db);
    let maxQueue = queued, oldBar = 0, last = upgradeMarkerWalked(db);
    for (let slice = 0; slice < 50; slice++) {
      expect(markerSlice(db, 6)).toBe(true);
      // the fan-out refills what the slice handled
      const left = upgradeMarkerWork(db);
      for (let i = 0; i < queued - left; i++) enqueueNode(db, R, { kind: "scope", scopeId: `s${next++}` });
      expect(upgradeMarkerWork(db)).toBe(queued);
      // the old reading: the largest queue so far minus the queue now, which stands still here
      maxQueue = Math.max(maxQueue, upgradeMarkerWork(db)); oldBar = Math.max(oldBar, maxQueue - upgradeMarkerWork(db));
      const walked = upgradeMarkerWalked(db);
      expect(walked).toBeGreaterThan(last);
      last = walked;
    }
    expect(oldBar).toBe(0);
  });
  it("work done by a user's own revoke is not counted in the upgrade's", () => {
    const db = fresh();
    const R = openBulkRevoke(db, "someone-else", false);
    db.prepare("UPDATE memory_revoke_jobs SET state='active',phase='mark' WHERE revoke_id=?").run(R);
    for (let i = 0; i < 20; i++) enqueueNode(db, R, { kind: "scope", scopeId: `q${i}` });
    while (markerSlice(db, 6)) { /* to the end */ }
    expect(upgradeMarkerWalked(db)).toBe(0);
  });
  it("a blocked seed retries inside 15 seconds", () => {
    expect(BACKGROUND_SEED_RETRY_MAX_MS).toBeLessThanOrEqual(15_000);
  });
});
