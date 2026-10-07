import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { PushStore, initializeMobilePush, type PushEventRow } from "./mobile-push-store.ts";
import { PushOutbox, type OutboxWorld, type PushSender, type SendResult } from "./mobile-push-outbox.ts";
import { collapseKey } from "./mobile-push-keys.ts";
import { parseRelayEvent } from "../shared/mobile-push.ts";
import { PUSH_TOKEN_TTL_MS } from "../companion/src/devices.ts";

const B1 = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const B2 = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
function setup(world: Partial<OutboxWorld> = {}, send: PushSender["publish"] = async () => "accepted", onExhausted?: (row: PushEventRow) => void) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  initializeMobilePush(db);
  const store = new PushStore(db);
  store.putBinding({ bindingId: B1, deviceId: "d1", publisherToken: "murage_pt_1", createdAt: 1 });
  store.putBinding({ bindingId: B2, deviceId: "d2", publisherToken: "murage_pt_2", createdAt: 2 });
  let now = 1_000_000;
  let refs = 0;
  const sender = { publish: vi.fn(send) };
  const w: OutboxWorld = {
    visible: () => true, present: () => false, badge: () => 2, latestMessageId: () => "m-last",
    stillPending: () => true, risk: () => "low", timeSensitive: () => true, actionable: () => true, ...world,
  };
  const outbox = new PushOutbox({ store, world: w, sender, now: () => now, randomRef: () => (++refs).toString(16).padStart(64, "0"), ...(onExhausted ? { onExhausted } : {}) });
  return { store, outbox, sender, tick: (ms: number) => { now += ms; }, now: () => now };
}
const approval = { kind: "approval" as const, botId: "scout", threadId: "t1", requestId: "req-1", messageId: "m1" };

describe("PushOutbox", () => {
  // RES-009: the server's own record of when a binding's token pair expires.
  it("does not publish to a binding whose token pair has expired, and does not retry it", async () => {
    const t = setup();
    t.store.setTokenExpiry(B1, t.now() + 5_000);
    t.outbox.enqueue(approval);
    t.tick(5_000);
    await t.outbox.flush();
    expect(t.sender.publish.mock.calls.map((c) => c[0].bindingId)).toEqual([B2]);
    expect(t.store.latestForRequest(B1, "req-1")?.state).toBe("dropped");
    t.tick(60_000);
    await t.outbox.flush();
    expect(t.sender.publish).toHaveBeenCalledTimes(1);
  });

  it("publishes to a binding with a live pair, and to one with no recorded expiry", async () => {
    const t = setup();
    t.store.setTokenExpiry(B1, t.now() + 1);
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    expect(t.sender.publish.mock.calls.map((c) => c[0].bindingId).sort()).toEqual([B1, B2].sort());
  });

  it("an expired binding does not use up the flush for the others", async () => {
    const t = setup();
    t.store.setTokenExpiry(B1, t.now());
    for (let n = 0; n < 3; n++) t.outbox.enqueue({ ...approval, requestId: `req-${n}` });
    await t.outbox.flush();
    expect(t.sender.publish.mock.calls.filter((c) => c[0].bindingId === B2)).toHaveLength(3);
    expect(t.sender.publish.mock.calls.filter((c) => c[0].bindingId === B1)).toHaveLength(0);
  });

  it("uses the same token lifetime the companion issues", () => {
    expect(PUSH_TOKEN_TTL_MS).toBe(30 * 24 * 3600_000);
  });

  it("queues one content-free event per binding and sends exactly the relay contract", async () => {
    const t = setup();
    expect(t.outbox.enqueue(approval)).toBe(2);
    await t.outbox.flush();
    expect(t.sender.publish).toHaveBeenCalledTimes(2);
    const [binding, event] = t.sender.publish.mock.calls[0];
    expect(binding.bindingId).toBe(B1);
    expect(parseRelayEvent(event)).toEqual(event);
    expect(event).toMatchObject({ category: "approval", revision: 1, workspaceBadge: 2, collapseKey: collapseKey(t.store.keySecret(B1)!, "req-1"), timeSensitive: true });
    expect(JSON.stringify(event)).not.toMatch(/scout|t1|req-1|m1/);
  });

  it("skips a thread this device cannot see", () => {
    const t = setup({ visible: () => false });
    expect(t.outbox.enqueue(approval)).toBe(0);
  });

  it("marks a risky or unrated approval approval-open", async () => {
    const t = setup({ risk: () => "unrated" });
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    expect(t.sender.publish.mock.calls[0][1].category).toBe("approval-open");
  });

  it("a routine or skill proposal is Open only, whatever its rating", async () => {
    const t = setup({ actionable: () => false });
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    expect(t.sender.publish.mock.calls[0][1].category).toBe("question");
  });

  it("drops done while you are at your desk (R5)", () => {
    const t = setup({ present: () => true });
    expect(t.outbox.enqueue({ kind: "done", botId: "scout", threadId: "t1" })).toBe(0);
  });

  it("holds attention while present, then sends if still unanswered", async () => {
    const t = setup({ present: () => true });
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    expect(t.sender.publish).not.toHaveBeenCalled();
    t.tick(120_000);
    await t.outbox.flush();
    expect(t.sender.publish).toHaveBeenCalledTimes(2);
  });

  it("a held approval answered at the desk is dropped, not sent", async () => {
    let pending = true;
    const t = setup({ present: () => true, stillPending: () => pending });
    t.outbox.enqueue(approval);
    pending = false;
    t.tick(120_000);
    await t.outbox.flush();
    expect(t.sender.publish).not.toHaveBeenCalled();
    expect(t.store.latestForRequest(B1, "req-1")?.state).toBe("dropped");
  });

  it("resolve replaces with the same collapse key and a higher revision, never held", async () => {
    const t = setup();
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    expect(t.outbox.resolve("t1", "req-1", "desktop")).toBe(2);
    await t.outbox.flush();
    const resolved = t.sender.publish.mock.calls[2][1];
    expect(resolved).toMatchObject({ category: "resolved", revision: 2, collapseKey: collapseKey(t.store.keySecret(B1)!, "req-1"), timeSensitive: false });
  });

  it("resolving something never sent drops it instead of sending a replacement", async () => {
    const t = setup({ present: () => true });
    t.outbox.enqueue(approval);
    expect(t.outbox.resolve("t1", "req-1", "desktop")).toBe(0);
    t.tick(200_000);
    await t.outbox.flush();
    expect(t.sender.publish).not.toHaveBeenCalled();
  });

  it("resolve after a failed attempt drops the original and it is never retried (only the resolved push goes out)", async () => {
    const t = setup({}, async () => "retry");
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    expect(t.store.latestForRequest(B1, "req-1")).toMatchObject({ state: "pending", attempts: 1 });
    expect(t.outbox.resolve("t1", "req-1", "desktop")).toBe(0);
    expect(t.store.latestForRequest(B1, "req-1")?.state).toBe("dropped");
    t.sender.publish.mockClear();
    t.tick(200_000);
    await t.outbox.flush();
    expect(t.sender.publish).not.toHaveBeenCalled();
  });

  it("a resolve during an in-flight publish that then lands owes the phone the resolved replacement", async () => {
    let land!: (r: SendResult) => void;
    const inFlight = new Promise<SendResult>((r) => { land = r; });
    const t = setup({}, (binding) => (binding.bindingId === B1 ? inFlight : Promise.resolve("retry")));
    t.outbox.enqueue(approval);
    const flushing = t.outbox.flush();
    // The pre-send write already ran synchronously; flush() is now suspended
    // on the in-flight publish. The resolve drops the row (not yet sent)...
    expect(t.outbox.resolve("t1", "req-1", "elsewhere")).toBe(0);
    // ...but the relay accepted it, so the phone will show it: replace it.
    land("accepted");
    await flushing;
    const latest = t.store.latestForRequest(B1, "req-1");
    expect(latest).toMatchObject({ category: "resolved", state: "pending", revision: 2, resolvedBy: "elsewhere", collapseKey: collapseKey(t.store.keySecret(B1)!, "req-1") });
    // B2's row never landed (its send was dropped mid-batch): nothing to replace.
    expect(t.store.latestForRequest(B2, "req-1")).toMatchObject({ category: "approval", state: "dropped" });
    t.sender.publish.mockClear();
    await t.outbox.flush();
    expect(t.sender.publish).toHaveBeenCalledTimes(1);
    expect(t.sender.publish.mock.calls[0][1]).toMatchObject({ category: "resolved", revision: 2, collapseKey: collapseKey(t.store.keySecret(B1)!, "req-1") });
  });

  it("a resolve during an in-flight publish that does not land keeps the drop", async () => {
    let land!: (r: SendResult) => void;
    const inFlight = new Promise<SendResult>((r) => { land = r; });
    const t = setup({}, () => inFlight);
    t.outbox.enqueue(approval);
    const flushing = t.outbox.flush();
    expect(t.outbox.resolve("t1", "req-1", "desktop")).toBe(0);
    land("retry");
    await flushing;
    expect(t.store.latestForRequest(B1, "req-1")).toMatchObject({ category: "approval", state: "dropped" });
  });

  const resolvedRows = (t: ReturnType<typeof setup>, bindingId: string) =>
    (t.store as unknown as { db: import("node:sqlite").DatabaseSync }).db
      .prepare("SELECT revision, state, category FROM push_events WHERE binding_id=? AND category='resolved'").all(bindingId);

  it("a resolve replaces an earlier revision already on the phone when the newest one has not landed", async () => {
    // The re-reviewer's N1: revision 1 sent, revision 2 retrying, then answered.
    let fail = false;
    const t = setup({}, async () => (fail ? "retry" : "accepted"));
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    fail = true;
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    expect(t.store.latestForRequest(B1, "req-1")).toMatchObject({ revision: 2, state: "pending", attempts: 1 });
    expect(t.outbox.resolve("t1", "req-1", "desktop")).toBe(2);
    expect(resolvedRows(t, B1)).toEqual([{ revision: 3, state: "pending", category: "resolved" }]);
    const latest = t.store.latestForRequest(B1, "req-1");
    expect(latest).toMatchObject({ category: "resolved", revision: 3, resolvedBy: "desktop", collapseKey: collapseKey(t.store.keySecret(B1)!, "req-1") });
    fail = false;
    t.sender.publish.mockClear();
    t.tick(120_000);
    await t.outbox.flush();
    // Only the resolutions go: revision 2 was dropped, never sent.
    expect(t.sender.publish.mock.calls.map(([, e]) => e.category)).toEqual(["resolved", "resolved"]);
    expect(resolvedRows(t, B1)).toHaveLength(1);
  });

  it("an earlier revision on the wire when the resolve lands is dropped too, and replaced once if it lands", async () => {
    let land!: (r: SendResult) => void;
    const t = setup({}, (binding, event) => (binding.bindingId === B1 && event.revision === 1 ? new Promise<SendResult>((r) => { land = r; }) : Promise.resolve("retry")));
    t.outbox.enqueue(approval);
    const flushing = t.outbox.flush();
    t.outbox.enqueue(approval); // revision 2, not yet sent
    expect(t.outbox.resolve("t1", "req-1", "elsewhere")).toBe(0);
    land("accepted");
    await flushing;
    expect(resolvedRows(t, B1)).toEqual([{ revision: 3, state: "pending", category: "resolved" }]);
    expect(t.store.latestForRequest(B1, "req-1")).toMatchObject({ category: "resolved", resolvedBy: "elsewhere" });
  });

  it("a late accept after the resolve already replaced the request adds no second replacement", async () => {
    // Revision 1 is on the phone, revision 2 is on the wire when the resolve
    // comes: the resolve replaces revision 1 at once, and revision 2 landing
    // afterwards must not add another.
    let land!: (r: SendResult) => void;
    let second = false;
    const t = setup({}, (binding) => {
      if (binding.bindingId !== B1) return Promise.resolve("accepted");
      if (!second) return Promise.resolve("accepted");
      return new Promise<SendResult>((r) => { land = r; });
    });
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    second = true;
    t.outbox.enqueue(approval);
    const flushing = t.outbox.flush();
    await Promise.resolve();
    expect(t.outbox.resolve("t1", "req-1", "desktop")).toBeGreaterThanOrEqual(1);
    land("accepted");
    await flushing;
    expect(resolvedRows(t, B1)).toHaveLength(1);
  });

  it("a resolve triggered during an earlier row's send drops a not-yet-attempted row before its own turn", async () => {
    const t = setup({}, async (binding) => {
      if (binding.bindingId === B1) t.outbox.resolve("t1", "req-1", "desktop");
      return "accepted";
    });
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    // B1 sent (and triggered the resolve mid-batch); B2 was still "pending",
    // untouched, when that resolve ran, so it must be dropped before its own
    // turn: never published, never attempted.
    expect(t.sender.publish).toHaveBeenCalledTimes(1);
    expect(t.sender.publish.mock.calls[0][0].bindingId).toBe(B1);
    expect(t.store.latestForRequest(B2, "req-1")).toMatchObject({ state: "dropped", attempts: 0 });
  });

  it("a done without a message id carries the thread's latest one", () => {
    const t = setup();
    t.outbox.enqueue({ kind: "done", botId: "scout", threadId: "t1" });
    const ref = (1).toString(16).padStart(64, "0");
    expect(t.store.event(B1, ref)?.messageId).toBe("m-last");
  });

  it("a transient failure backs off (doubling, capped at five minutes) until the event expires, and is never exhausted", async () => {
    const t = setup({}, async () => "retry");
    t.outbox.enqueue({ ...approval });
    const startedAt = t.now();
    const gaps: number[] = [];
    let last = -1;
    for (let i = 0; i < 1000 && t.now() < startedAt + 12 * 3600_000 - 1; i++) {
      const before = t.sender.publish.mock.calls.filter(([b]) => b.bindingId === B1).length;
      await t.outbox.flush();
      const after = t.sender.publish.mock.calls.filter(([b]) => b.bindingId === B1).length;
      if (after > before) { if (last >= 0) gaps.push(t.now() - last); last = t.now(); }
      t.tick(1000);
    }
    const state = t.store.latestForRequest(B1, "req-1")?.state;
    expect(state).toBe("pending");
    expect(gaps.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(Math.max(...gaps)).toBe(300_000);
  });

  it("a transient failure is still retried after the old six-attempt window", async () => {
    const t = setup({}, async () => "retry");
    t.outbox.enqueue({ ...approval });
    for (let i = 0; i < 12; i++) { await t.outbox.flush(); t.tick(300_000); }
    expect(t.sender.publish.mock.calls.filter(([b]) => b.bindingId === B1).length).toBeGreaterThan(6);
    expect(t.store.latestForRequest(B1, "req-1")?.state).toBe("pending");
  });

  it("stops retrying once the event has expired", async () => {
    const t = setup({}, async () => "retry");
    t.outbox.enqueue({ ...approval });
    await t.outbox.flush();
    t.tick(13 * 3600_000);
    const calls = t.sender.publish.mock.calls.length;
    await t.outbox.flush();
    expect(t.sender.publish.mock.calls.length).toBe(calls);
  });

  it("a relay rejection is final: exhausted at once, and the owner is told", async () => {
    const onExhausted = vi.fn();
    const t = setup({}, async (binding) => (binding.bindingId === B1 ? "rejected" : "accepted"), onExhausted);
    t.outbox.enqueue({ ...approval });
    await t.outbox.flush();
    t.tick(60_000);
    await t.outbox.flush();
    expect(t.sender.publish.mock.calls.filter(([b]) => b.bindingId === B1)).toHaveLength(1);
    expect(t.store.latestForRequest(B1, "req-1")?.state).toBe("exhausted");
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0][0]).toMatchObject({ kind: "approval", botId: "scout", threadId: "t1", requestId: "req-1" });
  });

  it("a binding the relay no longer knows is removed here, and its removal is still owed to the relay", async () => {
    const t = setup({}, async (binding) => (binding.bindingId === B1 ? "gone" : "accepted"));
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    expect(t.store.binding(B1)).toBeNull();
    expect(t.store.binding(B2)).not.toBeNull();
    // A 401 from something that is not the relay must not orphan the relay
    // binding: the DELETE costs one request, and a real 401 counts as done.
    expect(t.store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toMatchObject([{ bindingId: B1, publisherToken: "murage_pt_1" }]);
  });

  it("pending leaves out a thread this device can no longer see", async () => {
    let visible = true;
    const t = setup({ visible: () => visible });
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    visible = false;
    expect(t.outbox.pending(B1)).toEqual({ badge: 2, items: [] });
  });

  it("a held row whose thread became hidden during the hold is dropped, not sent", async () => {
    let visible = true;
    const t = setup({ present: () => true, visible: () => visible });
    t.outbox.enqueue(approval);
    visible = false;
    t.tick(120_000);
    await t.outbox.flush();
    expect(t.sender.publish).not.toHaveBeenCalled();
    expect(t.store.latestForRequest(B1, "req-1")?.state).toBe("dropped");
  });

  it("pending lists live attention with the badge", async () => {
    const t = setup();
    t.outbox.enqueue(approval);
    await t.outbox.flush();
    expect(t.outbox.pending(B1)).toEqual({ badge: 2, items: [{ collapseKey: collapseKey(t.store.keySecret(B1)!, "req-1"), revision: 1, category: "approval" }] });
  });
});
