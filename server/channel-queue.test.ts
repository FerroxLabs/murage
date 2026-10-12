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
