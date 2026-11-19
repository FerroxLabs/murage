import { sendStore } from "./send-store.ts";
import { describe, expect, it, vi } from "vitest";

import {
  _queuedChannelCount,
  cancelChannelMessage,
  drainChannelMessages,
  queuedChannelMessage,
  queueChannelMessage,
} from "./channel-queue.ts";

describe("channel queue", () => {
  it("keeps messages off the running channel and drains one follow-up at a time", () => {
    let working = true;
    const run = vi.fn(() => {
      working = true;
      return { messageId: "line-1" };
    });
    const first = queueChannelMessage("group-a", "thread-a", "first follow-up", {
      sendId: "send_first_123456",
    });
    queueChannelMessage("group-a", "thread-a", "second follow-up", {
      sendId: "send_second_123456",
      mode: "goal",
    });

    drainChannelMessages(() => working, run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedChannelCount("thread-a")).toBe(2);
    expect(queuedChannelMessage("group-a", "thread-a", "send_first_123456")?.id).toBe(first.id);

    working = false;
    drainChannelMessages(() => working, run);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      groupId: "group-a",
      threadId: "thread-a",
      text: "first follow-up",
      mode: "chat",
    }));
    expect(_queuedChannelCount("thread-a")).toBe(1);

    working = false;
    drainChannelMessages(() => working, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "second follow-up",
      mode: "goal",
    }));
    expect(_queuedChannelCount("thread-a")).toBe(0);
  });

  it("cancels only the requested channel message", () => {
    const keep = queueChannelMessage("group-b", "thread-b", "keep");
    const drop = queueChannelMessage("group-b", "thread-b", "drop");

    expect(cancelChannelMessage("group-b", drop.id)).toBe(true);
    expect(cancelChannelMessage("group-b", drop.id)).toBe(false);
    expect(_queuedChannelCount("thread-b")).toBe(1);

    const run = vi.fn(() => ({ messageId: "line-keep" }));
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: keep.id, text: "keep" }));
  });
});

describe("channel queue: authoritative pending list", () => {
  it("lists the waiting sends of a room for a reload or another device and tells the observer of each change", async () => {
    const { pendingChannelItems, channelQueueThreads, setChannelQueueObserver } = await import("./channel-queue.ts");
    const seen: string[] = [];
    setChannelQueueObserver((threadId) => seen.push(threadId));
    try {
      const a = queueChannelMessage("group-p", "thread-p", "from the desktop", { sendId: "send_pending_a_1" });
      expect(pendingChannelItems("thread-p")).toEqual([{ queueId: a.id, sendId: "send_pending_a_1", text: "from the desktop" }]);
      expect(channelQueueThreads()).toContain("thread-p");
      expect(cancelChannelMessage("group-p", a.id)).toBe(true);
      expect(pendingChannelItems("thread-p")).toEqual([]);
      expect(seen).toEqual(["thread-p", "thread-p"]);
    } finally {
      setChannelQueueObserver(null);
    }
  });
});

// R1: room queue lifecycle shares durable receipts, including question answers.
it("F7-ML1-CHANNEL-DRAIN: thrown channel startup settles its attempt and excludes its linked line", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { initializeSendAttempts } = await import("./send-attempt-state.ts");
  const db = new DatabaseSync(":memory:"); initializeSendAttempts(db);
  sendStore.use(() => db);
  try {
    queueChannelMessage("g", "t", "question", { sendId: "send" });
    drainChannelMessages(() => false, item => {
      const row = sendStore.bySendId("t", "send")!;
      sendStore.settle(row.seq, "started", "line");
      expect(item.binding?.attemptId).toBeTruthy();
      throw new Error("setup failed after acceptance");
    });
    const row = sendStore.bySendId("t", "send")!;
    expect(sendStore.attemptFor(row)).toMatchObject({ phase: "terminal", delivery: "uncertain", replayPolicy: "exclude" });
    expect(sendStore.attempts()!.replayEligibility("t", ["line"]).excludedIds.has("line")).toBe(true);
  } finally { sendStore.reset(); db.close(); }
});

it("F7-ML5-ANON-RETURNS-ID: room acceptance exposes its minted send identity", () => {
  const queued = queueChannelMessage("anonymous-group", "anonymous-thread", "question");
  expect((queued as { sendId?: string }).sendId).toMatch(/^srv-/);
});

it("DOOR-1 GUARD: a foreign group cannot read or remove another room's queued send", () => {
  const queued = queueChannelMessage("l8-room", "l8-room-thread", "owner question", {sendId:"l8-room-send"});
  expect(queuedChannelMessage("foreign-room", "l8-room-thread", "l8-room-send")).toBeNull();
  expect(cancelChannelMessage("foreign-room", queued.id)).toBe(false);
  expect(queuedChannelMessage("l8-room", "l8-room-thread", "l8-room-send")?.id).toBe(queued.id);
  expect(cancelChannelMessage("l8-room", queued.id)).toBe(true);
  expect(queuedChannelMessage("l8-room", "l8-room-thread", "l8-room-send")).toBeNull();
});

it("a pinned provider handoff carries its binding without claiming an unfenced invocation", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { initializeSendAttempts } = await import("./send-attempt-state.ts");
  const db = new DatabaseSync(":memory:"); initializeSendAttempts(db);
  sendStore.use(() => db);
  try {
    queueChannelMessage("receipt-room", "receipt-thread", "answer", { sendId: "receipt-send", responderBotId: "receipt-member", origin: "desktop" });
    drainChannelMessages(() => false, item => {
      const row = sendStore.bySendId("receipt-thread", "receipt-send")!;
      expect(item.binding?.attemptId).toBe(sendStore.attemptFor(row)!.attemptId);
      expect(sendStore.attemptFor(row)).toMatchObject({ delivery: "not_submitted", replayPolicy: "exclude" });
      expect(db.prepare("SELECT invocation_released, released_writes FROM send_attempt_bindings WHERE attempt_id=?").get(item.binding!.attemptId)).toEqual({ invocation_released: 0, released_writes: 0 });
      return { messageId: "receipt-line" };
    }, true);
    expect(sendStore.attemptFor(sendStore.bySendId("receipt-thread", "receipt-send")!)!.delivery).toBe("not_submitted");
  } finally { sendStore.use(null); db.close(); }
});
