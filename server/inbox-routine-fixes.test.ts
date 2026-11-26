// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeInbox, inboxBadgeRequest } from "./inbox.ts";
import { InboxRoutineLifecycle, inboxRollupBadgeAccess, inboxRoutineLifecycle } from "./inbox-routine-lifecycle.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const NOW = 1_800_000_000_000, WINDOW = 14 * 86_400_000;
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function run(patch: Partial<RoutineRun> = {}): RoutineRun { return { id: "run", routineId: "routine", routineName: "Routine", botId: "bot", threadId: "thread", target: "bot", runOn: "ember", manual: true, scheduledFor: NOW, startedAt: NOW, createdAt: NOW, status: "failed", error: "401 unauthorized", ...patch }; }
function fixture(runs = [run()]) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const dir = mkdtempSync(join(tmpdir(), "murage-inbox-fix-")); cleanups.push(() => removeTempDirSync(dir));
  const file = join(dir, "routines.json"); writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs }));
  const manager = new RoutineManager({ file, now: () => NOW, botState: () => "busy", createTask: () => ({ threadId: "unused" }), startTurn: async () => {} }); cleanups.push(() => manager.stop());
  const db = new DatabaseSync(":memory:"); cleanups.push(() => db.close());
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))"); initializeInbox(db);
  const store = { isMailboxSealed: () => false, bots: [{ id: "bot", name: "Bot", threadId: "thread" }], groups: [], bot: () => ({ hidden: false }), botByThread: () => ({ hidden: false }), groupByThread: () => undefined, group: () => undefined, onChange: () => () => {} };
  const legacy = () => manager.listRuns().map(r => ({ runId: r.id, routineId: r.routineId, routineName: r.routineName, threadId: r.threadId, at: r.startedAt ?? r.scheduledFor, status: r.status, error: r.error }));
  const access = () => inboxRollupBadgeAccess(db, store, manager, legacy);
  const badge = () => (inboxBadgeRequest(db, { method: "GET", path: "/api/inbox", query: { view: "decisions", page: 0, pageSize: 1 } }, access()).body as { decisions: number }).decisions;
  const start = async () => { access(); await new Promise<void>(resolve => setImmediate(resolve)); expect(inboxRoutineLifecycle(manager)?.ready).toBe(true); };
  return { manager, db, store, legacy, access, badge, start };
}
it("rebuild accepts malformed retained scheduled times without crashing and omits invalid fact times", () => {
  const f = fixture([run({ scheduledFor: undefined as unknown as number }), run({ id: "bad", scheduledFor: "bad" as unknown as number, startedAt: undefined })]);
  let rebuild: (() => void) | undefined;
  vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: () => void) => { rebuild = callback; return {} as NodeJS.Immediate; }) as typeof setImmediate);
  const lifecycle = new InboxRoutineLifecycle(f.db, f.store, f.manager); lifecycle.start();
  expect(() => rebuild!()).not.toThrow(); expect(lifecycle.ready).toBe(true);
  expect(lifecycle.aggregate.read(NOW).map(row => row.runs)).toEqual([1]);
});
it("reports a deferred rebuild failure and permits a clean retry", async () => {
  const f = fixture(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const source = { listRuns: vi.fn().mockImplementationOnce(() => { throw new Error("fixture read failed"); }).mockReturnValue([run()]) };
  const lifecycle = new InboxRoutineLifecycle(f.db, f.store, source);
  let rebuild: (() => void) | undefined;
  const immediate = vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: () => void) => { rebuild = callback; return {} as NodeJS.Immediate; }) as typeof setImmediate);
  lifecycle.start(); expect(() => rebuild!()).not.toThrow(); expect(lifecycle.ready).toBe(false); expect(log).toHaveBeenCalledWith("inbox: routine rollup rebuild failed", expect.any(Error));
  immediate.mockRestore(); lifecycle.start(); await new Promise<void>(resolve => setImmediate(resolve)); expect(lifecycle.ready).toBe(true); expect(lifecycle.aggregate.read(NOW)[0]?.runs).toBe(1);
});
it("expired card unmasks a still current record connection badge", async () => {
  const f = fixture(); const message = { id: "card", at: NOW - 1, role: "bot", kind: "routine.run", routineRun: { runId: "run", routineId: "routine", routineName: "Routine", status: "failed", summary: "401 unauthorized" } };
  f.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", message.id, message.at, message.role, message.kind, "", JSON.stringify(message));
  await f.start(); vi.spyOn(Date, "now").mockReturnValue(NOW + WINDOW);
  expect(f.badge()).toBe(1); expect(inboxRoutineLifecycle(f.manager)!.aggregate.read(NOW + WINDOW)[0]?.runs).toBe(1);
});
it("run removal withdraws its aggregate contribution", async () => {
  const f = fixture(); await f.start(); expect(f.badge()).toBe(1);
  expect(f.manager.deleteRun("run")?.id).toBe("run"); expect(f.badge()).toBe(0);
});
it("store replacement withdraws removed and refreshes surviving aggregate members", async () => {
  const f = fixture(); await f.start(); expect(f.badge()).toBe(1);
  f.manager.runs = [run({ status: "completed", error: undefined })];
  expect(f.badge()).toBe(0); expect(inboxRoutineLifecycle(f.manager)!.aggregate.read(NOW)[0]?.runs).toBe(1);
});
it("P20 live message links change without a run revision or history rebuild", async () => {
  const f = fixture(); let listener: ((change: import("./store.ts").StoreChange) => void) | undefined;
  let messageId = "first";
  const store = { ...f.store, onChange: (fn: typeof listener) => { listener = fn; return () => {}; }, firstMessageSince: vi.fn(() => ({ id: messageId })) };
  const lifecycle = new InboxRoutineLifecycle(f.db, store, f.manager); lifecycle.start(); await new Promise<void>(resolve => setImmediate(resolve));
  const list = vi.spyOn(f.manager, "listRuns");
  expect(lifecycle.snapshot()[0]?.link?.messageId).toBe("first"); messageId = "replacement";
  listener!({ type: "message.patch", threadId: "thread", message: { id: "replacement", at: NOW, role: "bot", kind: "text", text: "Fake" } });
  expect(lifecycle.aggregate.read(NOW)[0]?.link?.messageId).toBe("replacement"); expect(lifecycle.snapshot()[0]?.link?.messageId).toBe("replacement");
  expect(list).not.toHaveBeenCalled(); expect(lifecycle.aggregate.work.rebuilt).toBe(1);
});
it("expired card suppression is reversible after a backwards clock adjustment", async () => {
  const f = fixture(); const message = { id: "clock-card", at: NOW - 1, role: "bot", kind: "routine.run", routineRun: { runId: "run", routineId: "routine", routineName: "Routine", status: "failed", summary: "401 unauthorized" } };
  f.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", message.id, message.at, message.role, message.kind, "", JSON.stringify(message)); await f.start();
  vi.spyOn(Date, "now").mockReturnValue(NOW + WINDOW); expect(f.badge()).toBe(1);
  vi.spyOn(Date, "now").mockReturnValue(NOW); expect(f.badge()).toBe(1); expect(inboxRoutineLifecycle(f.manager)!.aggregate.read(NOW)[0]?.runs).toBe(1);
});
it("large expiry batches keep badges preparing until fixed slices finish", async () => {
  const f = fixture(Array.from({ length: 200 }, (_, i) => run({ id: `run-${i}`, routineId: `routine-${i}` })));
  for (let i = 0; i < 200; i++) {
    const message = { id: `card-${i}`, at: NOW - 1, role: "bot", kind: "routine.run", routineRun: { runId: `run-${i}`, routineId: `routine-${i}`, routineName: "Routine", status: "failed", summary: "401 unauthorized" } };
    f.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", message.id, message.at, message.role, message.kind, "", JSON.stringify(message));
  }
  await f.start(); vi.spyOn(Date, "now").mockReturnValue(NOW + WINDOW);
  const lifecycle = inboxRoutineLifecycle(f.manager)!, before = lifecycle.aggregate.work.updates;
  expect(f.access().routinePreparing).toBe(true); expect(lifecycle.aggregate.work.updates - before).toBeLessThanOrEqual(64 * 2);
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.access().routinePreparing).toBe(false); expect(f.badge()).toBe(1); expect(lifecycle.aggregate.read(NOW + WINDOW)).toHaveLength(200);
});
it("P20 production record access uses maintained inputs after readiness", async () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => run({ id: `run-${i}`, scheduledFor: NOW - i })));
  await f.start();
  const source = (await import("node:fs")).readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("function inboxRoutineRuns(): InboxRoutineRun[] {"), end = source.indexOf("\nfunction legacyInboxRoutineRuns", start);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, end).replace(": InboxRoutineRun[]", "");
  const producer = (await import("./inbox-routine-lifecycle.ts")).inboxRoutineRecords;
  const legacy = vi.fn(() => { throw new Error("ready producer rebuilt retained run history"); });
  const read = new Function("inboxRoutineRecords", "database", "store", "routines", "legacyInboxRoutineRuns", `${body}; return inboxRoutineRuns;`)(producer, () => f.db, f.store, f.manager, legacy);
  const snapshots = vi.spyOn(f.manager, "listRuns"); expect(() => read()).not.toThrow(); expect(read()).toHaveLength(100); expect(read()).toHaveLength(100);
  expect(legacy).not.toHaveBeenCalled(); expect(snapshots).not.toHaveBeenCalled();
});
it("P20 changed schedule ties keep canonical list-first order", async () => {
  const f = fixture([run({ id: "older", scheduledFor: NOW - 1 }), run({ id: "newer", scheduledFor: NOW })]); await f.start();
  const lifecycle = inboxRoutineLifecycle(f.manager)!;
  expect(lifecycle.snapshot().map(run => run.runId)).toEqual(["newer", "older"]);
  const canonical = (f.manager as unknown as { runStore: Set<RoutineRun> }).runStore.values().next().value!; expect(canonical.id).toBe("older"); canonical.scheduledFor = NOW;
  (await import("./inbox-routine-lifecycle.ts")).onRunTerminal(canonical, f.manager);
  expect(lifecycle.snapshot().map(run => run.runId)).toEqual(f.manager.listRuns().map(run => run.id));
  expect(lifecycle.snapshot().map(run => run.runId)).toEqual(["older", "newer"]);
});
