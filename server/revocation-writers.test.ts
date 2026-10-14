// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 lane D (revocation, round 4): EVERY writer to messages.db that can run while a writer hold is in force (the generic
// gate in database.ts; the revocation index build no longer takes it, it writes in short slices) waits asynchronously or
// requeues without losing work: scheduler ticks, routine runs, the mutating GET /api/mobile/push/binding, background timers,
// plus the HTTP turn. None of them crashes the server, none fails terminally, and the event loop stays free.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitWriterGateForeground, DatabaseBusyError, FOREGROUND_GATE_MAX_MS, gateWriteRequest, guardedWriter, holdWritersForIndexBuild } from "./database.ts";
import { downgradeMemorySchema, migrateMemorySchema } from "./memory/schema.ts";
import { initializeMobilePush, PushStore } from "./mobile-push-store.ts";
import { mobilePushRoute, type PushRouteDeps } from "./mobile-push-routes.ts";
import { RoutineManager } from "./routines.ts";

const B = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
let dir: string, db: DatabaseSync, lockHolder: DatabaseSync | undefined;
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };

beforeEach(() => {
  rejections.length = 0; process.on("unhandledRejection", onRejection);
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "revoke-writers-"));
  db = new DatabaseSync(join(dir, "messages.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50");
  migrateMemorySchema(db, "active");
  downgradeMemorySchema(db, 7); migrateMemorySchema(db);
  initializeMobilePush(db);
  db.exec("CREATE TABLE writes(who TEXT)");
});
afterEach(async () => {
  process.off("unhandledRejection", onRejection);
  holdWritersForIndexBuild(false);
  if (lockHolder) { try { lockHolder.exec("ROLLBACK"); } catch { /* none open */ } lockHolder.close(); lockHolder = undefined; }
  try { db.close(); } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const write = (who: string) => { db.exec("BEGIN IMMEDIATE"); try { db.prepare("INSERT INTO writes VALUES(?)").run(who); db.exec("COMMIT"); } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none */ } throw e; } };
const count = (who: string) => Number((db.prepare("SELECT count(*) AS n FROM writes WHERE who=?").get(who) as { n: number }).n);
/** A writer hold in force and a raw write lock on the file for `ms` (what a long writer would do), then both released. */
async function startHold(ms: number) {
  holdWritersForIndexBuild(true);
  lockHolder = new DatabaseSync(join(dir, "messages.db"));
  lockHolder.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  expect(() => write("probe")).toThrow(/locked|busy/i);
  setTimeout(() => { try { lockHolder?.exec("COMMIT"); } catch { /* gone */ } holdWritersForIndexBuild(false); }, ms).unref();
}
function manager(over: Record<string, unknown> = {}) {
  return new RoutineManager({
    file: join(dir, "routines.json"), automaticPaused: () => false, botState: () => "ready",
    // the real createTask, onRunDispatch and startTurn all write messages.db: these doubles write the same way and do NOT gate themselves
    createTask: () => { write("create-task"); return { threadId: "task-1" }; },
    onRunDispatch: () => { write("run-marker"); },
    startTurn: vi.fn(async () => { write("routine-turn"); }),
    interruptTurn: async () => {}, emit: () => {}, ...over,
  } as unknown as ConstructorParameters<typeof RoutineManager>[0]);
}
const enqueue = (m: RoutineManager, id: string) => m.enqueueWebhook({ webhookId: `w-${id}`, webhookName: "hook", prompt: "hello", botId: "bot", runOn: "ember", deliveryId: id, receivedAt: Date.now() } as Parameters<RoutineManager["enqueueWebhook"]>[0]);

it("through a held writer lock a scheduler tick, a routine run and the push binding GET (background writers) all complete after the build: no crash, no terminal failure, loop max under 50 ms", async () => {
  const startTurn = vi.fn(async () => { write("routine-turn"); });
  const m = manager({ startTurn });
  const store = new PushStore(db);
  store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
  const deps = { store, relay: { redeem: vi.fn(), publish: vi.fn(), remove: vi.fn() }, outbox: { pending: () => ({ badge: 0, items: [] }) }, authorized: () => true,
    visible: () => true, detail: () => ({ title: "t", body: "b" }), respond: vi.fn(), now: () => Date.now() } as unknown as PushRouteDeps;
  // the mutating GET writes the token expiry on the locked database
  const realExpiry = store.setTokenExpiry.bind(store);
  store.setTokenExpiry = (id: string, at: number) => { realExpiry(id, at); write("token-expiry"); };
  await startHold(2800);
  const histogram = monitorEventLoopDelay({ resolution: 5 }); histogram.enable();
  const t0 = Date.now();
  const tick = m.tick();
  const queued = enqueue(m, "d1");
  const push = mobilePushRoute({ method: "GET", path: "/api/mobile/push/binding", headers: { "x-murage-push-device": "d1" }, readBody: async () => ({}) }, deps);
  await new Promise(res => setTimeout(res, 300));
  expect(count("routine-turn") + count("token-expiry") + count("create-task")).toBe(0); // all still waiting (background writers wait the hold out)
  const results = await Promise.all([tick, push]);
  histogram.disable();
  expect(Date.now() - t0).toBeGreaterThan(2000); // they waited for the hold, they did not run past it
  expect(results[1]).toMatchObject({ status: 200 });
  await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1), { timeout: 5000 });
  expect(count("routine-turn")).toBe(1); expect(count("token-expiry")).toBe(1);
  const final = m.listRuns().find(r => r.id === queued.id)!;
  expect(["failed", "cancelled"]).not.toContain(final.status);
  expect(final.error).toBeUndefined();
  expect(Number(histogram.max) / 1e6).toBeLessThan(50);
  expect(rejections).toEqual([]);
  m.stop();
}, 40_000);

it("a lock that still reaches a routine run (no gate, a raw writer) requeues the run instead of failing it, and it runs once the lock is gone", async () => {
  const other = new DatabaseSync(join(dir, "messages.db"));
  other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  const startTurn = vi.fn(async () => { write("routine-turn"); });
  const m = manager({ startTurn });
  try {
    const queued = enqueue(m, "r1");
    await new Promise(res => setTimeout(res, 400));
    const during = m.listRuns().find(r => r.id === queued.id)!;
    expect(["failed", "cancelled"]).not.toContain(during.status);
    expect(startTurn).not.toHaveBeenCalled();
    other.exec("COMMIT");
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(count("routine-turn")).toBe(1);
  } finally { try { other.exec("ROLLBACK"); } catch { /* committed */ } other.close(); m.stop(); }
  expect(rejections).toEqual([]);
}, 20_000);

it("a failing scheduler tick never rejects (the timer calls it as void), busy or not", async () => {
  const create = vi.fn()
    .mockImplementationOnce(() => { throw new DatabaseBusyError("create-task", 1000); })
    .mockImplementationOnce(() => { throw new Error("disk exploded"); })
    .mockImplementation(() => ({ threadId: "task-1" }));
  const m = manager({ createTask: create });
  enqueue(m, "u1");
  await expect(m.tick()).resolves.toBeUndefined();
  await expect(m.tick()).resolves.toBeUndefined();
  await new Promise(res => setTimeout(res, 50));
  expect(rejections).toEqual([]);
  m.stop();
});

it("the push binding GET reports a failed expiry write instead of success, and a writer hold makes it wait", async () => {
  const store = new PushStore(db);
  store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
  store.setTokenExpiry = () => { throw new DatabaseBusyError("push-expiry", 1000); };
  const deps = { store, relay: {}, outbox: { pending: () => ({ badge: 0, items: [] }) }, authorized: () => true, visible: () => true, detail: () => ({}), respond: vi.fn(), now: () => 5000 } as unknown as PushRouteDeps;
  const res = await mobilePushRoute({ method: "GET", path: "/api/mobile/push/binding", headers: { "x-murage-push-device": "d1" }, readBody: async () => ({}) }, deps);
  expect(res?.status).toBe(503);
  expect(res?.body).toMatchObject({ code: "busy" });
});

it("a guarded background writer waits for the hold, never stacks, and swallows a busy failure", async () => {
  holdWritersForIndexBuild(true);
  const body = vi.fn(() => { write("sweep"); });
  const tick = guardedWriter("test-sweep", body);
  const first = tick(); const second = tick(); const third = tick();
  await new Promise(res => setTimeout(res, 100));
  expect(body).not.toHaveBeenCalled();
  holdWritersForIndexBuild(false);
  await Promise.all([first, second, third]);
  expect(body).toHaveBeenCalledTimes(1);
  await guardedWriter("busy", () => { throw new DatabaseBusyError("x", 1); })();
  await guardedWriter("boom", () => { throw new Error("x"); })();
  expect(rejections).toEqual([]);
});

it("an owner write during a writer hold waits no longer than the bound, then goes on and meets the lock as a retryable busy, never a hang", async () => {
  holdWritersForIndexBuild(true); // never released by anyone
  const t0 = Date.now();
  await gateWriteRequest("POST");
  const waited = Date.now() - t0;
  expect(waited).toBeGreaterThanOrEqual(FOREGROUND_GATE_MAX_MS - 100);
  expect(waited).toBeLessThan(FOREGROUND_GATE_MAX_MS + 1500);
  const t1 = Date.now();
  await gateWriteRequest("GET"); // reads never wait
  expect(Date.now() - t1).toBeLessThan(50);
}, 15_000);

it("a hold released while a write waits lets that write go at once", async () => {
  holdWritersForIndexBuild(true);
  setTimeout(() => holdWritersForIndexBuild(false), 200).unref();
  const t0 = Date.now();
  await awaitWriterGateForeground();
  expect(Date.now() - t0).toBeLessThan(FOREGROUND_GATE_MAX_MS);
  write("after-hold"); expect(count("after-hold")).toBe(1);
});

it("a foreground write with no hold in force costs nothing and never waits", async () => {
  const t0 = Date.now();
  await gateWriteRequest("POST"); await awaitWriterGateForeground();
  expect(Date.now() - t0).toBeLessThan(50);
});
