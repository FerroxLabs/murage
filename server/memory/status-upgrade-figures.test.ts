// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13 round 2 (e): while the history upgrade runs, GET /api/memory/status serves its table figures (record counts, backlog, scope list) from the
// last reading instead of reading the memory tables again (rc13 real-data run: 128 to 194 ms a call beside the upgrade's I/O).
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { MEMORY_OLDEST_QUEUED_SQL, MEMORY_STATE_COUNT_SQL, memoryOwnerRoute, memoryOwnerStatus, resetMemoryStatusFigures } from "./settings.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureWorkspace } from "../workspace.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
const ticket = ownerMemoryTicket();
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'"); resetMemoryStatusFigures();
});
function addRecord(id: string): void {
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','x','owner-statement','active',0,1,NULL,NULL,1)").run(id, scope);
  db.exec("PRAGMA foreign_keys=ON");
}
/** The table-figure statements prepared while `run` runs. */
function figureReads(run: () => unknown): number {
  const db = database(), original = db.prepare.bind(db);
  let reads = 0;
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => { if (sql === MEMORY_STATE_COUNT_SQL || sql.includes("FROM memory_jobs j WHERE j.status=st.status") || sql.includes("FROM memory_scopes WHERE kind")) reads++; return original(sql); };
  try { run(); } finally { (db as unknown as { prepare: unknown }).prepare = original; }
  return reads;
}

it("reads the tables when no upgrade runs, and serves the last reading while one does", () => {
  let upgrading = false;
  const options = { upgradeRunning: () => upgrading };
  addRecord("r1");
  expect(memoryOwnerStatus(ticket, roster, options).records.active).toBe(1);
  upgrading = true;
  addRecord("r2");
  let status: ReturnType<typeof memoryOwnerStatus> | undefined;
  expect(figureReads(() => { status = memoryOwnerStatus(ticket, roster, options); })).toBe(0);
  expect(status!.records.active).toBe(1); // the last reading
  expect(status!.scopes.length).toBeGreaterThan(0);
  upgrading = false;
  expect(figureReads(() => { status = memoryOwnerStatus(ticket, roster, options); })).toBeGreaterThan(0);
  expect(status!.records.active).toBe(2);
});

it("the first call of a connection reads the tables even while the upgrade runs", () => {
  const options = { upgradeRunning: () => true };
  addRecord("r1");
  let status: ReturnType<typeof memoryOwnerStatus> | undefined;
  expect(figureReads(() => { status = memoryOwnerStatus(ticket, roster, options); })).toBeGreaterThan(0);
  expect(status!.records.active).toBe(1);
  closeDatabase(); // a new connection: its own first reading
  expect(figureReads(() => { memoryOwnerStatus(ticket, roster, options); })).toBeGreaterThan(0);
});

// 1.0.3 lane 3 (stall r2 M3): the first status call under the upgrade (of a connection, or after an owner's action) read every figure in one
// hold of the loop. It now reads them one statement per turn of the loop.
it("the first status call under the upgrade reads its figures one statement per turn, and they are right", async () => {
  const options = { upgradeRunning: () => true };
  addRecord("r1"); addRecord("r2");
  const db = database(), original = db.prepare.bind(db);
  let turn = 0, stop = false;
  const perTurn = new Map<number, number>();
  const tick = () => { if (stop) return; turn++; setImmediate(tick); };
  setImmediate(tick);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (sql === MEMORY_STATE_COUNT_SQL || sql.includes("FROM memory_jobs j WHERE j.status=st.status") || sql.includes("FROM memory_scopes WHERE kind")) perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1);
    return original(sql);
  };
  let status: { records: { active: number } };
  try { status = await memoryOwnerRoute("/api/memory/status", undefined, ticket, roster, options) as unknown as typeof status; }
  finally { (db as unknown as { prepare: unknown }).prepare = original; stop = true; }
  expect(status.records.active).toBe(2);
  // (the state count is prepared once for its five runs: three figure statements are prepared, each on its own turn)
  expect([...perTurn.values()].reduce((a, b) => a + b, 0)).toBe(3);
  // five state counts, the backlog, the oldest job and the scope count each end a turn
  expect(turn, "turns of the loop the reading was spread over").toBeGreaterThanOrEqual(7);
  expect(Math.max(...perTurn.values()), "at most one figure statement per turn of the loop").toBe(1);
  // the next call serves that reading
  expect(figureReads(() => { memoryOwnerStatus(ticket, roster, options); })).toBe(0);
});

it("an owner's action during a sliced reading: the reading taken before it is not kept", async () => {
  const options = { upgradeRunning: () => true };
  addRecord("r1");
  const db = database(), original = db.prepare.bind(db);
  let turn = 0, stop = false;
  const perTurn = new Map<number, number>();
  const tick = () => { if (stop) return; turn++; setImmediate(tick); };
  setImmediate(tick);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (sql === MEMORY_STATE_COUNT_SQL || sql.includes("FROM memory_jobs j WHERE j.status=st.status") || sql.includes("FROM memory_scopes WHERE kind") || sql === MEMORY_OLDEST_QUEUED_SQL) perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1);
    return original(sql);
  };
  const first = memoryOwnerRoute("/api/memory/status", undefined, ticket, roster, options);
  resetMemoryStatusFigures(); // what an owner's action does
  addRecord("r2");
  let status: ReturnType<typeof memoryOwnerStatus>;
  try { status = await first as unknown as ReturnType<typeof memoryOwnerStatus>; }
  finally { (db as unknown as { prepare: unknown }).prepare = original; stop = true; }
  // the reading starts again in slices (Astra r1: it fell through to one synchronous read of every figure)
  expect(Math.max(...perTurn.values()), "at most one figure statement per turn, after the restart too").toBe(1);
  expect(status.records.active, "the figures read before the action were dropped, not served").toBe(2);
  expect(memoryOwnerStatus(ticket, roster, options).records.active).toBe(2);
});

// 1.0.3 lane 3 (stall r2, Astra): enable-and-import returned the counts its nested configure read before the import.
it("enable-and-import under the upgrade returns the figures after the import", async () => {
  const options = { upgradeRunning: () => true };
  database().exec("UPDATE memory_meta SET mode='off'");
  writeFileSync(join(ensureWorkspace("a"), "MEMORY.md"), "Owner enabled notebook");
  const result = await memoryOwnerRoute("/api/memory/action", { action: "enable-and-import" }, ticket, roster, options) as unknown as { imported: number; status: ReturnType<typeof memoryOwnerStatus> };
  expect(result.imported).toBe(1);
  resetMemoryStatusFigures();
  const fresh = memoryOwnerStatus(ticket, roster);
  expect(result.status.records).toEqual(fresh.records);
  expect(Object.values(fresh.records).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
});

// 1.0.3 Astra r1 (High): the sliced reading took the backlog count a turn before the oldest-job query; jobs reopened between them turned that
// query into a walk of every queued job. It is bounded on its own now.
it("the oldest-job query is bounded on its own, whatever the count read a turn earlier said", async () => {
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  db.exec("BEGIN");
  for (let i = 0; i < 1_500; i++) {
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,1,?,'text','owner','recorded',NULL,'active')").run(`src-${i}`, scope, "thread-a", `m${i}`, null, `h${i}`);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,?)").run(`src-${i}`, `h${i}`, "{}", i + 1);
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','complete',0,0,0,0,0)").run(`job-${i}`, `src-${i}`);
  }
  db.exec("COMMIT");
  const original = db.prepare.bind(db);
  // between the backlog count and the oldest-job query: every job reopened
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (sql.includes("FROM memory_jobs j WHERE j.status=st.status")) setImmediate(() => { original("UPDATE memory_jobs SET status='pending'").run(); });
    return original(sql);
  };
  try { await memoryOwnerRoute("/api/memory/status", undefined, ticket, roster, { upgradeRunning: () => true }); }
  finally { (db as unknown as { prepare: unknown }).prepare = original; }
  // the query stopped past the cap and says so, instead of reading every queued job for the minimum
  expect(memoryOwnerStatus(ticket, roster, { upgradeRunning: () => true }).backlog.oldestQueuedAt).toBeNull();
  expect(db.prepare(MEMORY_OLDEST_QUEUED_SQL).get(1_001)!.n).toBe(1_001);
});
