// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opening Memory settings (GET /api/memory/status, and the status every POST /api/memory/action answers with) counts records, jobs and
// deletion updates by key and to a limit: the same statements and rows with 10 and with 200,000 rows behind them, and a figure past the
// limit reads "1,000+" instead of walking the table (before: a GROUP BY over memory_records and an OR over memory_projection_receipts).
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { MEMORY_OLDEST_QUEUED_SQL, memoryOwnerRoute, memoryOwnerStatus } from "./settings.ts";
import { memoryDeletionStatus, MEMORY_COUNT_CAP } from "./forget.ts";
import { clearResetWatch, noteSealedTurn } from "./reset-watch.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
const ticket = ownerMemoryTicket();
function fresh() {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
}
beforeEach(fresh);

/** `n` records spread over the five states, `n` queued jobs and `n` delete-pending receipts: other people's history behind the figures. */
function fill(n: number): void {
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  db.exec("PRAGMA foreign_keys=OFF"); // only the number of rows matters here
  db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_records
    SELECT 'h-'||n,1,?,'fact','x','owner-statement',CASE n%5 WHEN 0 THEN 'candidate' WHEN 1 THEN 'active' WHEN 2 THEN 'archived' WHEN 3 THEN 'superseded' ELSE 'deleted' END,0,1,NULL,NULL,n FROM c`).run(n, scope);
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_jobs (id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch)
    SELECT 'j-'||n,'s-'||n,1,'capture','1',CASE n%5 WHEN 0 THEN 'pending' WHEN 1 THEN 'partial' WHEN 2 THEN 'leased' WHEN 3 THEN 'deferred' ELSE 'failed' END,0,0 FROM c`).run(n);
  db.prepare("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_projection_receipts SELECT 'h-'||n,1,0,'delete-pending','delete-pending',NULL FROM c").run(n);
  db.exec("COMMIT");
}

type Seen = { sql: string; rows: number };
function record(action: () => unknown): Seen[] {
  const db = database(), seen: Seen[] = [], original = db.prepare.bind(db);
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
        else if (key === "run") entry.rows += Number((out as { changes: number }).changes);
        return out;
      };
    } });
  };
  try { action(); } finally { (db as unknown as { prepare: unknown }).prepare = original; }
  return seen;
}
const OF_HISTORY = /memory_records|memory_jobs|memory_projection_receipts/;
const shape = (seen: Seen[]) => seen.filter(item => OF_HISTORY.test(item.sql)).map(item => [item.sql, item.rows]);

// A store of at most 5,000 rows is still measured on the spot by the health and retention figures (bounded by that size, status-scan.ts), so the
// whole route is compared from 6,000 rows up; the counts this file changed are compared from 10 rows up in the next test.
it("the status and a status-answering action read the same statements and rows with 6,000 and with 200,000 rows behind the figures", async () => {
  const runs: Array<{ status: Array<unknown>; action: Array<unknown> }> = [];
  for (const n of [6_000, 200_000]) {
    fresh(); fill(n);
    const db = database();
    const status = record(() => memoryOwnerStatus(ticket, roster));
    const action = await (async () => {
      const seen: Seen[] = [], original = db.prepare.bind(db);
      (db as unknown as { prepare: unknown }).prepare = (sql: string) => { const statement = original(sql); seen.push({ sql, rows: 0 }); return statement; };
      try { await memoryOwnerRoute("/api/memory/action", { action: "learning-bot", botId: "a", enabled: false, learningRevision: 0 }, ticket, roster); }
      finally { (db as unknown as { prepare: unknown }).prepare = original; }
      return seen;
    })();
    // no statement over history walks a table: each plan seeks or scans an index, never the table itself
    for (const entry of [...status, ...action].filter(item => OF_HISTORY.test(item.sql) && /^\s*(WITH|SELECT)/i.test(item.sql))) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...(entry.sql.match(/\?/g) ?? []).map(() => MEMORY_COUNT_CAP + 1)) as Array<{ detail: string }>).map(row => row.detail);
      expect(plan.some(line => /^SCAN (memory_records|memory_jobs|memory_projection_receipts)$/.test(line)), `${entry.sql} :: ${plan.join(" | ")}`).toBe(false);
    }
    runs.push({ status: shape(status), action: action.filter(item => OF_HISTORY.test(item.sql)).map(item => item.sql) });
  }
  expect(runs[0].status.length).toBeGreaterThan(0);
  expect(runs[1].status).toEqual(runs[0].status);
  expect(runs[1].action).toEqual(runs[0].action);
});

it("the counts of records, jobs and deletion updates are the same statements and rows with 10 and with 200,000 rows behind them", () => {
  const runs: Array<Array<unknown>> = [];
  for (const n of [10, 200_000]) {
    fresh(); fill(n);
    const seen = record(() => memoryOwnerStatus(ticket, roster));
    // the two counts the scale review named: memory_records by state and memory_projection_receipts delete-pending, neither scans its table
    for (const entry of seen.filter(item => /WHERE.*LIMIT \?/s.test(item.sql))) {
      const plan = (database().prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...(entry.sql.match(/\?/g) ?? []).map(() => MEMORY_COUNT_CAP + 1)) as Array<{ detail: string }>).map(row => row.detail);
      expect(plan.some(line => /^SCAN (memory_records|memory_jobs|memory_projection_receipts)$/.test(line)), `${entry.sql} :: ${plan.join(" | ")}`).toBe(false);
    }
    runs.push(shape(seen).filter(([sql]) => /WHERE.*LIMIT \?/s.test(String(sql))));
  }
  // records by scope and state, jobs by status, delete-pending receipts; and (1.0.3 L3, b1782088f) the oldest queued job, bounded on its own
  // and asked only while the queue is within the cap (past it the oldest is not shown), so the large store runs one statement fewer, never more
  const oldest = (entry: unknown) => (entry as unknown[])[0] === MEMORY_OLDEST_QUEUED_SQL;
  expect(runs[0].length).toBe(4);
  expect(runs[0].filter(oldest)).toHaveLength(1);
  expect(runs[1].filter(oldest)).toHaveLength(0);
  expect(runs[1]).toEqual(runs[0].filter(entry => !oldest(entry)));
});

it("a figure past the limit reads as the limit and says there are more; below it the figure is exact", () => {
  fill(30);
  const small = memoryOwnerStatus(ticket, roster);
  expect(small.records).toEqual({ candidate: 6, active: 6, archived: 6, superseded: 6, deleted: 6 });
  expect(small.recordsMore).toEqual({});
  expect(small.backlog).toMatchObject({ pending: 12, leased: 6, deferred: 6, failed: 6, more: {} });
  expect(small.backlog.oldestQueuedAt).toBeNull(); // the jobs here have no source version to date them
  expect(small.deletion).toEqual({ pending: 30, more: false });
  fresh(); fill(20_000);
  const big = memoryOwnerStatus(ticket, roster);
  expect(big.records.active).toBe(MEMORY_COUNT_CAP);
  expect(big.recordsMore).toMatchObject({ active: true, deleted: true });
  expect(big.backlog.pending).toBe(MEMORY_COUNT_CAP);
  expect(big.backlog.more).toMatchObject({ pending: true });
  expect(big.backlog.oldestQueuedAt).toBeNull();
  expect(memoryDeletionStatus()).toEqual({ pending: MEMORY_COUNT_CAP, more: true });
});

it("the owner's memory status carries the thread recall sealed turn counter (design S2)", () => {
  clearResetWatch();
  try {
    expect(memoryOwnerStatus(ticket, roster).sealedTurns).toEqual({ threads: 0, turns: 0, recent: [] });
    noteSealedTurn("thread-a", "claude", 5); noteSealedTurn("thread-a", "codex", 6);
    expect(memoryOwnerStatus(ticket, roster).sealedTurns).toEqual({ threads: 1, turns: 2, recent: [{ threadId: "thread-a", count: 2, instances: ["claude", "codex"], lastAt: 6 }] });
  } finally { clearResetWatch(); }
});
