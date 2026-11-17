// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readRoutineRuns } from "./routine-runs-journal.ts";
import { RoutineManager, routineWorkCounters } from "./routines.ts";
import { collectionWorkProbe } from "./testing/collection-work-probe.ts";
import { routineHistoryFixture } from "./testing/routine-history-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [], managers: RoutineManager[] = [];
function fixtureDir() { const dir = mkdtempSync(join(tmpdir(), "murage-work-gate-")); dirs.push(dir); return dir; }
afterEach(() => { for (const manager of managers.splice(0)) manager.stop(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
for (const size of [100, 2000, 2500]) it(`P1/P3/P32 ${size} reachable retained dispatch history: idle tick has zero retained callback/iterator visits`, async () => {
  const fixture = await routineHistoryFixture(fixtureDir(), size); managers.push(fixture.manager);
  const probe = collectionWorkProbe(); probe.discover(fixture.manager, "manager");
  for (const key of ["runsMaterialized", "fullCommits", "recoverySaves", "fullVerifiers", "storeTraversals"] as const) routineWorkCounters[key] = 0;
  probe.install(); try { await fixture.manager.tick(); await Promise.resolve(); } finally { probe.uninstall(); }
  for (const key of ["runsMaterialized", "fullCommits", "recoverySaves", "fullVerifiers", "storeTraversals"] as const) expect(routineWorkCounters[key], key).toBe(0);
  const history = probe.counts["manager.liveDispatch"];
  expect(history?.forEachVisit ?? 0, "retained dispatch forEach visits").toBe(0);
  expect(history?.next ?? 0, "retained dispatch iterator visits").toBe(0);
  expect(probe.counts["manager.runStore"]?.next ?? 0, "store history traversal").toBe(0);
  expect(probe.counts["manager._runs"]?.numericRead ?? 0, "array history traversal").toBe(0);
  const unclassified = Object.values(probe.counts.other ?? {}).reduce((sum, n) => sum + n, 0);
  expect(unclassified, "idle unclassified work with ten definitions").toBeLessThanOrEqual(256);
  console.info("routine_work", JSON.stringify({ phase: "idle", history: size, unclassified, fullCommits: routineWorkCounters.fullCommits, runsMaterialized: routineWorkCounters.runsMaterialized, retainedIteratorVisits: history?.next ?? 0, retainedCallbackVisits: history?.forEachVisit ?? 0 }));
}, 180_000);

it("P9 approval wait timeout never calls a full transaction or full save", async () => {
  const fixture = await routineHistoryFixture(fixtureDir(), 100); managers.push(fixture.manager);
  fixture.clock.now += 5 * 60_000; await fixture.manager.tick();
  const thread = fixture.dispatched[0].threadId;
  fixture.manager.handleRuntimeEvent(fixture.event(thread, "request.opened", { requestId: "wait", summary: "Waiting" }));
  expect(fixture.manager.listRuns().find(run => run.threadId === thread)?.status).toBe("waiting");
  fixture.clock.now += 61 * 60_000;
  const internals = fixture.manager as unknown as { commitMutation: (...args: unknown[]) => unknown; saveFull: () => void };
  const fullCommit = vi.spyOn(internals, "commitMutation"), fullSave = vi.spyOn(internals, "saveFull");
  await fixture.manager.tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(fullCommit.mock.calls.length, "fullCommits in timeout").toBe(0);
  expect(fullSave.mock.calls.length, "saveFull in timeout").toBe(0);
  expect((readRoutineRuns(dirs.at(-1)!) as Array<{threadId?:string;status:string}>).find(run => run.threadId === thread)?.status, "raw timeout persistence").toBe("needs-you");
}, 60_000);

it("P23/P28 exactly 2500 protected receipts retire 32 per tick, tolerate clock rollback, and converge at tick sixteen", async () => {
  const fixture = await routineHistoryFixture(fixtureDir(), 2500); managers.push(fixture.manager);
  const core = fixture.manager as unknown as { runStore: Set<{ id: string }>; verifyIndexes(): string[] };
  const original = [...core.runStore].map(run => run.id);
  for (const routine of fixture.definitions) fixture.manager.update(routine.id, { enabled: false });
  expect(core.runStore.size).toBe(2500);
  const protectedTime = fixture.clock.now, expiredTime = protectedTime + 24 * 60 * 60_000 + 1;
  fixture.clock.now = expiredTime;
  const removed: string[] = [];
  for (let slice = 0; slice < 16; slice++) {
    const before = new Set([...core.runStore].map(run => run.id));
    for (const key of ["retired", "expiryServiced", "runsMaterialized", "fullCommits", "recoverySaves", "fullVerifiers", "storeTraversals"] as const) routineWorkCounters[key] = 0;
    await fixture.manager.tick();
    expect(routineWorkCounters.retired).toBe(slice < 15 ? 32 : 20);
    expect(routineWorkCounters.expiryServiced).toBeLessThanOrEqual(routineWorkCounters.retired);
    for (const key of ["runsMaterialized", "fullCommits", "recoverySaves", "fullVerifiers", "storeTraversals"] as const) expect(routineWorkCounters[key], key).toBe(0);
    const after = new Set([...core.runStore].map(run => run.id));
    const victims = [...before].filter(id => !after.has(id));
    removed.push(...victims);
    expect(victims.length, `slice ${slice + 1}`).toBe(slice < 15 ? 32 : 20);
    expect(core.runStore.size).toBe(2500 - Math.min(500, (slice + 1) * 32));
    if (slice === 0) {
      fixture.clock.now = protectedTime; await fixture.manager.tick();
      expect(core.runStore.size, "clock rollback restores holds").toBe(2468);
      fixture.clock.now = expiredTime;
    }
    console.info("routine_work", JSON.stringify({ phase: "expiry", tick: slice + 1, retired: victims.length, remaining: core.runStore.size, expiryServiced: routineWorkCounters.expiryServiced }));
    expect(core.verifyIndexes()).toEqual([]);
  }
  expect(removed).toEqual(original.slice(0, 500)); expect(core.runStore.size).toBe(2000);
}, 180_000);

it("P23 eligible pre-save scoped append retires zero unrelated victims", async () => {
  const fixture = await routineHistoryFixture(fixtureDir(), 2500); managers.push(fixture.manager);
  for (const routine of fixture.definitions) fixture.manager.update(routine.id, { enabled: false });
  fixture.clock.now += 24 * 60 * 60_000 + 1;
  const core = fixture.manager as unknown as { runStore: Set<{ id: string }>; commitMutation: (...args: unknown[]) => unknown };
  const old = new Set([...core.runStore].map(run => run.id));
  const full = vi.spyOn(core, "commitMutation");
  routineWorkCounters.retired = 0;
  fixture.manager.enqueueWebhook({ webhookId: "gate-webhook", webhookName: "Gate", prompt: "Fake", botId: "fixture-bot-0", runOn: "ember", deliveryId: "gate-delivery", receivedAt: fixture.clock.now });
  expect(full.mock.calls.length, "scoped ingress full commits").toBe(0);
  expect(routineWorkCounters.retired, "scoped ingress retired").toBe(0);
  expect(core.runStore.size, "scoped ingress retirement is zero").toBe(2501);
  expect([...core.runStore].filter(run => old.has(run.id))).toHaveLength(2500);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(routineWorkCounters.retired, "carried follow-up maintenance token").toBeLessThanOrEqual(32);
}, 180_000);
