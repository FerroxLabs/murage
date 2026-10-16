// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13 round 2 (e): while the history upgrade runs, GET /api/memory/status serves its table figures (record counts, backlog, scope list) from the
// last reading instead of reading the memory tables again (rc13 real-data run: 128 to 194 ms a call beside the upgrade's I/O).
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { MEMORY_STATE_COUNT_SQL, memoryOwnerStatus, resetMemoryStatusFigures } from "./settings.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
const ticket = ownerMemoryTicket();
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
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
