// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createTaskDelta } from "./task-delta.ts";
import { TASK_WINDOW, decodeTaskCursor, encodeTaskCursor, pageTasks, sumTaskUsage, taskGrants, windowTasks } from "./task-window.ts";

type Row = { threadId: string; createdAt: number; pinned?: boolean; unread?: boolean; busy?: boolean; activity?: string; unreadCount?: number; usage?: { input: number; output: number; cachedInput?: number; costUsd: number | null; turns: number }; alwaysAllow?: string[] };
/** The sum the interface made from the whole list before the server made it (src/lib/usage.ts sumUsage), written out again here. */
function reference(items: Array<Row["usage"]>) {
  const out: { input: number; output: number; cachedInput?: number; costUsd: number | null; turns: number } = { input: 0, output: 0, costUsd: null, turns: 0 };
  for (const u of items) {
    if (!u) continue;
    out.input += u.input; out.output += u.output; out.turns += u.turns;
    if (typeof u.cachedInput === "number") out.cachedInput = (out.cachedInput ?? 0) + u.cachedInput;
    if (typeof u.costUsd === "number") out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  }
  if (items.some((u) => u && u.input > 0 && typeof u.cachedInput !== "number")) delete out.cachedInput;
  return out;
}
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ threadId: `t${i}`, createdAt: 1_000 + i }));

describe("the task window", () => {
  it("returns every task of a small record, in the record's order", () => {
    const all = rows(10).reverse();
    const window = windowTasks(all, "t3");
    expect(window.tasks.map((task) => task.threadId)).toEqual(all.map((task) => task.threadId));
    expect(window.total).toBe(10);
    expect(window.older).toBeNull();
  });

  it("holds the newest TASK_WINDOW and what the interface needs, whatever its age", () => {
    const all = rows(5000);
    all[1] = { ...all[1]!, pinned: true };
    all[2] = { ...all[2]!, unread: true };
    all[3] = { ...all[3]!, busy: true };
    all[4] = { ...all[4]!, activity: "waiting-on-you" };
    all[5] = { ...all[5]!, activity: "idle" };
    all[6] = { ...all[6]!, unreadCount: 2 };
    const window = windowTasks(all, "t7", new Set(["t8"]));
    const held = new Set(window.tasks.map((task) => task.threadId));
    for (const id of ["t1", "t2", "t3", "t4", "t6", "t7", "t8"]) expect(held.has(id), id).toBe(true);
    expect(held.has("t5")).toBe(false);
    expect(held.has("t0")).toBe(false);
    expect(held.has("t4999")).toBe(true);
    expect(window.tasks.length).toBe(TASK_WINDOW + 7);
    expect(window.total).toBe(5000);
    expect(window.older).toBe(encodeTaskCursor(all[5000 - TASK_WINDOW]!));
  });

  it("pages from the window's cursor back to the oldest task, once each", () => {
    const all = rows(5000);
    const window = windowTasks(all, "t0");
    const seen = new Set(window.tasks.map((task) => task.threadId));
    let cursor = window.older;
    let pages = 0;
    while (cursor !== null) {
      const page = pageTasks(all, cursor, 200);
      expect(page).not.toBeNull();
      for (const task of page!.tasks) {
        expect(seen.has(task.threadId) && !window.tasks.some((held) => held.threadId === task.threadId), task.threadId).toBe(false);
        seen.add(task.threadId);
      }
      cursor = page!.next;
      pages++;
    }
    expect(seen.size).toBe(5000);
    expect(pages).toBe(Math.ceil((5000 - TASK_WINDOW) / 200));
  });

  it("orders a page newest first, breaks a createdAt tie by thread id, and refuses a cursor it did not give", () => {
    const tied = ["b", "a", "c"].map((threadId) => ({ threadId, createdAt: 5 }));
    expect(pageTasks(tied, null, 10)!.tasks.map((task) => task.threadId)).toEqual(["a", "b", "c"]);
    const first = pageTasks(tied, null, 2)!;
    expect(first.next).toBe(encodeTaskCursor({ threadId: "b", createdAt: 5 }));
    expect(pageTasks(tied, first.next, 2)!.tasks.map((task) => task.threadId)).toEqual(["c"]);
    expect(pageTasks(tied, "nonsense", 2)).toBeNull();
    expect(decodeTaskCursor("12:thread:with:colons")).toEqual({ createdAt: 12, threadId: "thread:with:colons" });
  });

  it("sums usage and grants over every task as the interface summed the list", () => {
    const all: Row[] = rows(300).map((row, i) => ({
      ...row,
      usage: { input: 10 + i, output: 5, cachedInput: i % 3 === 0 ? undefined : 4, costUsd: i % 2 ? 0.25 : null, turns: 1 },
      alwaysAllow: [`Bash:${i % 7}`],
    }));
    all.push({ threadId: "none", createdAt: 1 });
    expect(sumTaskUsage(all)).toEqual(reference(all.map((task) => task.usage)));
    expect(taskGrants(all).sort()).toEqual([0, 1, 2, 3, 4, 5, 6].map((n) => `Bash:${n}`).sort());
    expect(sumTaskUsage([])).toEqual(reference([]));
  });

  it("keeps the delta protocol correct over a window: a task leaving it is a whole frame with the total, not a deletion", () => {
    const all = rows(400);
    const delta = createTaskDelta({ epoch: "e", now: () => 0, setTimer: () => 0, clearTimer: () => {} });
    const frameOf = (list: Row[], current = "t399") => {
      const window = windowTasks(list, current);
      return delta.frame("bot", { tasks: window.tasks, tasksTotal: window.total });
    };
    expect(frameOf(all).delta).toBeUndefined(); // the first frame is whole
    // a row inside the window changes: a delta, counting the window's rows, with the total beside it
    const edited = all.map((row) => (row.threadId === "t390" ? { ...row, unread: true } : row));
    const changed = frameOf(edited);
    expect(changed.delta).toBeDefined();
    expect((changed.delta as any).tasksDelta.count).toBe(TASK_WINDOW);
    expect((changed.delta as any).tasksTotal).toBe(400);
    // an old task becomes unread: it joins the window, the set changed, the frame is whole
    const joined = frameOf(edited.map((row) => (row.threadId === "t5" ? { ...row, unread: true } : row)));
    expect(joined.delta).toBeUndefined();
    expect((joined.full as any).tasks.some((task: Row) => task.threadId === "t5")).toBe(true);
    // and read again: it leaves, the frame is whole, and the total still counts it
    const left = frameOf(edited);
    expect(left.delta).toBeUndefined();
    expect((left.full as any).tasks.some((task: Row) => task.threadId === "t5")).toBe(false);
    expect((left.full as any).tasksTotal).toBe(400);
  });
});
