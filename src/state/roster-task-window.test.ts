// A client booted from the roster holds ROSTER_TASK_WINDOW tasks per bot. The task delta the event stream sends next announces a count; it must be the
// count of that same window, or the client marks the bot stale and refetches its task list (once per bot) on the first busy/unread flip.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { withTaskDelta, type Task } from "@/state/store";
import { createTaskDelta } from "../../server/task-delta.ts";
import { ROSTER_TASK_WINDOW, TASK_WINDOW, windowTasks } from "../../server/task-window.ts";

const task = (n: number, patch: Record<string, unknown> = {}) => ({ threadId: `t${String(n).padStart(3, "0")}`, createdAt: 1_000 + n, title: `Task ${n}`, ...patch }) as unknown as Task & { threadId: string; createdAt: number };
const all = Array.from({ length: 80 }, (_, index) => task(index));

describe("the event stream's task window is the roster's", () => {
  it("a client booted from the roster applies the first busy flip as a delta, with no stale mark and so no task-list fetch", () => {
    const delta = createTaskDelta({ epoch: "e1", setTimer: () => 0, clearTimer: () => undefined });
    const wire = (tasks: Array<Task & { threadId: string; createdAt: number }>) => windowTasks(tasks, "main", undefined, ROSTER_TASK_WINDOW).tasks;
    // the roster answer: the bot's window, numbered with the server's current task frame
    const first = delta.frame("b", { id: "b", tasks: wire(all) });
    const booted = { tasks: first.full.tasks as Task[], tasksSeq: delta.seq("b") };
    expect(booted.tasks).toHaveLength(ROSTER_TASK_WINDOW);
    // the bot goes busy: the next frame, built the way broadcastBot builds it
    const flipped = all.map((entry, index) => (index === all.length - 1 ? { ...entry, busy: true } : entry));
    const frame = delta.frame("b", { id: "b", tasks: wire(flipped) });
    expect(frame.delta).toBeDefined();
    const next = withTaskDelta(frame.delta as never, booted);
    expect(next.tasksStale).toBeUndefined();
    expect(next.tasks).toHaveLength(ROSTER_TASK_WINDOW);
    expect(next.tasks?.find((entry) => (entry as { busy?: boolean }).busy)).toBeDefined();
  });

  it("the old 50-task frame would have been a mismatch against the 10-task roster", () => {
    const delta = createTaskDelta({ epoch: "e1", setTimer: () => 0, clearTimer: () => undefined });
    delta.frame("b", { id: "b", tasks: windowTasks(all, "main", undefined, TASK_WINDOW).tasks });
    const booted = { tasks: windowTasks(all, "main", undefined, ROSTER_TASK_WINDOW).tasks as unknown as Task[], tasksSeq: delta.seq("b") };
    const frame = delta.frame("b", { id: "b", tasks: windowTasks(all, "main", undefined, TASK_WINDOW).tasks });
    expect(withTaskDelta(frame.delta as never, booted).tasksStale).toBe(true);
  });

  it("every bot frame the server broadcasts is wired at the roster window", () => {
    const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/taskDelta\.frame\(bot\.id, wireBot\(bot, ROSTER_TASK_WINDOW\), forceFull\)/);
    const broadcasts = source.split("\n").filter((line) => /broadcast\(\{ kind: "bot", bot: wireBot\(/.test(line));
    expect(broadcasts.length).toBeGreaterThan(0);
    for (const line of broadcasts) expect(line).toContain("ROSTER_TASK_WINDOW");
  });
});
