// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 lane D (revocation, round 9): the bus keeps RAM bounded by slowing its producers (nothing is written to a side file),
// a project card's result stays owed until it is delivered (restart, long locks), and the memory-echo marker survives a
// failed terminal write.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { EVENTS_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { DatabaseBusyError, isDatabaseBusy } from "./database.ts";
import { memoryEchoDecision } from "./fold-steps.ts";
import { createGuardedCompletion } from "./guarded-completion.ts";
import { EventBus } from "./harness/bus.ts";
import { createProjectCardExecutor } from "./project-card-executor.ts";
import { createProjectCard, enqueueCardRun } from "./project-cards.ts";
import { applyCardRunEffect, cardGenerationCurrent } from "./project-turn-engine.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { createWorkAdmission } from "./work-admission.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const busy = () => new DatabaseBusyError("x", 0);
const ev = (threadId: string, n: number) => ({ eventId: `${threadId}-e${n}`, provider: "fake", threadId, createdAt: "2026-10-10T00:00:00Z", type: "item.completed", text: `${threadId}:${n}` }) as unknown as RuntimeEvent;
const tick = (ms = 10) => new Promise<void>(resolve => setTimeout(resolve, ms));

function newBus(limits: Parameters<EventBus["setDeliveryLimits"]>[0]) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const bus = new EventBus(() => {});
  bus.setDeliveryLimits({ batch: 5, retryMinMs: 5, retryMaxMs: 10, ...limits });
  let overflows = 0;
  bus.gateDeliveries({ held: () => false, wait: async () => {}, isBusy: isDatabaseBusy, overflow: () => { overflows++; } });
  return { bus, overflows: () => overflows };
}

it("no side file: nothing the bus holds is ever written next to the data directory", async () => {
  const { bus } = newBus({ maxEvents: 3 });
  let locked = true; const seen: string[] = [];
  bus.subscribe(event => { if (locked) throw busy(); seen.push((event as any).text); });
  for (let n = 0; n < 12; n++) bus.publish(ev("th", n));
  expect(existsSync(join(dirname(EVENTS_DIR), "bus-spill"))).toBe(false);
  expect((bus as any).spillDir).toBeUndefined();
  locked = false;
  await vi.waitFor(() => expect(seen).toHaveLength(12), { timeout: 5000 });
  expect(existsSync(join(dirname(EVENTS_DIR), "bus-spill"))).toBe(false);
});

it("the cap holds across ten blocked threads: producers that honour the valve never put more than the cap in RAM, and every event arrives in thread order", async () => {
  const { bus, overflows } = newBus({ maxEvents: 6, maxBytes: 10_000_000 });
  let locked = true; const seen = new Map<string, number[]>(); let peak = 0;
  bus.subscribe(event => { if (locked) throw busy(); const [t, n] = String((event as any).text).split(":"); (seen.get(t!) ?? seen.set(t!, []).get(t!)!).push(Number(n)); });
  const perThread = 8, threads = Array.from({ length: 10 }, (_, i) => `th${i}`);
  const producers = threads.map(async (t) => {
    for (let n = 0; n < perThread; n++) {
      while (!bus.valve.isOpen(t)) await bus.valve.whenOpen(t);
      bus.publish(ev(t, n)); // checked and published in the same tick
      peak = Math.max(peak, bus.pendingDurable());
      await tick(0);
    }
  });
  await tick(100);
  expect(peak).toBeLessThanOrEqual(6);
  expect(bus.pendingDurable()).toBeLessThanOrEqual(6);
  expect(overflows()).toBe(1);           // reaching the cap released the writer hold once
  locked = false;
  await Promise.all(producers);
  await vi.waitFor(() => expect(bus.pendingDurable()).toBe(0), { timeout: 5000 });
  expect(peak).toBeLessThanOrEqual(6);
  for (const t of threads) expect(seen.get(t)).toEqual(Array.from({ length: perThread }, (_, n) => n));
});

it("a stdout stream is paused at the cap, resumed below the low-water mark, and nothing is lost or reordered", async () => {
  const { bus } = newBus({ maxEvents: 4 });
  let locked = true; const seen: number[] = [];
  bus.subscribe(event => { if (locked) throw busy(); seen.push(Number((event as any).text.split(":")[1])); });
  const stream = new PassThrough();
  const drop = bus.valve.register("th", stream);
  let next = 0;
  stream.on("data", (chunk: Buffer) => { for (const _ of chunk.toString().split("\n").filter(Boolean)) bus.publish(ev("th", next++)); });
  for (let i = 0; i < 20; i++) stream.write("x\n");
  await tick(50);
  expect(bus.valve.pausedCount()).toBe(1);
  const heldWhilePaused = next;
  expect(heldWhilePaused).toBeLessThan(20);   // the rest stayed in the pipe, not in the bus
  expect(bus.pendingDurable()).toBeLessThanOrEqual(heldWhilePaused);
  locked = false;
  await vi.waitFor(() => expect(seen).toHaveLength(20), { timeout: 5000 });
  expect(seen).toEqual(Array.from({ length: 20 }, (_, n) => n));
  expect(bus.valve.pausedCount()).toBe(0);
  drop();
});

it("a thread blocked on a lock does not stop the others: they keep delivering while it waits, and no thread may take more than half the cap", async () => {
  const { bus } = newBus({ maxEvents: 6 });
  let stuck = true; const seen: string[] = [];
  bus.subscribe(event => { if (event.threadId === "A" && stuck) throw busy(); seen.push(String((event as any).text)); });
  const a = new PassThrough(), b = new PassThrough();
  bus.valve.register("A", a); bus.valve.register("B", b);
  let na = 0, nb = 0;
  a.on("data", (c: Buffer) => { for (const _ of c.toString().split("\n").filter(Boolean)) bus.publish(ev("A", na++)); });
  b.on("data", (c: Buffer) => { for (const _ of c.toString().split("\n").filter(Boolean)) bus.publish(ev("B", nb++)); });
  for (let i = 0; i < 30; i++) a.write("x\n");
  await tick(30);
  expect(bus.valve.isOpen("A")).toBe(false);          // A is held at its share (3 of 6)
  expect(bus.pendingDurable()).toBeLessThanOrEqual(6);
  expect(bus.valve.isOpen("B")).toBe(true);           // B is not
  for (let i = 0; i < 10; i++) b.write("x\n");
  await vi.waitFor(() => expect(seen.filter(s => s.startsWith("B:"))).toHaveLength(10), { timeout: 3000 });
  stuck = false;
  await vi.waitFor(() => expect(seen.filter(s => s.startsWith("A:"))).toHaveLength(30), { timeout: 5000 });
  expect(seen.filter(s => s.startsWith("A:"))).toEqual(Array.from({ length: 30 }, (_, n) => `A:${n}`));
});

it("a producer that cannot be paused waits for capacity instead", async () => {
  const { bus } = newBus({ maxEvents: 2 });
  let locked = true;
  bus.subscribe(() => { if (locked) throw busy(); });
  bus.publish(ev("x", 0)); bus.publish(ev("x", 1));
  let released = false;
  const waiting = bus.valve.whenOpen("y").then(() => { released = true; });
  await tick(30);
  expect(released).toBe(false);
  locked = false;
  await waiting;
  expect(released).toBe(true);
});

// ---- project card delivery -----------------------------------------------------------------------------------------

function cardWorld() {
  const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  db.exec("INSERT INTO project_settings(group_id,mode,lead_bot_id,updated_at) VALUES('g','ongoing','lead',1)");
  let now = 10000;
  const make = (redeliver?: (request: any, payload: string | null) => void) => {
    const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false,
      speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }),
      askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => now });
    admission.setBudgetGate({ check: () => ({ ok: true }) });
    const hooks = { restartCards: vi.fn(), cardGenerationCurrent, cardEffect: (d: DatabaseSync, r: any) => applyCardRunEffect(d, r, { memberIds: ["lead", "jax"], now }), returnThread: () => "room" };
    const executor = createProjectCardExecutor({ db: () => db, admission, now: () => now, open: () => true,
      context: () => ({ groupId: "g", isProject: true, closed: false, runState: "running", mode: "ongoing", leadBotId: "lead", boardOn: true, parallelCards: 1 }),
      usable: () => true, desk: (r) => `desk-${r.toBotId}`, writerRoot: () => undefined, start: vi.fn(), hooks, changed: vi.fn(), redeliver });
    return { executor, admission };
  };
  const first = make();
  const made = createProjectCard(db, { groupId: "g", title: "Reconcile", assigneeBotId: "jax", actor: { kind: "owner" }, memberIds: ["lead", "jax"], now });
  if (!made.ok) throw new Error(made.reason);
  const queued = enqueueCardRun(db, { cardId: made.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now });
  if (!queued.ok) throw new Error(queued.reason);
  db.prepare("UPDATE room_requests SET return_bot_id='lead' WHERE id=?").run(queued.requestId);
  return { db, make, first, requestId: queued.requestId };
}
const owedCount = (db: DatabaseSync, id: string) => Number((db.prepare("SELECT COUNT(*) AS n FROM project_card_delivery_owed WHERE request_id=?").get(id) as any).n);

it("a delivery owed at a restart is made by the boot sweep, once, and then no longer owed", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const w = cardWorld();
  try {
    w.first.executor.pump();
    // the first process dies before its delivery ran (a delivery that fails for good leaves the same trace)
    w.first.executor.finish(w.requestId, { ok: true, resultMessageId: "r", owedPayload: JSON.stringify({ reviewNonce: "n" }), deliver: () => { throw new Error("process gone"); } });
    expect(owedCount(w.db, w.requestId)).toBe(1);
    w.first.executor.stop();
    const redeliver = vi.fn();
    const second = w.make(redeliver);
    second.executor.pump();
    expect(redeliver).toHaveBeenCalledTimes(1);
    expect(redeliver.mock.calls[0]![0].id).toBe(w.requestId);
    expect(redeliver.mock.calls[0]![1]).toBe(JSON.stringify({ reviewNonce: "n" }));
    expect(owedCount(w.db, w.requestId)).toBe(0);
    second.executor.pump();
    expect(redeliver).toHaveBeenCalledTimes(1);
    second.executor.stop();
  } finally { w.db.close(); }
});

it("the owed row is written in the same savepoint as the terminal state: a failed terminal write leaves neither", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const w = cardWorld();
  try {
    w.first.executor.pump();
    w.db.exec("CREATE TRIGGER block_done BEFORE UPDATE OF state ON room_requests WHEN NEW.state='done' BEGIN SELECT RAISE(ABORT,'blocked'); END");
    expect(() => w.first.executor.finish(w.requestId, { ok: true, resultMessageId: "r", deliver: () => {} })).toThrow();
    expect(owedCount(w.db, w.requestId)).toBe(0);
    w.db.exec("DROP TRIGGER block_done");
    w.first.executor.stop();
  } finally { w.db.close(); }
});

it("a later finish does not skip a delivery that is still owed", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const w = cardWorld();
  try {
    w.first.executor.pump();
    w.first.executor.finish(w.requestId, { ok: true, resultMessageId: "r", deliver: () => { throw new Error("cannot"); } });
    expect(owedCount(w.db, w.requestId)).toBe(1);
    const deliver = vi.fn();
    w.first.executor.finish(w.requestId, { ok: true, resultMessageId: "r", deliver });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(owedCount(w.db, w.requestId)).toBe(0);
    w.first.executor.stop();
  } finally { w.db.close(); }
});

it("a lock that outlasts 600 retries still holds the claim and the delivery stays owed until it goes through", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const w = cardWorld();
  try {
    w.first.executor.pump();
    const claims = JSON.stringify(w.first.admission);
    let calls = 0;
    const deliver = vi.fn(() => { calls++; if (calls <= 700) throw busy(); });
    w.first.executor.finish(w.requestId, { ok: true, resultMessageId: "r", deliver });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(deliver).toHaveBeenCalledTimes(701);
    expect(owedCount(w.db, w.requestId)).toBe(0);
    expect(JSON.stringify(w.first.admission)).toBe(claims);
    w.first.executor.stop();
  } finally { w.db.close(); }
});

it("the follow-up of a guarded completion is retried through any number of locks before the claim is released", () => {
  const timers: Array<() => void> = []; const calls: string[] = []; let fails = 1000;
  const run = createGuardedCompletion<string, string>({
    write: () => "done", follow: () => { if (fails-- > 0) throw busy(); calls.push("follow"); },
    unsubscribe: () => {}, release: () => calls.push("release"), isBusy: isDatabaseBusy, schedule: fn => timers.push(fn),
  });
  run.attempt("e");
  for (let i = 0; i < 1000; i++) { expect(calls).toEqual([]); timers.shift()!(); }
  expect(calls).toEqual(["follow", "release"]);
});

// ---- memory echo ----------------------------------------------------------------------------------------------------

it("the memory-echo outcome stays failed across a redelivery after a failed terminal write", () => {
  const marker = { turnId: "t1", text: "{}" };
  const state = { succeeded: true, hasReply: () => false };
  const first = memoryEchoDecision(marker, { turnId: "t1" }, state);
  expect(first.echoOnly).toBe(true);
  // the terminal write met a lock; the marker was NOT consumed, so the redelivery decides the same
  const again = memoryEchoDecision(marker, { turnId: "t1" }, { succeeded: true, hasReply: () => true });
  expect(again.echoOnly).toBe(true);
  expect(again.marker).toBe(marker);
});

it("a marker left by another turn is not this turn's, and a turn that really answered is not an echo", () => {
  expect(memoryEchoDecision({ turnId: "old", text: "{}" }, { turnId: "new" }, { succeeded: true, hasReply: () => false })).toEqual({ marker: undefined, echoOnly: false });
  expect(memoryEchoDecision({ turnId: "t", text: "{}" }, { turnId: "t" }, { succeeded: true, hasReply: () => true }).echoOnly).toBe(false);
  expect(memoryEchoDecision(undefined, { turnId: "t" }, { succeeded: true, hasReply: () => false }).echoOnly).toBe(false);
});

it("startup removal of a leftover spill directory is wired", async () => {
  const { readFileSync } = await import("node:fs");
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "index.ts"), "utf8");
  expect(source).toMatch(/rmSync\(join\(DATA_DIR, "bus-spill"\), \{ recursive: true, force: true \}\)/);
  expect(readdirSync(join(here, "harness")).filter(f => f === "bus.ts")).toHaveLength(1);
  expect(readFileSync(join(here, "harness", "bus.ts"), "utf8")).not.toMatch(/appendFileSync\(state|bus-spill|mkdirSync/);
});

it("the lane's server modules load under Node's strip-only TypeScript mode (no parameter properties or enums)", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripTypeScriptTypes } = await import("node:module");
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ["fold-steps.ts", "guarded-completion.ts", "project-card-executor.ts", "project-card-delivery-schema.ts", "harness/bus.ts", "harness/intake.ts"]) {
    expect(() => stripTypeScriptTypes(readFileSync(join(here, file), "utf8")), file).not.toThrow();
  }
});
