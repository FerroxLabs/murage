// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An Inbox link or a tray item names a thread. A thread older than a bot's task
// window is not in the rows the client holds; the server says whose it is.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args) }));
vi.mock("@/state/page-intent", () => ({ requestPage: () => 1 }));
vi.mock("@/state/answer-tag", () => ({ fromAnswer: () => ({ source: "http", sentAt: 0, expired: false }) }));

const { openInboxLink } = await import("./open-inbox-link");

const bot = (extra: object = {}) => ({ id: "b", threadId: "t0", tasks: [{ threadId: "t0" }], tasksTotal: 1, ...extra });
const answers = (map: Record<string, unknown>) => api.mockImplementation(async (path: string) => {
  for (const [prefix, value] of Object.entries(map)) if (path.startsWith(prefix)) return typeof value === "function" ? value(path) : value;
  throw new Error(`unexpected ${path}`);
});

beforeEach(() => { api.mockReset(); });

describe("opening a link to a conversation", () => {
  it("opens a task the rows held name, without asking whose it is", async () => {
    answers({ "/api/bots/b/tasks/t0": { bot: { id: "b", threadId: "t0" } } });
    const dispatch = vi.fn();
    await openInboxLink({ threadId: "t0" }, { bots: [bot()] as never, groups: [] }, dispatch);
    expect(api.mock.calls.map((call) => String(call[0]).split("?")[0])).toEqual(["/api/bots/b/tasks/t0"]);
    expect(dispatch.mock.calls.map((call) => call[0].type)).toEqual(["taskSwitched", "select"]);
  });

  it("finds the owner of a task older than the window by asking the server, then opens it", async () => {
    answers({
      "/api/threads/old-1/owner": { botId: "b" },
      "/api/bots/b/tasks/old-1": { bot: { id: "b", threadId: "old-1", tasks: [], tasksTotal: 5000 } },
    });
    const dispatch = vi.fn();
    await openInboxLink({ threadId: "old-1", messageId: "m1" }, { bots: [bot({ tasksTotal: 5000 })] as never, groups: [] }, dispatch);
    expect(api.mock.calls.map((call) => String(call[0]).split("?")[0])).toEqual(["/api/threads/old-1/owner", "/api/bots/b/tasks/old-1"]);
    expect(dispatch.mock.calls.map((call) => call[0].type)).toEqual(["taskSwitched", "select", "focusMessage"]);
  });

  it("opens an old channel task the same way", async () => {
    answers({
      "/api/threads/old-g/owner": { groupId: "g" },
      "/api/groups/g/tasks/old-g": { group: { id: "g", threadId: "old-g" } },
    });
    const dispatch = vi.fn();
    const group = { id: "g", threadId: "g0", tasks: [], tasksTotal: 300 };
    await openInboxLink({ threadId: "old-g" }, { bots: [bot()] as never, groups: [group] as never }, dispatch);
    expect(dispatch.mock.calls.map((call) => call[0].type)).toEqual(["groupPatched", "select"]);
  });

  it("says the conversation is unavailable when nobody owns the thread", async () => {
    answers({ "/api/threads/gone/owner": () => { throw new Error("404"); } });
    await expect(openInboxLink({ threadId: "gone" }, { bots: [bot({ tasksTotal: 5000 })] as never, groups: [] }, vi.fn())).rejects.toThrow();
    // with every task held there is nothing to ask
    api.mockReset();
    await expect(openInboxLink({ threadId: "gone" }, { bots: [bot()] as never, groups: [] }, vi.fn())).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  });
});
