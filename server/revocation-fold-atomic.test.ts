// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 lane D (revocation, round 7): a reply and the links that tie it to what it rests on are ONE transaction (a locked
// database mid-fold leaves nothing, and the redelivery writes exactly one copy), the bus keeps per-thread order with the failed
// listener and every listener after it, the queue is bounded with a release of the writer hold, and one stuck thread never
// blocks the others.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection, RuntimeEvent } from "./contracts.ts";
import { closeDatabase, database, DatabaseBusyError, isDatabaseBusy } from "./database.ts";
import { EventBus } from "./harness/bus.ts";
import { outputRootsFor, recordOutputRoots, replayExclusions, thawRootSetWritesForTest } from "./memory/replay-lineage.ts";
import { reconcileMemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  thawRootSetWritesForTest(true); // the link here is a root-set row (a 1.0.1 file's rows); root sets are frozen on v10 otherwise
});
afterEach(() => { thawRootSetWritesForTest(false); vi.restoreAllMocks(); });

const ev = (threadId: string, eventId: string, type = "item.completed") => ({ eventId, provider: "fake", threadId, turnId: "turn-1", createdAt: "2026-10-10T00:00:00Z", type }) as unknown as RuntimeEvent;
const busy = () => new DatabaseBusyError("fold", 0);

it("busy after the message write, before the disclosure link: nothing is left, and the retry leaves exactly one message with its links", () => {
  setMemoryMode("active");
  const store = new Store(selection);
  const bot = store.createBot({}, { seedMessages: false });
  const threadId = bot.threadId;
  reconcileMemoryRoster({ bots: [{ id: bot.id, threadId }], groups: [] });
  const before = store.messagesFor(threadId).length;
  const roots = { roots: new Set([`${threadId}/root-1`]), over: false };
  let failures = 1;
  const link = (written: { id: string }) => {
    recordOutputRoots(threadId, written.id, roots);   // the message is already written when this runs
    if (failures-- > 0) throw busy();                 // ...and the next link write meets a lock
  };
  expect(() => store.appendMessage(threadId, { role: "bot", kind: "text", text: "reply" }, "ev-1", link)).toThrow(DatabaseBusyError);
  expect(store.messagesFor(threadId)).toHaveLength(before);                                       // not cached
  expect(database().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id=?").get(threadId, "ev-1")?.n).toBe(0); // not stored
  expect(database().prepare("SELECT COUNT(*) AS n FROM memory_output_roots WHERE thread_id=?").get(threadId)?.n).toBe(0);        // no orphan link
  const first = store.appendMessage(threadId, { role: "bot", kind: "text", text: "reply" }, "ev-1", link);
  const again = store.appendMessage(threadId, { role: "bot", kind: "text", text: "reply" }, "ev-1", link); // a redelivery after the commit
  expect(again.id).toBe(first.id);
  expect(store.messagesFor(threadId)).toHaveLength(before + 1);
  expect(database().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND text='reply'").get(threadId)?.n).toBe(1);
  expect(database().prepare("SELECT COUNT(*) AS n FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(threadId, "ev-1")?.n).toBe(1);
});

it("a reply whose root is revoked is withheld; the single retried copy carries its roots", () => {
  setMemoryMode("active");
  const store = new Store(selection);
  const bot = store.createBot({}, { seedMessages: false });
  const threadId = bot.threadId;
  let fail = true;
  const link = (written: { id: string }) => { recordOutputRoots(threadId, written.id, outputRootsFor(LineageAllowance.tool(1_000_000_000), [])); if (fail) { fail = false; throw busy(); } };
  expect(() => store.appendMessage(threadId, { role: "bot", kind: "text", text: "x" }, "ev-2", link)).toThrow();
  const message = store.appendMessage(threadId, { role: "bot", kind: "text", text: "x" }, "ev-2", link);
  expect(store.messagesFor(threadId).filter(m => m.text === "x")).toHaveLength(1);
  expect([...replayExclusions(LineageAllowance.tool(1_000_000_000), threadId, [{ id: message.id, role: "bot" }], null, { failClosed: true })]).toEqual([]);
});

it("a busy listener keeps itself AND every listener after it in front of the next event of that thread", async () => {
  const bus = new EventBus(); bus.omitLog(() => true);
  bus.setDeliveryLimits({ retryMinMs: 5, retryMaxMs: 20 });
  bus.gateDeliveries({ held: () => false, wait: async () => {}, isBusy: isDatabaseBusy });
  const order: string[] = []; let fail = 2;
  bus.subscribe(e => { if (fail-- > 0) throw busy(); order.push(`fold:${e.eventId}`); });
  bus.subscribe(e => { order.push(`after:${e.eventId}`); });
  bus.publish(ev("t1", "a")); bus.publish(ev("t1", "b"));
  expect(order).toEqual([]);
  await vi.waitFor(() => expect(order).toEqual(["fold:a", "after:a", "fold:b", "after:b"]), { timeout: 3000 });
  expect(bus.pendingDurable()).toBe(0);
});

it("a thread whose head stays busy does not hold up other threads", async () => {
  const bus = new EventBus(); bus.omitLog(() => true);
  bus.setDeliveryLimits({ retryMinMs: 5, retryMaxMs: 20 });
  bus.gateDeliveries({ held: () => false, wait: async () => {}, isBusy: isDatabaseBusy });
  const seen: string[] = []; let stuck = true;
  bus.subscribe(e => { if (e.threadId === "stuck" && stuck) throw busy(); seen.push(`${e.threadId}:${e.eventId}`); });
  bus.publish(ev("stuck", "s1")); bus.publish(ev("other", "o1")); bus.publish(ev("other", "o2")); bus.publish(ev("stuck", "s2"));
  await vi.waitFor(() => expect(seen).toEqual(["other:o1", "other:o2"]), { timeout: 3000 });
  expect(bus.pendingDurable()).toBe(2);
  stuck = false;
  await vi.waitFor(() => expect(seen.slice(2)).toEqual(["stuck:s1", "stuck:s2"]), { timeout: 3000 });
});

it("past the queue bound the writer hold is released (the build defers) instead of buffering without limit; events still arrive in order", async () => {
  const bus = new EventBus(); bus.omitLog(() => true);
  bus.setDeliveryLimits({ maxEvents: 5, maxBytes: 1_000_000 });
  let held = true, overflows = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  bus.gateDeliveries({ held: () => held, wait: () => gate, isBusy: isDatabaseBusy, overflow: () => { overflows++; held = false; release(); } });
  const seen: string[] = []; bus.subscribe(e => { seen.push(e.eventId); });
  for (let i = 0; i < 6; i++) bus.publish(ev("t1", `e${i}`));
  expect(overflows).toBe(1);
  await vi.waitFor(() => expect(seen).toEqual(["e0", "e1", "e2", "e3", "e4", "e5"]), { timeout: 3000 });
  expect(bus.pendingDurable()).toBe(0);
  for (let i = 0; i < 3; i++) bus.publish(ev("t1", `f${i}`)); // delivered at once; nothing queues
  expect(bus.pendingDurable()).toBe(0);
  expect(overflows).toBe(1);
});

it("the byte bound trips on a few large events", () => {
  const bus = new EventBus(); bus.omitLog(() => true);
  bus.setDeliveryLimits({ maxEvents: 1000, maxBytes: 10_000 });
  let overflows = 0;
  bus.gateDeliveries({ held: () => true, wait: () => new Promise<void>(() => {}), isBusy: isDatabaseBusy, overflow: () => { overflows++; } });
  bus.subscribe(() => {});
  for (let i = 0; i < 3; i++) bus.publish({ ...ev("t1", `big${i}`), text: "x".repeat(6_000) } as unknown as RuntimeEvent);
  expect(overflows).toBe(1);
});

import { createGuardedCompletion } from "./guarded-completion.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";

it("a completion write that meets a lock leaves the run unfinished and subscribed, is retried, and only then releases the claim", () => {
  const timers: Array<() => void> = []; const calls: string[] = [];
  let writeFails = 2, followFails = 1;
  const run = createGuardedCompletion<string, string>({
    write: () => { calls.push("write"); if (writeFails-- > 0) throw busy(); return "done"; },
    follow: () => { calls.push("follow"); if (followFails-- > 0) throw busy(); },
    unsubscribe: () => calls.push("unsubscribe"), release: () => calls.push("release"), isBusy: isDatabaseBusy, schedule: fn => timers.push(fn),
  });
  expect(() => run.attempt("turn.completed")).toThrow(DatabaseBusyError);   // the bus would redeliver to the listener
  expect(run.isFinished()).toBe(false); expect(calls).toEqual(["write"]);   // not finished, not unsubscribed, claim held
  expect(() => run.attempt("turn.completed")).toThrow(DatabaseBusyError);
  run.attempt("turn.completed");                                             // the write commits
  expect(run.isFinished()).toBe(true);
  expect(calls).toEqual(["write", "write", "write", "unsubscribe", "follow"]); // follow-up locked: claim still held
  timers.shift()!();
  expect(calls.at(-2)).toBe("follow"); expect(calls.at(-1)).toBe("release");
  run.attempt("turn.completed");                                             // a late duplicate does nothing
  expect(calls.filter(c => c === "release")).toHaveLength(1);
});

it("finish() from a non-listener caller retries on a timer instead of throwing a lock", () => {
  const timers: Array<() => void> = []; let fails = 1; const calls: string[] = [];
  const run = createGuardedCompletion<string, string>({ write: () => { if (fails-- > 0) throw busy(); return "d"; }, follow: () => {}, unsubscribe: () => {}, release: () => calls.push("release"), isBusy: isDatabaseBusy, schedule: fn => timers.push(fn) });
  run.finish(undefined, "not approved");
  expect(calls).toEqual([]); expect(timers).toHaveLength(1);
  timers.shift()!();
  expect(calls).toEqual(["release"]);
});
