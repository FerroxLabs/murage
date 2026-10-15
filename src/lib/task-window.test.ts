// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A frame carries a window of a bot's tasks (server/task-window.ts). What used
// to read the whole list reads the window plus the server's totals, finds a
// task outside the window instead of taking it for deleted, and pages back.
import { describe, expect, it } from "vitest";
import { initialState, openNotificationTarget, reducer, viewedTaskBot, type Action, type Bot, type Group, type Task } from "@/state/store";
import { hasRoutineExecutionTask } from "@/components/RoutineRunCard";
import { botTurnCount, looksUnconfigured } from "@/lib/bot-skill-count";
import { activeWorkThread } from "@/lib/shared-teams";
import { ownerOfThread } from "@/lib/thread-owner";
import { fetchOlderTasks } from "@/lib/use-ensure-task";
import { pageTasks, sumTaskUsage, taskGrants, windowTasks } from "../../server/task-window";
import { botUsage, sumUsage } from "@/lib/usage";
import { rememberedGrants } from "@/lib/remembered-grants";
import { activeSavedFilters } from "@/lib/files-view";
import { scopeLabel } from "@/components/WorkspacePane";
import { allHeldTasks, extraTasksPatch, findTask, isTruncated, mayHoldTask, nextExtraTasks, taskCount, taskGrantKeys, viewedThreadGone, withExtraTasks } from "@/lib/task-window";

const task = (id: number, extra: Partial<Task> = {}): Task => ({ threadId: `t${id}`, title: `Task ${id}`, createdAt: 1000 + id, ...extra });
/** 5,000 tasks on the server; the frame holds the newest 50 plus the open one. */
const TOTAL = 5000;
const windowOf = (open = 0): Task[] => [task(open), ...Array.from({ length: 50 }, (_, i) => task(TOTAL - 1 - i))].filter((row, i, rows) => rows.findIndex((other) => other.threadId === row.threadId) === i);
const bot = (extra: Partial<Bot> = {}): Bot => ({ id: "b", name: "Bot", threadId: "t0", messages: [], tasks: windowOf(0), tasksTotal: TOTAL, ...extra }) as never as Bot;

describe("reading a window", () => {
  it("counts every task from the server's total, falling back to the list", () => {
    expect(taskCount(bot())).toBe(TOTAL);
    expect(taskCount({ tasks: [task(1), task(2)] })).toBe(2);
    expect(taskCount({})).toBe(0);
    expect(isTruncated(bot())).toBe(true);
    expect(isTruncated({ tasks: [task(1)], tasksTotal: 1 })).toBe(false);
    expect(isTruncated({ tasks: [task(1)] })).toBe(false);
  });

  it("sums usage and grants from the server's totals, and from the list when a server sends none", () => {
    const full = Array.from({ length: TOTAL }, (_, i) => task(i, { usage: { input: 10 + i, output: 2, cachedInput: 5, costUsd: 0.01, turns: 1 }, alwaysAllow: [`Bash:${i % 9}`] }));
    const fullList = sumUsage(full.map((row) => row.usage));
    const wire = { tasks: full.slice(-50), tasksTotal: TOTAL, usageTotal: fullList, grantsAll: [...new Set(full.flatMap((row) => row.alwaysAllow ?? []))] };
    // the server's sum is the sum this client made from the whole list
    expect(sumTaskUsage(full as never)).toEqual(fullList);
    expect(taskGrants(full)).toEqual(taskGrantKeys({ tasks: full }));
    expect(botUsage(wire)).toEqual(fullList);
    expect(botUsage({ tasks: full })).toEqual(fullList);
    expect(botUsage({ tasks: full.slice(-50) })).not.toEqual(fullList);
    expect(new Set(rememberedGrants({ alwaysAllow: ["x"], ...wire }))).toEqual(new Set(["x", ...wire.grantsAll]));
    expect(taskGrantKeys({ tasks: full })).toEqual(wire.grantsAll);
    expect(botTurnCount({ tasks: full.slice(-50), usageTotal: { turns: TOTAL } })).toBe(TOTAL);
    expect(botTurnCount({ tasks: full })).toBe(TOTAL);
    expect(looksUnconfigured({ tasks: full.slice(-1), usageTotal: { turns: TOTAL } })).toBe(false);
  });

  it("finds a task in the window, then in the rows asked for since, and says whose it may be", () => {
    const held = bot({ extraTasks: [task(7, { title: "Fetched" })] });
    expect(findTask(held, "t0")?.title).toBe("Task 0");
    expect(findTask(held, "t7")?.title).toBe("Fetched");
    expect(findTask(held, "t8")).toBeUndefined();
    expect(mayHoldTask(held, "t8")).toBe(true);
    expect(mayHoldTask({ tasks: [task(1)], tasksTotal: 1 }, "t8")).toBe(false);
    expect(mayHoldTask(undefined, "t8")).toBe(false);
    expect(viewedTaskBot(bot({ threadId: "t7", extraTasks: [task(7, { modelSelection: { instanceId: "i", model: "m" } })] })).modelSelection).toEqual({ instanceId: "i", model: "m" });
    expect(activeWorkThread({ threadId: "t7", tasks: [], extraTasks: [{ threadId: "t7", sharedWork: { teamId: "x" } as never }] })).toBeDefined();
  });

  it("lists the window and the rows asked for as one list, each task once", () => {
    const held = bot({ extraTasks: [task(7), task(1, { title: "stale" }), task(0, { title: "stale" })] });
    const all = allHeldTasks(held);
    expect(all.length).toBe(windowOf(0).length + 2);
    expect(all.find((row) => row.threadId === "t0")?.title).toBe("Task 0");
    expect(all.find((row) => row.threadId === "t1")?.title).toBe("stale");
  });

  it("names a task outside the window by its title, and offers a run's link without the task held", () => {
    const held = bot({ extraTasks: [task(7, { title: "Weekly report" })] });
    expect(scopeLabel([{ ...held, name: "Bot" }], { botId: "b", threadId: "t7" })).toContain("Weekly report");
    expect(activeSavedFilters({ botId: "b", threadId: "t7", kind: "", since: "", until: "", query: "" } as never, [held as never])[1]).toContain("Weekly report");
    expect(hasRoutineExecutionTask(held.tasks, "t9")).toBe(false);
    expect(hasRoutineExecutionTask(held.tasks, "t9", isTruncated(held))).toBe(true);
    expect(hasRoutineExecutionTask(held.tasks, undefined, true)).toBe(false);
  });
});

describe("a frame that changes the window", () => {
  const dispatch = (state: ReturnType<typeof reducer>, action: Action) => reducer(state, action);
  const held = () => ({ ...initialState, bots: [bot({ threadId: "t7", tasks: [...windowOf(7)] })], selectedId: "b" });

  it("keeps the task being read when it ages out of the window, and does not take it for deleted", () => {
    // another window moved the bot to t1; t7 (idle, old) is not in the new window
    const frame = { id: "b", threadId: "t1", tasks: windowOf(1), tasksTotal: TOTAL } as never;
    const next = dispatch(held(), { type: "botPatched", bot: frame });
    const after = next.bots[0]!;
    expect(after.threadId).toBe("t7");
    expect(after.deletedThreadId).toBeUndefined();
    expect(findTask(after, "t7")?.title).toBe("Task 7");
    expect(after.extraTasks?.map((row) => row.threadId)).toEqual(["t7"]);
  });

  it("does take it for deleted when the count fell and it is gone", () => {
    const frame = { id: "b", threadId: "t1", tasks: windowOf(1), tasksTotal: TOTAL - 1 } as never;
    const after = dispatch(held(), { type: "botPatched", bot: frame }).bots[0]!;
    expect(after.deletedThreadId).toBe("t7");
    expect(after.threadId).toBe("t1");
    expect(after.extraTasks).toBeUndefined();
  });

  it("keeps a task that leaves the window (read, finished) as it last was, unless the count fell", () => {
    const start = { ...initialState, bots: [bot({ tasks: [...windowOf(0), task(20, { unread: true })] })] };
    const left = dispatch(start, { type: "botPatched", bot: { id: "b", tasks: windowOf(0), tasksTotal: TOTAL } as never }).bots[0]!;
    expect(left.extraTasks?.map((row) => row.threadId)).toEqual(["t20"]);
    expect(taskCount(left)).toBe(TOTAL);
    const deleted = dispatch(start, { type: "botPatched", bot: { id: "b", tasks: windowOf(0), tasksTotal: TOTAL - 1 } as never }).bots[0]!;
    expect(deleted.extraTasks).toBeUndefined();
  });

  it("applies a delta over the window by the window's count, with the totals beside it", () => {
    const start = { ...initialState, bots: [bot({ tasksSeq: 4 })] };
    const changed = task(TOTAL - 1, { unread: true });
    const next = dispatch(start, { type: "botPatched", bot: { id: "b", tasksSeq: 5, tasksTotal: TOTAL, tasksDelta: { upsert: [changed], count: start.bots[0]!.tasks!.length, base: 4 } } as never }).bots[0]!;
    expect(next.tasksStale).toBeUndefined();
    expect(next.tasks!.find((row) => row.threadId === changed.threadId)?.unread).toBe(true);
    expect(next.tasks!.length).toBe(start.bots[0]!.tasks!.length);
    expect(next.tasksTotal).toBe(TOTAL);
    // a window of another size is not completed by it: the list is fetched again
    const stale = dispatch(start, { type: "botPatched", bot: { id: "b", tasksSeq: 5, tasksTotal: TOTAL, tasksDelta: { upsert: [changed], count: 99, base: 4 } } as never }).bots[0]!;
    expect(stale.tasksStale).toBe(true);
  });

  it("resyncs to the bounded set with its totals", () => {
    const start = { ...initialState, bots: [bot({ tasksStale: true, tasks: windowOf(0).slice(0, 5), tasksTotal: 5 })] };
    const next = dispatch(start, { type: "tasksResynced", botId: "b", tasks: windowOf(0), tasksSeq: 3, tasksEpoch: "e", tasksTotal: TOTAL, usageTotal: sumUsage([{ input: 1, output: 1, costUsd: null, turns: 1 }]), grantsAll: ["a"] }).bots[0]!;
    expect(next.tasks!.length).toBe(windowOf(0).length);
    expect(next.tasksTotal).toBe(TOTAL);
    expect(next.usageTotal?.turns).toBe(1);
    expect(next.grantsAll).toEqual(["a"]);
    expect(next.tasksStale).toBe(false);
  });

  it("holds fetched tasks beside the window, renames and pins them there, and leaves the window alone", () => {
    const start = { ...initialState, bots: [bot()], groups: [{ id: "g", threadId: "g0", tasks: [], tasksTotal: 90, messages: [] } as never as Group] };
    const fetched = dispatch(start, { type: "tasksFetched", owner: "bot", id: "b", tasks: [task(9), task(8)] });
    expect(fetched.bots[0]!.extraTasks?.map((row) => row.threadId)).toEqual(["t9", "t8"]);
    expect(fetched.bots[0]!.tasks).toBe(start.bots[0]!.tasks);
    const renamed = dispatch(dispatch(fetched, { type: "renameTask", botId: "b", threadId: "t9", title: "New" }), { type: "pinTask", botId: "b", threadId: "t8", pinned: true }).bots[0]!;
    expect(findTask(renamed, "t9")?.title).toBe("New");
    expect(findTask(renamed, "t8")?.pinned).toBe(true);
    const group = dispatch(start, { type: "tasksFetched", owner: "group", id: "g", tasks: [task(4)] }).groups[0]!;
    expect(findTask(group, "t4")).toBeDefined();
    expect(dispatch({ ...start, groups: [group] }, { type: "renameGroupTask", groupId: "g", threadId: "t4", title: "Room" }).groups[0]!.extraTasks?.[0]?.title).toBe("Room");
    // a group frame that holds the whole list drops the extras
    expect(dispatch({ ...start, groups: [group] }, { type: "groupPatched", group: { id: "g", tasks: [task(4)], tasksTotal: 1 } as never }).groups[0]!.extraTasks).toBeUndefined();
  });

  it("opens a notification for an old task of a known bot, and a conversation from the cache", () => {
    const calls: Action[] = [];
    expect(openNotificationTarget((action) => calls.push(action), { botId: "b", threadId: "t9" }, { bots: [bot()], groups: [] })).toBe(true);
    expect(calls.map((action) => action.type)).toEqual(["select", "switchTask"]);
    const whole = bot({ tasks: [task(0)], tasksTotal: 1 });
    const none: Action[] = [];
    openNotificationTarget((action) => none.push(action), { botId: "b", threadId: "t9" }, { bots: [whole], groups: [] });
    expect(none.map((action) => action.type)).toEqual(["select"]);
  });
});

describe("helpers behind the reducer", () => {
  it("nextExtraTasks, extraTasksPatch and viewedThreadGone say the same things the reducer acts on", () => {
    const held = bot({ threadId: "t7", tasks: windowOf(7) });
    expect(nextExtraTasks(held, { tasks: windowOf(1), tasksTotal: TOTAL })?.map((row) => row.threadId)).toEqual(["t7"]);
    expect(nextExtraTasks(held, { tasks: windowOf(1), tasksTotal: TOTAL }, { keepViewed: false })?.map((row) => row.threadId)).toEqual(["t7"]);
    expect(nextExtraTasks(held, { tasks: windowOf(1), tasksTotal: TOTAL - 1 }, { keepViewed: false })).toBeUndefined();
    expect(nextExtraTasks(held, {})).toBeUndefined();
    expect(extraTasksPatch(bot(), { tasks: [task(1)], tasksTotal: 1 })).toEqual({});
    expect(viewedThreadGone(held, { tasks: windowOf(1), tasksTotal: TOTAL })).toBe(false);
    expect(viewedThreadGone(held, { tasks: windowOf(1), tasksTotal: TOTAL - 1 })).toBe(true);
    expect(viewedThreadGone({ threadId: "x", tasks: [task(1)] }, { tasks: [task(2)] })).toBe(true);
    expect(viewedThreadGone({ threadId: "x" }, {})).toBe(true);
    expect(withExtraTasks([task(1, { title: "a" })], [task(1, { title: "b" }), task(2)]).map((row) => row.title)).toEqual(["b", "Task 2"]);
  });
});

describe("whose a thread is", () => {
  const owners = (extra: object = {}) => ({ bots: [{ id: "b", threadId: "t0", ...extra } as never], groups: [{ id: "g", threadId: "g0", tasks: [task(3, { threadId: "g3" })], tasksTotal: 1 } as never] });

  it("answers from the rows held without asking", async () => {
    const ask = async () => { throw new Error("asked"); };
    expect((await ownerOfThread(owners({ tasks: [task(5)], tasksTotal: 1 }), "t5", ask))?.bot?.id).toBe("b");
    expect((await ownerOfThread(owners(), "g3", ask))?.group?.id).toBe("g");
  });

  it("asks the server for a thread older than the window, and nobody for a thread that is not found", async () => {
    const asked: string[] = [];
    const found = await ownerOfThread(owners({ tasks: [task(5)], tasksTotal: 500 }), "t9", async (id) => { asked.push(id); return { botId: "b" }; });
    expect(found?.bot?.id).toBe("b");
    expect(asked).toEqual(["t9"]);
    expect(await ownerOfThread(owners({ tasks: [task(5)], tasksTotal: 500 }), "t9", async () => { throw new Error("404"); })).toBeNull();
    // nothing is truncated, so there is nothing to ask
    expect(await ownerOfThread(owners({ tasks: [task(5)], tasksTotal: 1 }), "nope", async () => { throw new Error("asked"); })).toBeNull();
  });
});

describe("paging back through the older tasks", () => {
  it("reaches the oldest task, each once, and the picker then holds all of them", async () => {
    const everything = Array.from({ length: TOTAL }, (_, i) => task(i));
    const window = windowTasks(everything, "t0");
    // the server's answers, through the same cursor the frame gave
    const request = async (path: string) => {
      const url = new URL(path, "http://x");
      const page = pageTasks(everything, url.searchParams.get("before"), Number(url.searchParams.get("limit")))!;
      return { tasks: page.tasks, next: page.next };
    };
    let state = { ...initialState, bots: [bot({ tasks: window.tasks as Task[], tasksTotal: TOTAL, tasksOlder: window.older })] };
    let cursor: string | null = state.bots[0]!.tasksOlder ?? null;
    let pages = 0;
    while (cursor !== null) {
      const page = await fetchOlderTasks(request as never, "bot", "b", cursor);
      state = reducer(state, { type: "tasksFetched", owner: "bot", id: "b", tasks: page.tasks });
      cursor = page.next;
      pages++;
    }
    expect(pages).toBeGreaterThan(50);
    const all = allHeldTasks(state.bots[0]!);
    expect(all.length).toBe(TOTAL);
    expect(new Set(all.map((row) => row.threadId)).size).toBe(TOTAL);
    expect(findTask(state.bots[0]!, "t0")).toBeDefined();
    expect(Math.min(...all.map((row) => row.createdAt))).toBe(1000);
  });
});
