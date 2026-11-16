// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeInbox, inboxBadgeRequest, type InboxRoutineRun } from "./inbox.ts";
import { inboxAccessFor, type InboxRosterStore } from "./inbox-access.ts";
import { inboxRollupBadgeAccess, inboxRoutineLifecycle } from "./inbox-routine-lifecycle.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { ROUTINE_DAY_MS as DAY } from "./inbox-routine-aggregate.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";

const NOW = 1_800_000_000_000, cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Evaluate the actual production function, including its source/access choice
 * and preparing-badge behavior. Importing all index.ts would boot unrelated
 * real adapters. The dependencies below are only the fixture's fake services. */
function productionBadge(db: DatabaseSync, store: InboxRosterStore, manager: RoutineManager, legacy: () => InboxRoutineRun[]) {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function pushBadge(): number {"), source.indexOf("\nconst pushOutbox:", source.indexOf("function pushBadge(): number {")))
    .replace("function pushBadge(): number", "function pushBadge()")
    .replaceAll(" as { preparing?: boolean }", "").replaceAll(" as { decisions?: number }", "");
  return new Function("database", "store", "routines", "inboxRoutineRuns", "inboxAccessFor", "inboxRollupBadgeAccess", "inboxBadgeRequest", `let lastPushBadge = 0; ${body}; return pushBadge;`)
    (() => db, store, manager, legacy, inboxAccessFor, inboxRollupBadgeAccess, inboxBadgeRequest) as () => number;
}
async function fixture(size: number) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const dir = mkdtempSync(join(tmpdir(), "murage-rollup-production-")); cleanups.push(() => removeTempDirSync(dir));
  const file = join(dir, "routines.json");
  const runs: RoutineRun[] = Array.from({ length: size }, (_, i) => ({
    id: `run-${i}`, routineId: `routine-${i}`, routineName: `Routine ${i}`, botId: "bot", threadId: "thread", target: "bot", runOn: "ember", manual: true,
    scheduledFor: NOW - i % 14 * DAY, startedAt: NOW - i % 14 * DAY, createdAt: NOW - i % 14 * DAY,
    status: "completed", finishedAt: NOW - i % 14 * DAY,
  }));
  writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs }));
  const manager = new RoutineManager({ file, now: () => NOW, botState: () => "ready", createTask: () => ({ threadId: "thread" }), startTurn: async () => {} });
  cleanups.push(() => manager.stop());
  const routine = manager.create({ name: "Active", prompt: "Fake only", botId: "bot", target: "bot", runOn: "ember", enabled: false,
    schedule: { type: "interval", everyMinutes: 30, anchorAt: NOW }, attachments: [] });
  manager.runNow(routine.id);
  await manager.tick();
  const db = new DatabaseSync(":memory:"); cleanups.push(() => db.close());
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  const store = { bots: [{ id: "bot", name: "Bot", threadId: "thread" }], groups: [], bot: () => ({ hidden: false }), groupByThread: () => undefined, group: () => undefined,
    botByThread: () => ({ hidden: false }), onChange: () => () => {},
  };
  const legacy = vi.fn(() => manager.listRuns().map(run => ({ runId: run.id, routineId: run.routineId, routineName: run.routineName, threadId: run.threadId,
    status: run.status, at: run.startedAt ?? run.scheduledFor, error: run.error, attention: run.attention })));
  const badge = productionBadge(db, store, manager, legacy);
  expect(badge()).toBe(0); // not ready: startup fallback
  await new Promise<void>(resolve => setImmediate(resolve));
  const lifecycle = inboxRoutineLifecycle(manager)!;
  expect(lifecycle.ready).toBe(true);
  expect(lifecycle.aggregate.work.rebuilt).toBe(1);
  const oracle = () => inboxBadgeRequest(db, { method: "GET", path: "/api/inbox", query: { view: "decisions", page: 0, pageSize: 1 } }, { ...inboxAccessFor(store, "companion"), routineRuns: legacy() }, { cache: true });
  return { manager, badge, legacy, lifecycle, oracle, file, store, db, routine };
}

it("real pushBadge counts terminal transitions and recovery exactly like the old rollup", async () => {
  const { manager, badge, oracle, lifecycle, routine } = await fixture(100);
  expect(badge()).toBe(0);
  manager.failThread("thread", "401 unauthorized");
  expect(badge()).toBe(1);
  expect(badge()).toBe(Number((oracle().body as { decisions: number }).decisions));
  expect(lifecycle.aggregate.work.rebuilt).toBe(1);
  // A repeated terminal notification is an upsert, never a second failure.
  manager.failThread("thread", "401 unauthorized");
  expect(lifecycle.aggregate.read(NOW).find(row => row.routineKey === `routine:${routine.id}`)).toMatchObject({ runs: 1, failed: 1 });
  manager.runNow(routine.id);
  await manager.tick();
  manager.handleRuntimeEvent({ eventId: "recovered", provider: "fake", threadId: "thread", createdAt: new Date(NOW).toISOString(), type: "turn.completed", ok: true });
  expect(badge()).toBe(0);
  expect(badge()).toBe(Number((oracle().body as { decisions: number }).decisions));
  expect(lifecycle.aggregate.work.rebuilt).toBe(1);

});

it("real pushBadge does fixed work at 100 and 2,000 runs after ready, including cache misses", async () => {
  const counts = [];
  for (const size of [100, 2_000]) {
    const { manager, badge, legacy, lifecycle, db } = await fixture(size);
    manager.failThread("thread", "401 unauthorized");
    bumpMessagesVersion();
    const calls = legacy.mock.calls.length, before = lifecycle.aggregate.work.nodes;
    const list = vi.spyOn(manager, "listRuns");
    const original = Map.prototype[Symbol.iterator]; let visits = 0;
    const sql = vi.spyOn(db, "prepare");
    const iterator = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
      const it = original.call(this), next = it.next;
      it.next = () => { const result = next.call(it); if (!result.done) visits++; return result; }; return it;
    });
    let value: number;
    try { value = badge(); } finally { iterator.mockRestore(); }
    const snapshots = list.mock.calls.length; list.mockRestore();
    expect(value!).toBe(1);
    expect(snapshots).toBe(0);
    expect(legacy.mock.calls.length - calls).toBe(0);
    expect(lifecycle.aggregate.work.rebuilt).toBe(1);
    counts.push({ nodes: lifecycle.aggregate.work.nodes - before, visits, sql: sql.mock.calls.length });
    sql.mockRestore();
  }
  console.info("production-badge-work", JSON.stringify({ sizes: [100, 2_000], counts }));
  expect(counts[0]).toEqual(counts[1]);
  expect(counts[1]!.nodes).toBe(1);
  expect(counts[1]!.visits).toBe(0);
});

it("reconstructs the production rollup once from the real manager journal on restart", async () => {
  const { manager, badge, file, store, db } = await fixture(100);
  manager.failThread("thread", "401 unauthorized");
  expect(badge()).toBe(1);
  manager.stop();
  const restarted = new RoutineManager({ file, now: () => NOW, botState: () => "busy", createTask: () => ({ threadId: "unused" }), startTurn: async () => {} });
  cleanups.push(() => restarted.stop());
  const legacy = vi.fn(() => restarted.listRuns().map(run => ({ runId: run.id, routineId: run.routineId, routineName: run.routineName,
    threadId: run.threadId, status: run.status, at: run.startedAt ?? run.scheduledFor, error: run.error })));
  const again = productionBadge(db, store, restarted, legacy);
  expect(again()).toBe(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(inboxRoutineLifecycle(restarted)!.aggregate.work.rebuilt).toBe(1);
  legacy.mockClear();
  expect(again()).toBe(1); expect(again()).toBe(1);
  expect(legacy).not.toHaveBeenCalled();
  expect(inboxRoutineLifecycle(restarted)!.aggregate.work.rebuilt).toBe(1);
});
