// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: q1022-idlewit-opus owns these witnesses and the idleQuiet foreground clause they guard (io-budget.ts idleQuiet); the ledger
// lock and its miss path (io-budget.ts critical, admission-shared.ts rule 2) = scperf-p1 / q1022-lockloop-opus; the reader's demand
// (recall-view.ts demandRecallContext, io-budget.ts noteRecallDemand) = q1022-idlefix-fable; idle DO LESS = q1022-idlequiet-opus;
// MAIN owns the rulings.
// int-1022q-w1 NEXT H2 (FABLE c8325615bd H2, OPUS e9be24113d H1, ASTRA 67c91997e6 / d6a5005643): a reader's demand marks the minute
// active (foregroundActivity) and then takes ONE ledger reading. When that reading misses the lock (AdmissionLockTimeout: the
// checkpointer holds the ledger word) the miss publishes the strict idle verdict, and every later demand skips the reading because the
// mark is already set. idleQuiet() then kept answering "idle" for a minute the owner made active, so the warming and the upkeep a
// waiting turn needs (recall-view.ts scheduleContextQueue and runRecallUpkeep) stayed parked until a later section took the lock
// (lockloop backs that refresh off 250 ms doubling to 2 s). MAIN-RULING 2026-11-25T12:40:11Z: a turn must NEVER fail or lose memory
// because the app was idle. The published verdict stays strict for admission (a miss still stores idle in slot 7); only the
// DO LESS hold no longer parks work on a minute with owner activity.
// Real modules on a real database; the entry point is the reader's call server/index.ts makes (resolveRecallView, which files the
// demand), the lock is held on the real ledger word (slot 0) with a foreign owner token, as the checkpointer holds it.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { threadHumanPrincipal } from "../human-principals.ts";
import { ioBudget } from "../io-budget.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import * as views from "./recall-view.ts";

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const FOREIGN = (7n << 32n) | 1n; // a worker thread's token (the checkpointer's copy holds the word like this)
const roster = (): MemoryRoster => ({ memoryRosterRevision: 1, bots: [{ id: "reader", threadId: "reader-thread" }, { id: "other-a", threadId: "other-a-thread" }, { id: "other-b", threadId: "other-b-thread" }], groups: [] });
const viewsBuilt = () => Number(database().prepare("SELECT count(*) AS n FROM memory_recall_views").get()!.n);
const clearActivity = () => { (ioBudget as unknown as { foregroundActivity: boolean }).foregroundActivity = false; };
const slots = () => new BigInt64Array(ioBudget.checkpointAdmissionBuffer(false));
let held: BigInt64Array | undefined;
const holdLedger = (): void => { const s = slots(); expect(Atomics.compareExchange(s, 0, 0n, FOREIGN), "setup: the ledger word is free before the foreign hold").toBe(0n); held = s; };
const releaseLedger = (): void => { if (held) Atomics.compareExchange(held, 0, FOREIGN, 0n); held = undefined; };
/** The published admission verdict (slot 7), read off the held buffer: no section of its own. */
const publishedIdle = (): boolean => Atomics.load(held!, 7) !== 0n;
async function freshMinute(need: number): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < need) await sleep(left + 1_000);
}
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); clearActivity(); });
afterEach(async () => {
  releaseLedger();
  vi.restoreAllMocks(); ioBudget.setIsIdle(() => false); clearActivity();
  views.setRecallSessionRidersForTest(); views.stopRecallViewMaintenance(); closeDatabase();
});

function lateBots(r: MemoryRoster): void {
  (r as { memoryRosterRevision: number }).memoryRosterRevision = 2;
  (r as { bots: Array<{ id: string; threadId: string }> }).bots = [...r.bots, { id: "late-reader", threadId: "late-reader-thread" }, { id: "late-a", threadId: "late-a-thread" }, { id: "late-b", threadId: "late-b-thread" }];
  reconcileMemoryRoster(r);
}
const lateBinding = () => ({ botId: "late-reader", threadId: "late-reader-thread", humanPrincipal: threadHumanPrincipal("late-reader-thread"), notOwnerAudience: false });

/** Booted views on an active minute, then an idle minute with a roster change whose warming idle DO LESS parks. */
async function idleWithParkedWarming(): Promise<{ r: MemoryRoster; built0: number }> {
  setMemoryMode("active");
  const r = roster();
  reconcileMemoryRoster(r);
  await stopWalMaintenance();
  ioBudget.setIsIdle(() => false);
  views.prepareRosterRecallViews(r);
  await views.waitForRecallConstructionIdleForTest(r);
  await freshMinute(30_000);
  clearActivity();
  ioBudget.setIsIdle(() => true);
  expect(ioBudget.idleQuiet(), "setup: the minute is judged idle").toBe(true);
  const built0 = viewsBuilt();
  lateBots(r);
  views.prepareRosterRecallViews(r);
  for (let i = 0; i < 80; i++) await sleep(5);
  expect({ views: viewsBuilt(), idle: ioBudget.idleQuiet() }, "setup: an idle minute parks warming nobody waits on (idle DO LESS, unchanged)").toEqual({ views: built0, idle: true });
  return { r, built0 };
}

/** The reader's call with the ledger word held: its demand's one reading misses the lock. */
function demandUnderLockMiss(r: MemoryRoster): void {
  holdLedger();
  const timeouts0 = ioBudget.admissionHealth().lockTimeouts;
  let pending: unknown;
  try { views.resolveRecallView(lateBinding(), r); } catch (error) { pending = error; }
  expect((pending as Error | undefined)?.message, "setup: the reader's view is not ready, so it files its demand").toBe("MEMORY_RECALL_UNAVAILABLE");
  expect({ published: publishedIdle(), missed: ioBudget.admissionHealth().lockTimeouts > timeouts0 }, "setup: the demand's reading missed the held lock and the miss published the strict idle verdict (unchanged)").toEqual({ published: true, missed: true });
}

it("W-LOCKMISS-WARM (recall-view.ts scheduleContextQueue idle hold): a reader's demand whose ledger reading misses the lock still makes the minute active for idle DO LESS; the reader's view and the warming the idle minute parked are built while the lock stays held", async () => {
  const { r, built0 } = await idleWithParkedWarming();
  demandUnderLockMiss(r);
  // a second demand on the same minute (the reader asks again): the activity mark is set, so it takes no reading of its own
  try { views.resolveRecallView({ botId: "late-a", threadId: "late-a-thread", humanPrincipal: threadHumanPrincipal("late-a-thread"), notOwnerAudience: false }, r); } catch { /* not ready: filed */ }
  const settled = await Promise.race([views.waitForRecallConstructionIdleForTest(r).then(() => true, () => false), sleep(8_000).then(() => false)]);
  expect({ quiet: ioBudget.idleQuiet(), settled, built: viewsBuilt() > built0, published: publishedIdle() }, "lock still held: the owner's minute is not quiet, everything parked runs with the reader, the published admission verdict stays strict").toEqual({ quiet: false, settled: true, built: true, published: true });
  releaseLedger();
  let ready = false;
  try { views.resolveRecallView(lateBinding(), r); ready = true; } catch { /* not ready */ }
  expect(ready, "the reader's view is ready on its next read").toBe(true);
}, 120_000);

it("W-LOCKMISS-UPKEEP (recall-view.ts runRecallUpkeep idle hold: reclaim, the parked reader's re-ask, riders): after a reader's demand whose ledger reading misses the lock, the upkeep look runs on the owner's minute while the lock stays held", async () => {
  const { r } = await idleWithParkedWarming();
  views.startRecallViewMaintenance();
  let looks = 0;
  views.setRecallSessionRidersForTest(null, () => { looks++; });
  views.runRecallUpkeepForTest();
  expect(looks, "setup: on the idle minute the upkeep look is held (idle DO LESS, unchanged)").toBe(0);
  demandUnderLockMiss(r);
  views.runRecallUpkeepForTest();
  expect({ looks: looks > 0, published: publishedIdle() }, "lock still held: the upkeep a waiting reader needs (reclaim, the parked reader's re-ask) runs on the owner's minute; the published admission verdict stays strict").toEqual({ looks: true, published: true });
}, 120_000);

it("W-LOCKMISS-IDLE (guard, io-budget.ts idleQuiet): a lock miss alone, with no owner activity on the minute, keeps the idle minute quiet: the warming and the upkeep look stay held while the lock is held", async () => {
  const { r, built0 } = await idleWithParkedWarming();
  views.startRecallViewMaintenance();
  let looks = 0;
  views.setRecallSessionRidersForTest(null, () => { looks++; });
  holdLedger();
  const timeouts0 = ioBudget.admissionHealth().lockTimeouts;
  views.prepareRosterRecallViews(r);
  views.runRecallUpkeepForTest();
  for (let i = 0; i < 80; i++) await sleep(5);
  expect({ quiet: ioBudget.idleQuiet(), missed: ioBudget.admissionHealth().lockTimeouts > timeouts0, views: viewsBuilt(), looks, published: publishedIdle() }, "no demand, lock held: a miss is not owner activity, so idle DO LESS still holds the warming and the upkeep").toEqual({ quiet: true, missed: true, views: built0, looks: 0, published: true });
}, 120_000);
