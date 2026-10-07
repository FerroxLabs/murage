// R4: the reconciliation cursor over (retry_at, rowid) seeks on both
// components. Every cancelled job is visited once per pass, however many of
// them share one retry_at (the ordinary value is 0), so a pass is linear in the
// cancelled jobs and not quadratic.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import * as park from "./park.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";

const fix = park as unknown as Record<string, any>;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [], groups: [] }); setMemoryMode("capture"); park.resetParkSweep(); fix.resetParkReconcile();
});
afterEach(() => { closeDatabase(); });

/** One active source with n cancelled jobs; retryOf places each job's retry_at. */
function cancelled(n: number, retryOf: (i: number) => number = () => 0) {
  const db = database();
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_scopes VALUES('s','conversation','o','[]',0)").run();
  db.prepare("INSERT INTO memory_sources VALUES('big','s','t','m',NULL,1,'h','text','owner','recorded',NULL,'active')").run();
  db.prepare("INSERT INTO memory_source_versions VALUES('big',1,'h',?,1)").run(JSON.stringify({ text: "x" }));
  const insert = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,policy_revision,deletion_epoch) VALUES(?,'big',1,'capture',?,'cancelled',?,0,0)");
  for (let i = 0; i < n; i++) insert.run(`c-${i}`, `v${i}`, retryOf(i));
  db.exec("COMMIT");
  return db;
}
/** The database with a counting function evaluated first on every row a reconciliation select visits. */
function counting(db: ReturnType<typeof database>) {
  const visited: bigint[] = [];
  db.function("probe", { deterministic: false, varargs: true }, (rowid: unknown) => { visited.push(BigInt(rowid as number)); return 1; });
  const wrapped = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => target.prepare(/FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status='cancelled'/.test(sql) ? sql.replace("WHERE ", "WHERE probe(rowid) AND ") : sql);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { db: wrapped as typeof db, visited };
}
const plan = (sql: string, ...args: any[]) => database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => String(r.detail)).join("\n");

describe("R4: the reconciliation cursor seeks on retry_at and rowid", () => {
  it("the tied-retry select is a status=? AND retry_at=? AND rowid>? index seek; the rest of the window seeks retry_at>?", () => {
    cancelled(3);
    const tied = plan(fix.PARK_SQL.reconcileTied, 0, 0);
    expect(tied).toMatch(/SEARCH memory_jobs USING (COVERING )?INDEX memory_jobs_pending \(status=\? AND retry_at=\? AND rowid>\?\)/);
    expect(tied).not.toMatch(/SCAN|TEMP B-TREE/);
    const later = plan(fix.PARK_SQL.reconcileLater, 0, 10);
    expect(later).toMatch(/SEARCH memory_jobs USING (COVERING )?INDEX memory_jobs_pending \(status=\? AND retry_at>\?\)/);
    expect(later).not.toMatch(/SCAN|TEMP B-TREE/);
  });

  it("5,000 cancelled jobs sharing retry_at=0: a full pass visits each job once", () => {
    const n = 5_000;
    const { db, visited } = counting(cancelled(n));
    let steps = 0;
    while (!fix.parkReconcileFinished() && steps < 50) { fix.parkReconcileStep(db); steps++; }
    expect(fix.parkReconcileFinished()).toBe(true);
    expect(steps).toBe(Math.floor(n / park.PARK_WINDOW_SQL) + 1);
    expect(visited.length).toBeLessThanOrEqual(n + park.PARK_WINDOW_SQL);  // linear; the earlier statement visited about n*steps/2 = 27,500
    expect(new Set(visited).size).toBe(n);
  });

  it("jobs with mixed retry_at, ties crossing window boundaries, are each visited exactly once and a marked one is reopened", () => {
    const n = 2_300;
    const db0 = cancelled(n, i => Math.floor(i / 700) * 1000);  // three tied groups of 700 and a tail
    db0.prepare("UPDATE memory_jobs SET error='parked:v1:{\"s\":\"pending\",\"e\":null}' WHERE id IN ('c-5','c-700','c-1500','c-2299')").run();
    const { db, visited } = counting(db0);
    let reopened = 0, steps = 0;
    while (!fix.parkReconcileFinished() && steps < 50) { reopened += fix.parkReconcileStep(db).reopened; steps++; }
    expect(reopened).toBe(4);
    expect(visited.length).toBe(n);
    expect(new Set(visited).size).toBe(n);
  });
});
