import { describe, expect, it, vi } from "vitest";
import { botUnreadThreadIds, markBotRead } from "./bot-read";

const bot = (tasks: Array<{ threadId: string; unread?: boolean }>, extra: Record<string, unknown> = {}) =>
  ({ threadId: "t1", unread: tasks.some((task) => task.unread), tasks, ...extra }) as never;

describe("mark all of a bot's conversations read", () => {
  it("lists only the unread threads, once", () => {
    expect(botUnreadThreadIds(bot([{ threadId: "a", unread: true }, { threadId: "b" }, { threadId: "c", unread: true }]))).toEqual(["a", "c"]);
  });
  it("has nothing to do (so the menu item is off) when nothing is unread", () => {
    expect(botUnreadThreadIds(bot([{ threadId: "a" }]))).toEqual([]);
  });
  it("falls back to the open thread when the bot is unread but its tasks are not loaded", () => {
    expect(botUnreadThreadIds({ threadId: "t9", unread: true, tasks: undefined } as never)).toEqual(["t9"]);
  });
  it("reads each unread thread in order", async () => {
    const post = vi.fn(async (_threadId: string) => ({}));
    const out = await markBotRead(bot([{ threadId: "a", unread: true }, { threadId: "c", unread: true }]), post);
    expect(post.mock.calls.map((call) => call[0])).toEqual(["a", "c"]);
    expect(out).toEqual({ read: ["a", "c"], failed: null });
  });
  it("stops at the first failure and keeps the reads already confirmed", async () => {
    const post = vi.fn(async (id: string) => { if (id === "b") throw new Error("offline"); });
    const out = await markBotRead(bot([{ threadId: "a", unread: true }, { threadId: "b", unread: true }, { threadId: "c", unread: true }]), post);
    expect(out.read).toEqual(["a"]);
    expect(out.failed).toEqual({ threadId: "b", message: "offline" });
    expect(post).toHaveBeenCalledTimes(2);
  });
});
