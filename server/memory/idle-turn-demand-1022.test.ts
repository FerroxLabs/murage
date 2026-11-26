// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: q1022-idlefix-fable owns these witnesses and the three lines they guard (recall-view.ts scheduleContextQueue boot sweep,
// demandRecallContext and runRequestedMaintenance); io-budget.ts (scperf-p1) owns the idle verdict; q1022-idlequiet-opus owns idle DO LESS (idleQuiet) and its
// own witnesses (idle-quiet-1022.test.ts); MAIN owns the rulings.
// MAIN-RULING 2026-11-25T12:40:11Z: a turn must NEVER fail or lose memory because the app was idle. Anything a turn or a boot/restart
// path needs (its recall view ready, its view's page applied) is ACTIVE work and is never paused by idleQuiet; idleQuiet pauses only
// background upkeep. The first turn after a restart makes the minute active before its recall is requested.
// Real modules on a real database; the only input the test sets is the owner's idle state (setIsIdle, the predicate server/index.ts
// installs). The entry points are the two calls server/index.ts makes for a reader: resolveRecallView (awaitRecallViewPublished,
// policy.ts turn access) and requestRecallViewMaintenance (buildMemoryBundle's wait). The booted-server rows of the same guarantee are
// decision/production-boot-wiring H2, claude-resume-slow-check, recall-pin-dispatch S2 and c11-refused-resend-api T9/T37.
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
const roster = (): MemoryRoster => ({ memoryRosterRevision: 1, bots: [{ id: "reader", threadId: "reader-thread" }, { id: "other-a", threadId: "other-a-thread" }, { id: "other-b", threadId: "other-b-thread" }], groups: [] });
const binding = () => ({ botId: "reader", threadId: "reader-thread", humanPrincipal: threadHumanPrincipal("reader-thread"), notOwnerAudience: false });
const viewsBuilt = () => Number(database().prepare("SELECT count(*) AS n FROM memory_recall_views").get()!.n);
/** The minute's own owner-activity mark (set by a turn, an owner request or a reader's demand; cleared by the minute tick, which these rows do not run). */
const clearActivity = () => { (ioBudget as unknown as { foregroundActivity: boolean }).foregroundActivity = false; };
/** Waits for a fresh minute when fewer than `need` ms of this one are left, so the minute's end decides nothing below. */
async function freshMinute(need: number): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < need) await sleep(left + 1_000);
}
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); clearActivity(); });
afterEach(async () => {
  vi.restoreAllMocks(); ioBudget.setIsIdle(() => false); clearActivity();
  views.stopRecallViewMaintenance(); closeDatabase();
});

/** A roster change after boot: three more bots. Their contexts are warming nobody waits on (not the boot sweep). */
function lateBots(r: MemoryRoster): void {
  (r as { memoryRosterRevision: number }).memoryRosterRevision = 2;
  (r as { bots: Array<{ id: string; threadId: string }> }).bots = [...r.bots, { id: "late-reader", threadId: "late-reader-thread" }, { id: "late-a", threadId: "late-a-thread" }, { id: "late-b", threadId: "late-b-thread" }];
  reconcileMemoryRoster(r);
}
const lateBinding = () => ({ botId: "late-reader", threadId: "late-reader-thread", humanPrincipal: threadHumanPrincipal("late-reader-thread"), notOwnerAudience: false });

it("W-BOOT-SWEEP: after a boot or restart on an idle minute (nobody has asked for anything) the boot sweep still makes every view ready, the minute stays idle, and a single read of a view (no retry, as an owner action makes it) succeeds", async () => {
  setMemoryMode("active");
  const r = roster();
  reconcileMemoryRoster(r);
  await stopWalMaintenance();
  await freshMinute(30_000);
  ioBudget.setIsIdle(() => true);
  expect(ioBudget.idleQuiet(), "setup: the minute is judged idle").toBe(true);
  const built0 = viewsBuilt();
  // the boot sweep (store.ts finishSharingBoot -> prepareRosterRecallViews): the first enumeration of this database's roster
  views.prepareRosterRecallViews(r);
  const settled = await Promise.race([views.waitForRecallConstructionIdleForTest(r).then(() => true, () => false), sleep(8_000).then(() => false)]);
  expect({ settled, built: viewsBuilt() > built0, idle: ioBudget.idleQuiet() }, "the boot sweep is not held by idle DO LESS: views are built while the minute is still idle").toEqual({ settled: true, built: true, idle: true });
  let refused: unknown;
  try { views.resolveRecallView(binding(), r); } catch (error) { refused = error; }
  expect((refused as Error | undefined)?.message, "one read of the view right after an idle boot: ready, not MEMORY_RECALL_UNAVAILABLE").toBeUndefined();
}, 120_000);

it("W-DEMAND: on an idle minute, with warming parked by idle DO LESS (a roster change while idle), a reader that finds its view not ready makes the minute active before its build is requested, its view becomes ready, and the parked warming runs with it", async () => {
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
  // the reader: a turn being prepared, before any turn.started; the bot tables (isIdle) have not moved
  let pending: unknown;
  try { views.resolveRecallView(lateBinding(), r); } catch (error) { pending = error; }
  expect((pending as Error | undefined)?.message, "setup: the reader's view is not ready, so it files its demand").toBe("MEMORY_RECALL_UNAVAILABLE");
  expect(ioBudget.idleQuiet(), "the reader's demand makes the minute active before its build is requested").toBe(false);
  // the demand ENQUEUE itself (not only the activity mark): the reader's build is a waiting item, which no idle hold parks. The minute
  // tick clears the mark; if that lands right after the demand (the minute is judged idle again), the reader's view is still built,
  // and it is the only one built: the warming nobody waits on stays parked. A demand that only marked the minute and queued nothing
  // leaves the reader on the parked warming here, so it never becomes ready.
  clearActivity();
  ioBudget.setIsIdle(() => true);
  expect(ioBudget.idleQuiet(), "setup: the minute is judged idle again after the demand was filed").toBe(true);
  let ready = false;
  for (let i = 0; i < 500 && !ready; i++) {
    // nothing is read until a view was built on the idle minute, so this wait files no demand of its own before then
    if (viewsBuilt() > built0) { try { views.resolveRecallView(lateBinding(), r); ready = true; } catch { clearActivity(); ioBudget.setIsIdle(() => true); } }
    if (!ready) await sleep(10);
  }
  expect({ ready, idle: ioBudget.idleQuiet() }, "the reader's demand was queued as a waiting build: its view becomes ready even though the minute is idle again").toEqual({ ready: true, idle: true });
  // a second reader (another late bot) on a later look: its demand makes the minute active and everything parked runs with it
  clearActivity();
  ioBudget.setIsIdle(() => true);
  try { views.resolveRecallView({ botId: "late-a", threadId: "late-a-thread", humanPrincipal: threadHumanPrincipal("late-a-thread"), notOwnerAudience: false }, r); } catch { /* not ready: its demand is filed */ }
  expect(ioBudget.idleQuiet(), "the second reader's demand makes the minute active").toBe(false);
  const settled = await Promise.race([views.waitForRecallConstructionIdleForTest(r).then(() => true, () => false), sleep(8_000).then(() => false)]);
  expect({ settled, built: viewsBuilt() > built0 }, "the warming the idle minute parked runs with the reader's turn (nothing is left parked behind it)").toEqual({ settled: true, built: true });
}, 120_000);

it("W-REQUEST: on an idle minute a reader waiting on its own view's page (server/index.ts buildMemoryBundle -> requestRecallViewMaintenance) gets it within the reader's wait; the minute stays idle and background upkeep stays paused", async () => {
  setMemoryMode("active");
  const r = roster();
  reconcileMemoryRoster(r);
  await stopWalMaintenance();
  ioBudget.setIsIdle(() => false);
  views.prepareRosterRecallViews(r);
  await views.waitForRecallConstructionIdleForTest(r);
  let held: ReturnType<typeof views.resolveRecallView> | undefined;
  for (let i = 0; i < 500 && !held; i++) { try { held = views.resolveRecallView(binding(), r); } catch { await sleep(10); } }
  expect(held, "setup: the reader's view is ready").toBeDefined();
  const handle = held!.handle, db = database();
  for (let i = 0; i < 2_000 && !views.maintainRecallViewSlice(handle); i++) await sleep(1);
  await views.waitForRecallConstructionIdleForTest(r);
  await freshMinute(30_000);
  clearActivity();
  ioBudget.setIsIdle(() => true);
  expect(ioBudget.idleQuiet(), "setup: the minute is judged idle").toBe(true);
  // a change the reader's view must apply before its guarded read: one journal row, as the record triggers write it
  db.prepare("INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record','idle-request-probe',1)").run();
  const behind = views.recallViewProjection(db, handle);
  expect(behind && behind.watermark < behind.latest, "setup: the reader's view is behind the journal").toBe(true);
  // exactly what buildMemoryBundle does while it waits (64 tries, 20 ms apart: about 1.3 s, then MEMORY_RECALL_UNAVAILABLE)
  let current = false;
  for (let i = 0; i < 60 && !current; i++) {
    views.requestRecallViewMaintenance(handle);
    await sleep(20);
    const now = views.recallViewProjection(db, handle);
    current = !!now && now.watermark >= now.latest;
  }
  expect({ current, idle: ioBudget.idleQuiet() }, "the reader's page is applied inside its wait on an idle minute, and the minute is still idle").toEqual({ current: true, idle: true });
}, 120_000);
