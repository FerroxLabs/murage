// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls 1.0.9, design 5.5: the push outbox's call paths. ringCall / noteCall, resolveCall ("may have rung"), the exclusive
// claim plus the in-flight set (F60), sendNow in parallel ahead of the batch (F15), and the dispatch fence.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PushStore, initializeMobilePush } from "./mobile-push-store.ts";
import { CALL_NOTE_TTL_MS, PushOutbox, SEND_NOW_TIMEOUT_MS, type OutboxWorld, type PushSender, type SendResult } from "./mobile-push-outbox.ts";
import { collapseKey } from "./mobile-push-keys.ts";
import type { RelayEvent } from "../shared/mobile-push.ts";

const B1 = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const B2 = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
const INTENT = "intent-1";
const START = 1_000_000;
const RING_END = START + 45_000;

type Held = { binding: string; event: RelayEvent; signal: AbortSignal; settle: (r: SendResult) => void };
function setup(o: { world?: Partial<OutboxWorld>; send?: PushSender["publish"]; ringing?: () => boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  initializeMobilePush(db);
  const store = new PushStore(db);
  store.putBinding({ bindingId: B1, deviceId: "d1", publisherToken: "murage_pt_1", createdAt: 1 });
  store.putBinding({ bindingId: B2, deviceId: "d2", publisherToken: "murage_pt_2", createdAt: 2 });
  let now = START;
  let refs = 0;
  const sender = { publish: vi.fn(o.send ?? (async () => "accepted" as SendResult)) };
  const ringing = o.ringing ?? (() => true);
  const world: OutboxWorld = {
    visible: () => true, present: () => false, badge: () => 0, latestMessageId: () => "m-last",
    stillPending: () => true, risk: () => "low", timeSensitive: () => false, actionable: () => true,
    callRinging: () => ringing(), ...o.world,
  };
  const outbox = new PushOutbox({ store, world, sender, now: () => now, randomRef: () => (++refs).toString(16).padStart(64, "0") });
  const rows = (where = "1=1") => db.prepare(`SELECT kind, category, binding_id AS bindingId, state, attempts, resolved_by AS resolvedBy, expires_at AS expiresAt FROM push_events WHERE ${where} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
  return { db, store, outbox, sender, rows, tick: (ms: number) => { now += ms; }, now: () => now };
}
/** A sender that holds every send until the test settles it. */
function heldSender() {
  const held: Held[] = [];
  const publish: PushSender["publish"] = (binding, event, signal) => new Promise<SendResult>((settle) => { held.push({ binding: binding.bindingId, event, signal, settle }); });
  return { held, publish };
}
const ring = { intentId: INTENT, botId: "scout", threadId: "t1", expiresAt: RING_END };
const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

afterEach(() => { vi.useRealTimers(); });

describe("ringCall and noteCall", () => {
  it("rings only the phones that ring for calls: due now, never held even at the desk, expiring at the ring's end", () => {
    const t = setup({ world: { present: () => true } });
    t.store.setRingsForCalls(B2, false);
    expect(t.outbox.ringCall(ring)).toBe(1);
    const row = t.store.latestForRequest(B1, INTENT)!;
    expect(row).toMatchObject({ kind: "call", category: "call", state: "pending", requestId: INTENT, messageId: null, expiresAt: RING_END,
      holdUntil: START, nextAttemptAt: START, attempts: 0, timeSensitive: true, collapseKey: collapseKey(t.store.keySecret(B1)!, INTENT) });
    expect(t.store.latestForRequest(B2, INTENT)).toBeNull();
  });
  it("writes nothing for a thread the phones cannot see, or a ring already over", () => {
    expect(setup({ world: { visible: () => false } }).outbox.ringCall(ring)).toBe(0);
    expect(setup().outbox.ringCall({ ...ring, expiresAt: START })).toBe(0);
  });
  it("enqueue() refuses the call kinds, so a ring is never held or fanned out by the generic path", () => {
    const t = setup();
    expect(t.outbox.enqueue({ kind: "call", botId: "scout", threadId: "t1", requestId: INTENT })).toBe(0);
    expect(t.outbox.enqueue({ kind: "call-note", botId: "scout", threadId: "t1", requestId: INTENT })).toBe(0);
    expect(t.rows()).toEqual([]);
  });
  it("a note goes to every phone (rings for calls or not) for 12 h, never held, and collapses apart from the ring", () => {
    const t = setup({ world: { present: () => true } });
    t.store.setRingsForCalls(B2, false);
    expect(t.outbox.noteCall({ intentId: INTENT, botId: "scout", threadId: "t1" })).toBe(2);
    const note = t.store.latestForRequest(B1, INTENT)!;
    expect(note).toMatchObject({ kind: "call-note", category: "call-note", state: "pending", expiresAt: START + CALL_NOTE_TTL_MS, timeSensitive: false });
    expect(note.collapseKey).not.toBe(collapseKey(t.store.keySecret(B1)!, INTENT));
  });
});

describe("the dispatch fence", () => {
  it("sends a ring while its intent is ringing", async () => {
    const t = setup();
    t.outbox.ringCall(ring);
    await t.outbox.flush();
    expect(t.sender.publish).toHaveBeenCalledTimes(2);
    expect(t.sender.publish.mock.calls[0][1]).toMatchObject({ category: "call", expiresAt: RING_END });
  });
  it("drops a ring, unsent, once the intent is not ringing, and in both paths", async () => {
    let ringing = true;
    const t = setup({ ringing: () => ringing });
    t.outbox.ringCall(ring);
    ringing = false;
    await t.outbox.sendNow(INTENT);
    expect(t.sender.publish).not.toHaveBeenCalled();
    expect(t.rows().map((r) => r.state)).toEqual(["dropped", "dropped"]);
    const u = setup({ ringing: () => false });
    u.outbox.ringCall(ring);
    await u.outbox.flush();
    expect(u.sender.publish).not.toHaveBeenCalled();
    expect(u.rows().map((r) => r.state)).toEqual(["dropped", "dropped"]);
  });
  it("fails closed: a world with no answer, or one that throws, never rings", async () => {
    const t = setup({ world: { callRinging: undefined } });
    t.outbox.ringCall(ring);
    await t.outbox.flush();
    const u = setup({ ringing: () => { throw new Error("db"); } });
    u.outbox.ringCall(ring);
    await u.outbox.sendNow(INTENT);
    expect(t.sender.publish).not.toHaveBeenCalled();
    expect(u.sender.publish).not.toHaveBeenCalled();
  });
  it("drops a ring past its own expiry even while the world still says ringing", async () => {
    const t = setup();
    t.outbox.ringCall(ring);
    t.tick(45_000);
    await t.outbox.sendNow(INTENT);
    expect(t.sender.publish).not.toHaveBeenCalled();
  });
  it("never fences a note", async () => {
    const t = setup({ ringing: () => false });
    t.outbox.noteCall({ intentId: INTENT, botId: "scout", threadId: "t1" });
    await t.outbox.sendNow(INTENT);
    expect(t.sender.publish).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCall", () => {
  it("F13: a ring never attempted is dropped, no phone is told anything, and the claim then fails", async () => {
    const t = setup();
    t.outbox.ringCall(ring);
    expect(t.outbox.resolveCall("t1", INTENT, "stopped")).toBe(0);
    expect(t.rows()).toEqual([
      expect.objectContaining({ category: "call", state: "dropped", resolvedBy: "dismissed" }),
      expect.objectContaining({ category: "call", state: "dropped", resolvedBy: "dismissed" }),
    ]);
    await t.outbox.flush();
    await t.outbox.sendNow(INTENT);
    expect(t.sender.publish).not.toHaveBeenCalled();
  });
  it("F11: a ring claimed whose acknowledgement was lost still gets a resolved revision (may have rung)", async () => {
    const t = setup({ send: async () => "retry" });
    t.outbox.ringCall(ring);
    await t.outbox.sendNow(INTENT);
    expect(t.rows().map((r) => [r.state, r.attempts])).toEqual([["pending", 1], ["pending", 1]]);
    expect(t.outbox.resolveCall("t1", INTENT, "missed")).toBe(2);
    expect(t.rows("category='resolved'")).toEqual([
      expect.objectContaining({ kind: "call", bindingId: B1, state: "pending", resolvedBy: "dismissed", expiresAt: START + CALL_NOTE_TTL_MS }),
      expect.objectContaining({ kind: "call", bindingId: B2, state: "pending", resolvedBy: "dismissed", expiresAt: START + CALL_NOTE_TTL_MS }),
    ]);
    expect(t.rows("category='call'").map((r) => r.state)).toEqual(["dropped", "dropped"]);
  });
  it("tells only the phones that may have rung, maps answered to elsewhere, and is idempotent", async () => {
    const t = setup();
    t.outbox.ringCall(ring);
    const b1 = t.store.latestForRequest(B1, INTENT)!;
    expect(t.store.claim(b1.eventRef, b1, { state: "sent", attempts: 1, nextAttemptAt: START })).toBe(true);
    expect(t.outbox.resolveCall("t1", INTENT, "answered")).toBe(1);
    const resolved = t.store.latestForRequest(B1, INTENT)!;
    expect(resolved).toMatchObject({ category: "resolved", resolvedBy: "elsewhere", collapseKey: b1.collapseKey, revision: b1.revision + 1 });
    expect(t.store.latestForRequest(B2, INTENT)).toMatchObject({ category: "call", state: "dropped" });
    expect(t.outbox.resolveCall("t1", INTENT, "stopped")).toBe(0);
    expect(t.rows("category='resolved'")).toHaveLength(1);
  });
  it("a resolved revision lives at least as long as the ring it replaces", () => {
    const t = setup();
    t.outbox.ringCall({ ...ring, expiresAt: START + 2 * CALL_NOTE_TTL_MS });
    const b1 = t.store.latestForRequest(B1, INTENT)!;
    t.store.claim(b1.eventRef, b1, { state: "pending", attempts: 1, nextAttemptAt: START });
    t.outbox.resolveCall("t1", INTENT, "declined");
    expect(t.store.latestForRequest(B1, INTENT)!.expiresAt).toBe(START + 2 * CALL_NOTE_TTL_MS);
  });
  it("F12: a stop during the send owes the resolution at once; the late accept changes nothing", async () => {
    const s = heldSender();
    const t = setup({ send: s.publish });
    t.outbox.ringCall(ring);
    const sending = t.outbox.sendNow(INTENT);
    await flushMicrotasks();
    expect(s.held).toHaveLength(2);
    expect(t.outbox.resolveCall("t1", INTENT, "stopped")).toBe(2);
    for (const h of s.held) h.settle("accepted");
    await sending;
    expect(t.rows("category='call'").map((r) => r.state)).toEqual(["dropped", "dropped"]);
    expect(t.rows("category='resolved'")).toHaveLength(2);
  });
  it("leaves the call's notes alone, and dropCallNotes drops only that bot's unsent notes", async () => {
    const t = setup();
    t.outbox.ringCall(ring);
    t.outbox.noteCall({ intentId: INTENT, botId: "scout", threadId: "t1" });
    t.outbox.noteCall({ intentId: "intent-2", botId: "ember", threadId: "t2" });
    t.outbox.resolveCall("t1", INTENT, "missed");
    expect(t.rows("kind='call-note'").map((r) => r.state)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(t.outbox.dropCallNotes("scout")).toBe(2);
    expect(t.rows("kind='call-note'").map((r) => r.state)).toEqual(["dropped", "dropped", "pending", "pending"]);
  });
});

describe("the exclusive claim and sendNow", () => {
  it("the claim wins only on the state AND attempt count the caller read", () => {
    const t = setup();
    t.outbox.ringCall(ring);
    const row = t.store.latestForRequest(B1, INTENT)!;
    expect(t.store.claim(row.eventRef, row, { state: "pending", attempts: 1, nextAttemptAt: START + 1000 })).toBe(true);
    expect(t.store.claim(row.eventRef, row, { state: "pending", attempts: 1, nextAttemptAt: START + 1000 })).toBe(false);
  });
  it("F60: run() and sendNow reaching the same ring row send it once", async () => {
    const s = heldSender();
    const t = setup({ send: s.publish });
    t.outbox.ringCall(ring);
    const batch = t.outbox.flush();
    const now = t.outbox.sendNow(INTENT);
    await flushMicrotasks();
    // The batch claimed B1's row and is waiting on it; sendNow took B2's and skipped the one in flight.
    expect(s.held.map((h) => h.binding).sort()).toEqual([B1, B2].sort());
    // A retry pass while both are on the wire claims nothing more, even with the backoff passed.
    t.tick(5_000);
    const again = t.outbox.sendNow(INTENT);
    await flushMicrotasks();
    expect(s.held).toHaveLength(2);
    for (const h of s.held) h.settle("accepted");
    await Promise.all([batch, now, again]);
    expect(t.sender.publish).toHaveBeenCalledTimes(2);
    expect(t.rows().map((r) => [r.state, r.attempts])).toEqual([["sent", 1], ["sent", 1]]);
  });
  it("F15: with 30 unrelated rows due and the batch stuck, sendNow starts the ring at once, every phone in parallel", async () => {
    const s = heldSender();
    const t = setup({ send: s.publish });
    for (let i = 0; i < 15; i++) t.outbox.enqueue({ kind: "question", botId: "scout", threadId: "t9", requestId: `q-${i}` });
    const batch = t.outbox.flush();
    await flushMicrotasks();
    expect(s.held).toHaveLength(1);
    t.outbox.ringCall(ring);
    const sending = t.outbox.sendNow(INTENT);
    await flushMicrotasks();
    expect(s.held.filter((h) => h.event.category === "call").map((h) => h.binding)).toEqual([B1, B2]);
    for (const h of s.held.filter((x) => x.event.category === "call")) h.settle("accepted");
    expect(await sending).toEqual({ attempted: 2 });
    // let the batch finish
    const drain = setInterval(() => { for (const h of s.held) h.settle("accepted"); }, 1);
    await batch;
    clearInterval(drain);
  });
  it("sendNow gives each send 5 s, then aborts it, and run() retries it later", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const t = setup({ send: (_b, _e, signal) => new Promise<SendResult>((settle) => { signals.push(signal); signal.addEventListener("abort", () => settle("retry")); }) });
    t.outbox.ringCall(ring);
    const sending = t.outbox.sendNow(INTENT);
    await vi.advanceTimersByTimeAsync(SEND_NOW_TIMEOUT_MS - 1);
    expect(signals.map((s) => s.aborted)).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    expect(await sending).toEqual({ attempted: 2 });
    expect(t.rows().map((r) => [r.state, r.attempts])).toEqual([["pending", 1], ["pending", 1]]);
  });
  it("sendNow touches only the request's own due rows", async () => {
    const t = setup();
    t.outbox.enqueue({ kind: "question", botId: "scout", threadId: "t9", requestId: "q-1" });
    t.outbox.ringCall(ring);
    expect(await t.outbox.sendNow(INTENT)).toEqual({ attempted: 2 });
    expect(t.sender.publish.mock.calls.every((c) => c[1].category === "call")).toBe(true);
    expect(await t.outbox.sendNow(INTENT)).toEqual({ attempted: 0 });
  });
});

describe("existing push kinds under the exclusive claim (4c risk check)", () => {
  it("a question row is delivered exactly once per phone while two runs and two sendNows race over it", async () => {
    const hold = heldSender();
    const calls: string[] = [];
    const publish: PushSender["publish"] = (binding, event, signal) => { calls.push(binding.bindingId); return hold.publish(binding, event, signal); };
    const t = setup({ send: publish });
    expect(t.outbox.enqueue({ kind: "question", botId: "scout", threadId: "t1", requestId: "q-1" })).toBe(2);
    // a second outbox on the same store has its own in-flight set, so only the store's claim (state + attempts) keeps it out
    const other = new PushOutbox({ store: t.store, world: {
      visible: () => true, present: () => false, badge: () => 0, latestMessageId: () => "m-last",
      stillPending: () => true, risk: () => "low", timeSensitive: () => false, actionable: () => true,
    }, sender: { publish }, now: t.now });
    const racing = [t.outbox.flush(), other.flush(), t.outbox.sendNow("q-1"), other.sendNow("q-1")];
    for (let i = 0; i < 6; i++) { await flushMicrotasks(); for (const h of hold.held.splice(0)) h.settle("accepted"); }
    await Promise.all(racing);
    expect([...calls].sort()).toEqual([B1, B2].sort());
    expect(t.rows("kind='question'")).toEqual([
      expect.objectContaining({ bindingId: B1, state: "sent", attempts: 1 }),
      expect.objectContaining({ bindingId: B2, state: "sent", attempts: 1 }),
    ]);
    t.tick(10 * 60_000);
    await t.outbox.flush(); await other.flush();
    expect(calls).toHaveLength(2);
  });
});
