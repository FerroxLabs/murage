// q1022-disk item 1: messages.pre-memory-v2/v3/v4.db are removed once the upgraded store has opened cleanly on 2 launches and
// 7 days have passed, never before, and Storage shows their size until then. Each launch is a fresh module graph (a new
// process) opening the real store through database.ts; the copy is the file the upgrade leaves beside messages.db.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const DAY = 86_400_000, T0 = Date.parse("2026-07-01T00:00:00Z");
const COPY = "messages.pre-memory-v4.db", COPY3 = "messages.pre-memory-v3.db";
async function launch(at: number) {
  vi.setSystemTime(at);
  vi.resetModules();
  const db = await import("../database.ts");
  db.database();
  const storage = (await import("../storage-report.ts")).storageReport(DATA_DIR) as unknown as Record<string, unknown>;
  db.closeDatabase();
  return storage;
}
function placeCopy(name: string, at: number) {
  writeFileSync(join(DATA_DIR, name), Buffer.alloc(64 * 1024, 7));
  utimesSync(join(DATA_DIR, name), new Date(at), new Date(at));
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  await launch(T0); // the first launch makes the store; the upgrade's copy is beside it from here on
});
afterEach(() => { vi.useRealTimers(); });
const has = (name: string) => existsSync(join(DATA_DIR, name));

it("Q22DISK-COPY removed after 2 clean launches and 7 days", async () => {
  placeCopy(COPY, T0);
  await launch(T0 + DAY);
  expect(has(COPY)).toBe(true);
  await launch(T0 + 9 * DAY);
  expect(has(COPY), "Q22DISK-COPY copy still on disk after 2 clean launches and 8 days").toBe(false);
});

it("Q22DISK-COPY Storage shows the copies' size until they go", async () => {
  placeCopy(COPY, T0);
  const first = await launch(T0 + DAY);
  expect(first.upgradeCopies, "Q22DISK-COPY Storage shows the copy's size").toEqual({ bytes: statSync(join(DATA_DIR, COPY)).size, count: 1 });
  await launch(T0 + 9 * DAY);
  expect((await launch(T0 + 10 * DAY)).upgradeCopies).toEqual({ bytes: 0, count: 0 });
});

it("Q22DISK-COPY never before 7 days, never on a single launch, and a replaced copy starts again", async () => {
  placeCopy(COPY, T0);
  for (let d = 1; d <= 6; d++) await launch(T0 + d * DAY);
  expect(has(COPY)).toBe(true); // 6 launches, 5 days since it was first seen
  placeCopy(COPY3, T0 + 6 * DAY);
  await launch(T0 + 8 * DAY);
  expect([has(COPY), has(COPY3)]).toEqual([false, true]); // the v3 copy has one launch and two days
  await launch(T0 + 30 * DAY);
  expect(has(COPY3), "Q22DISK-COPY second copy removed on its own count").toBe(false);
});

it("Q22DISK-COPY an upgrade weeks ago still waits for the second clean launch", async () => {
  placeCopy(COPY, T0 - 30 * DAY);
  await launch(T0 + DAY);
  expect(has(COPY), "Q22DISK-COPY removed on the first clean launch").toBe(true);
  await launch(T0 + DAY + 60_000);
  expect(has(COPY)).toBe(false);
});

it("Q22DISK-COPY waits while the integrity pass runs or holds, and goes once it passed", async () => {
  const pass = (run: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(DATA_DIR, "messages.db")); try { run(db); } finally { db.close(); } };
  const { beginIntegrityPass, writeIntegrityPass } = await import("./integrity-state.ts");
  placeCopy(COPY, T0);
  pass(db => beginIntegrityPass(db, T0));
  for (const d of [1, 9, 10]) await launch(T0 + d * DAY);
  const whileRunning = has(COPY);
  pass(db => writeIntegrityPass(db, { phase: "done", finishedAt: T0 + 10 * DAY, result: "held:damaged-row" }));
  for (const d of [11, 12]) await launch(T0 + d * DAY);
  const whileHeld = has(COPY);
  pass(db => writeIntegrityPass(db, { result: "passed" }));
  for (const d of [13, 14]) await launch(T0 + d * DAY);
  expect({ whileRunning, whileHeld, afterPassed: has(COPY) }, "Q22DISK-COPY copy present while the pass runs, holds, after it passed")
    .toEqual({ whileRunning: true, whileHeld: true, afterPassed: false });
});
