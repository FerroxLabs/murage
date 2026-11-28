// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (HIDDEN-COST items 3, 4; owner: q1022-sqlite-opus; item 2's cadence witness W2 is OPEN, kept out of the tree). The real database handle, the real checkpoint worker and its real
// supervisor, except W3, which runs the supervisor's own tick source (wal-maintenance.ts tick) with the wall clock in the test's hand, the
// same way wal-recovery-behaviour.test.ts drives the stall deadline: a Mac sleep cannot be made inside a container.
//  W3 sleep: a wall-clock jump between two ticks (lid closed for 10 min, twice inside the 300 s window) is no stall and never pauses writes;
//     a worker that really stops beating is still replaced at the stall bound.
//  W4 fallback: a worker with no commit notice (wake bus down) polls about once a second, not every 25 ms.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { ioBudget } from "./io-budget.ts";
import { JOURNAL_SIZE_LIMIT_BYTES, closeDatabase, database } from "./database.ts";
import { startWalMaintenance, stopWalMaintenance, walMaintenanceCounters, walMaintenanceReady, settleWal } from "./wal-maintenance.ts";
import { searchCleanupPending, stopSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function cleanSlate() { closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
async function ready() {
  await cleanSlate();
  const db = database();
  await vi.waitFor(() => expect(searchCleanupPending(db)).toBe(false), { timeout: 10_000, interval: 10 });
  await stopSearchIndex();
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
  db.exec("CREATE TABLE IF NOT EXISTS canary(id INTEGER PRIMARY KEY, body TEXT)");
  expect(await settleWal({ nudge: true })).toBe(true);
  return db;
}
beforeEach(() => mkdirSync(DATA_DIR, { recursive: true }));
afterEach(async () => { ioBudget.stop(); await cleanSlate(); });

it("W3 sleep: a wall-clock jump between ticks is no stall and never pauses writes; a real stall is still replaced", () => {
  const source = readFileSync(new URL("./wal-maintenance.ts", import.meta.url), "utf8");
  const supervisor = source.slice(source.indexOf("function tick(m:"), source.indexOf("/** True while a deletion's scrub"));
  const slot = Number(source.match(/^const HEARTBEAT_SLOT = (\d+);/m)![1]);
  const stallMs = Number(source.match(/^export const WAL_STALL_MS = ([\d_]+);/m)![1].replace(/_/g, ""));
  const constants = Object.fromEntries([...source.matchAll(/^export const (TICK_RESUME_GAP_MS) = ([\d_]+);/gm)].map(([, k, v]) => [k, Number(v.replace(/_/g, ""))]));
  const shared = new Int32Array(new SharedArrayBuffer((slot + 1) * 4));
  const m: Record<string, unknown> = { failed: false, shared, lastBeat: 0, beatAt: 0, walFile: "fixture.db-wal", lastResult: null, lastSize: 0, inflight: null, notice: {} };
  let now = 1_000_000, replacements = 0, lastReplaceAt: number | null = null;
  const context: Record<string, unknown> = { ...constants, active: m, Atomics, HEARTBEAT_SLOT: slot, stallMs, Date: { now: () => now }, writesPaused: false,
    // the production window rule (replaceStalled): a second stall inside 5 x the bound pauses writes instead
    replaceStalled: () => { if (lastReplaceAt !== null && now - lastReplaceAt < 5 * stallMs) { context.writesPaused = true; return false; } lastReplaceAt = now; replacements++; return true; },
    TICK_ASK_BYTES: 1 << 20, WAL_PACE: { quietMs: 5000 },
    ioBudget: { admissionTick() {} }, statSync: () => ({ size: 0 }), checkpointPassive() {}, releaseWalReaders() {} };
  const tick = runInNewContext(ts.transpile(supervisor + "\ntick"), context) as (maintenance: typeof m) => void;
  const ticks = (count: number) => { for (let index = 0; index < count; index++) { now += 1000; tick(m); } };
  // a healthy idle worker beats every 30 s (WAL_IDLE_CHECK_MS); the supervisor ticks every second
  Atomics.store(shared, slot, 1); tick(m); ticks(20);
  now += 600_000; tick(m); // the lid was closed for 10 minutes: no thread ran, the worker's 30 s wait still has time left
  expect(replacements, "W3: a sleep is not a stall (the worker is replaced only when its own clock stops)").toBe(0);
  Atomics.add(shared, slot, 1); ticks(10);
  now += 600_000; tick(m); ticks(5); // a second sleep inside the 300 s window
  expect(context.writesPaused, "W3: two sleeps never pause the owner's writes").toBe(false);
  expect(replacements).toBe(0);
  ticks(Math.ceil(stallMs / 1000) + 1); // now the worker really stops beating, with the process awake
  expect(replacements, "W3: a worker whose clock really stops is still replaced at the stall bound").toBe(1);
});

it("W4 fallback: with no commit notice the worker polls about once a second, not every 25 ms", { timeout: 60_000 }, async () => {
  const db = await ready();
  // the same connection; its ports offer a commit notice but have none to give (the wake bus is down, as database.ts:524 answers then)
  startWalMaintenance(join(DATA_DIR, "messages.db"), {
    commitNotice: () => null,
    setAutocheckpoint(pages: number) { db.exec(`PRAGMA wal_autocheckpoint=${pages}`); },
    async nudge() { const version = Number(db.prepare("PRAGMA user_version").get()!.user_version); db.exec(`PRAGMA user_version=${version}`); return true; },
    journalSizeLimit: () => Number(db.prepare("PRAGMA journal_size_limit").get()!.journal_size_limit),
    pinJournalSizeLimit: () => { db.exec(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}`); },
    setJournalSizeLimit: (bytes: number) => { db.exec(`PRAGMA journal_size_limit=${bytes}`); }, // 1.0.22: as the server ports (database.ts)
  });
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
  expect(walMaintenanceCounters()!.eventDriven, "the worker under test has no commit notice").toBe(false);
  await sleep(500);
  const before = walMaintenanceCounters()!.polls;
  await sleep(3000);
  const polls = walMaintenanceCounters()!.polls - before;
  console.log(`SQLITE-MEASURE W4 polls-in-3s=${polls}`);
  expect(polls, "W4: about 3 polls in 3 s, not 120").toBeLessThanOrEqual(6);
  expect(polls, "W4: the fallback still polls").toBeGreaterThanOrEqual(1);
});
