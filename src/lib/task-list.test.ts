import { describe, expect, it } from "vitest";

import {
  buildTaskListView,
  dateBucket,
  formatTaskTokenLabel,
  formatTaskWhen,
  groupTasksByDate,
  isHiddenEmptyTask,
  readableTaskTitle,
  sortTasks,
  taskKind,
  type RoutineRef,
  type TaskListTask,
} from "./task-list";

const NY = { timeZone: "America/New_York", locale: "en-US" } as const;
const UTC = { timeZone: "UTC", locale: "en-US" } as const;
/** Wall-clock time in New York, spelled with its offset so the test reads
 * the same whatever zone the machine running it is in. */
const ny = (iso: string) => Date.parse(iso);

describe("dateBucket", () => {
  const now = ny("2026-09-19T00:00:30-04:00");

  it("splits today from yesterday exactly at local midnight", () => {
    expect(dateBucket(ny("2026-09-19T00:00:00-04:00"), now, NY).label).toBe("Today");
    expect(dateBucket(ny("2026-09-18T23:59:59-04:00"), now, NY).label).toBe("Yesterday");
    // the same instant is still "today" in UTC, where it is 03:59
    expect(dateBucket(ny("2026-09-18T23:59:59-04:00"), now, UTC).label).toBe("Today");
  });

  it("files the last week, the rest of this month, then one group per month", () => {
    const at = (iso: string) => dateBucket(ny(iso), ny("2026-09-19T12:00:00-04:00"), NY).label;
    expect(at("2026-09-17T08:00:00-04:00")).toBe("Previous 7 days");
    expect(at("2026-09-12T08:00:00-04:00")).toBe("Previous 7 days");
    expect(at("2026-09-11T08:00:00-04:00")).toBe("Earlier this month");
    expect(at("2026-09-01T00:10:00-04:00")).toBe("Earlier this month");
    expect(at("2026-08-31T23:00:00-04:00")).toBe("August 2026");
    expect(at("2026-01-02T10:00:00-05:00")).toBe("January 2026");
    expect(at("2025-09-30T10:00:00-04:00")).toBe("September 2025");
  });

  it("counts calendar days, not 24-hour blocks, across daylight saving changes", () => {
    // clocks went back an hour on 1 Nov 2026: yesterday was 25 hours long
    const afterFallBack = ny("2026-11-02T00:30:00-05:00");
    expect(dateBucket(ny("2026-11-01T00:10:00-04:00"), afterFallBack, NY).label).toBe("Yesterday");
    expect(dateBucket(ny("2026-10-31T23:50:00-04:00"), afterFallBack, NY).label).toBe("Previous 7 days");
    // clocks went forward on 8 Mar 2026: that day was 23 hours long
    const afterSpring = ny("2026-03-09T00:20:00-04:00");
    expect(dateBucket(ny("2026-03-08T00:30:00-05:00"), afterSpring, NY).label).toBe("Yesterday");
    expect(dateBucket(ny("2026-03-07T23:30:00-05:00"), afterSpring, NY).label).toBe("Previous 7 days");
  });

  it("handles a year change", () => {
    const newYear = ny("2027-01-01T09:00:00-05:00");
    expect(dateBucket(ny("2026-12-31T22:00:00-05:00"), newYear, NY).label).toBe("Yesterday");
    expect(dateBucket(ny("2026-12-25T10:00:00-05:00"), newYear, NY).label).toBe("Previous 7 days");
    expect(dateBucket(ny("2026-12-24T10:00:00-05:00"), newYear, NY).label).toBe("December 2026");
  });

  it("treats a timestamp slightly in the future (clock skew) as today", () => {
    expect(dateBucket(now + 60_000, now, NY).label).toBe("Today");
  });
});

describe("formatTaskWhen", () => {
  const now = ny("2026-09-19T15:00:00-04:00");
  it("shows a time for today and yesterday, a short date after that", () => {
    expect(formatTaskWhen(ny("2026-09-19T00:06:00-04:00"), now, NY)).toBe("12:06 AM");
    expect(formatTaskWhen(ny("2026-09-18T00:06:00-04:00"), now, NY)).toBe("12:06 AM");
    // last week's "12:06 AM" must not look like today's
    expect(formatTaskWhen(ny("2026-09-12T00:06:00-04:00"), now, NY)).toBe("Sep 12");
    expect(formatTaskWhen(ny("2025-12-10T09:00:00-05:00"), now, NY)).toBe("Dec 10, 2025");
  });
});

const task = (threadId: string, iso: string, extra: Partial<TaskListTask> = {}): TaskListTask => ({
  threadId,
  title: threadId,
  createdAt: ny(iso),
  ...extra,
});

describe("groupTasksByDate", () => {
  const now = ny("2026-09-19T12:00:00-04:00");
  it("puts pinned tasks first whatever their date, then date groups in order", () => {
    const groups = groupTasksByDate(
      sortTasks([
        task("old-pinned", "2026-07-01T10:00:00-04:00", { pinned: true }),
        task("today", "2026-09-19T09:00:00-04:00"),
        task("august", "2026-08-02T09:00:00-04:00"),
        task("yesterday", "2026-09-18T09:00:00-04:00"),
      ], "activity"),
      { now, sort: "activity", ...NY },
    );
    expect(groups.map((group) => [group.label, group.items.map((item) => item.threadId)])).toEqual([
      ["Pinned", ["old-pinned"]],
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["August 2026", ["august"]],
    ]);
  });
});

describe("sortTasks", () => {
  const tasks = [
    task("made-first-used-today", "2026-09-01T09:00:00-04:00", { lastActivityAt: ny("2026-09-19T11:00:00-04:00") }),
    task("made-yesterday-idle", "2026-09-18T09:00:00-04:00"),
    task("made-today-idle", "2026-09-19T08:00:00-04:00"),
  ];
  it("orders by last activity, falling back to creation for a task with no messages", () => {
    expect(sortTasks(tasks, "activity").map((t) => t.threadId)).toEqual([
      "made-first-used-today",
      "made-today-idle",
      "made-yesterday-idle",
    ]);
  });
  it("orders by creation when asked", () => {
    expect(sortTasks(tasks, "created").map((t) => t.threadId)).toEqual([
      "made-today-idle",
      "made-yesterday-idle",
      "made-first-used-today",
    ]);
  });
});

describe("readableTaskTitle", () => {
  it("rewrites a peer message prefix into a sender and the text", () => {
    expect(readableTaskTitle("[Message from @Kessler] Check the invoices")).toEqual({
      text: "From Kessler: Check the invoices",
      from: "Kessler",
      via: "message",
    });
    expect(readableTaskTitle("[Delegated by @Sable] Draft the reply")).toEqual({
      text: "From Sable: Draft the reply",
      from: "Sable",
      via: "delegation",
    });
  });

  it("reads the long, truncated prefix older builds stored as the whole title", () => {
    expect(readableTaskTitle("[Message from @Kessler (Ops Manager), another b…")).toEqual({
      text: "From Kessler (Ops Manager)",
      from: "Kessler (Ops Manager)",
      via: "message",
    });
    expect(readableTaskTitle("[Delegated by @Katya, another bot in this Murag…").text).toBe("From Katya");
  });

  it("leaves ordinary titles alone", () => {
    expect(readableTaskTitle("Morning brief")).toEqual({ text: "Morning brief" });
    expect(readableTaskTitle("[draft] Message from @nobody")).toEqual({ text: "[draft] Message from @nobody" });
  });
});

describe("taskKind", () => {
  const routine: RoutineRef = { routineId: "r1", routineName: "Morning brief" };
  it("tells routine runs, bot handoffs and chats apart", () => {
    expect(taskKind({ title: "Morning brief" }, routine)).toBe("routine");
    expect(taskKind({ title: "[Delegated by @Sable] Draft" })).toBe("bot");
    expect(taskKind({ title: "Morning brief" })).toBe("chat");
  });
});

describe("isHiddenEmptyTask", () => {
  it("hides an untitled task with no messages unless it is the open one", () => {
    const empty = { threadId: "e", title: "New task", createdAt: 1 };
    expect(isHiddenEmptyTask(empty, "other")).toBe(true);
    expect(isHiddenEmptyTask(empty, "e")).toBe(false);
    expect(isHiddenEmptyTask({ ...empty, lastActivityAt: 2 }, "other")).toBe(false);
    expect(isHiddenEmptyTask({ ...empty, title: "Named" }, "other")).toBe(false);
    expect(isHiddenEmptyTask({ ...empty, busy: true }, "other")).toBe(false);
    expect(isHiddenEmptyTask({ ...empty, usage: { input: 1, output: 1, costUsd: null, turns: 1 } }, "other")).toBe(false);
  });
});

describe("formatTaskTokenLabel", () => {
  it("names the unit and puts the split in the detail", () => {
    const label = formatTaskTokenLabel({ input: 600_000, output: 74_000, cachedInput: 500_000, costUsd: 1.5, turns: 12 });
    expect(label?.label).toBe("674k tokens");
    expect(label?.detail).toBe("674,000 tokens · 600,000 in (500,000 cached) · 74,000 out · 12 turns · $1.50");
  });
  it("does not say tokens twice for small counts and skips an empty tally", () => {
    expect(formatTaskTokenLabel({ input: 1, output: 0, costUsd: null, turns: 1 })?.label).toBe("1 token");
    expect(formatTaskTokenLabel({ input: 0, output: 0, costUsd: null, turns: 0 })).toBeNull();
    expect(formatTaskTokenLabel(undefined)).toBeNull();
  });
});

describe("buildTaskListView", () => {
  const now = ny("2026-09-19T12:00:00-04:00");
  const brief: RoutineRef = { routineId: "brief", routineName: "Morning brief" };
  const tasks: TaskListTask[] = [
    task("chat", "2026-09-19T10:00:00-04:00", { title: "Plan the launch" }),
    task("run-3", "2026-09-19T07:00:00-04:00", { title: "Morning brief", unread: true }),
    task("run-2", "2026-09-18T07:00:00-04:00", { title: "Morning brief" }),
    task("run-1", "2026-09-10T07:00:00-04:00", { title: "Morning brief" }),
    task("peer", "2026-09-17T07:00:00-04:00", { title: "[Message from @Kessler] Check invoices", unread: true }),
    task("empty", "2026-09-19T11:00:00-04:00", { title: "New task" }),
    task("watch", "2026-09-16T07:00:00-04:00", { title: "Night watch" }),
  ];
  const routineOf = (threadId: string) =>
    threadId.startsWith("run-") ? brief : threadId === "watch" ? { routineId: "watch", routineName: "Night watch" } : undefined;
  const base = { query: "", filter: "all" as const, sort: "activity" as const, now, activeId: "chat", routineOf, expanded: new Set<string>(), ...NY };
  const shape = (view: ReturnType<typeof buildTaskListView>) =>
    view.sections.map((section) => [
      section.label,
      section.entries.map((entry) =>
        entry.type === "fold" ? `fold:${entry.name}:${entry.runs.length}${entry.expanded ? ":open" : ""}` : entry.task.threadId,
      ),
    ]);

  it("folds every run of a routine into one row at its latest run, and drops empty untitled tasks", () => {
    expect(shape(buildTaskListView(tasks, base))).toEqual([
      ["Today", ["chat", "fold:Morning brief:3"]],
      ["Previous 7 days", ["peer", "watch"]],
    ]);
  });

  it("lists the runs inside an expanded fold, newest first", () => {
    const view = buildTaskListView(tasks, { ...base, expanded: new Set(["brief"]) });
    const fold = view.sections[0]!.entries[1]!;
    expect(fold.type === "fold" && fold.runs.map((run) => run.threadId)).toEqual(["run-3", "run-2", "run-1"]);
    expect(fold.type === "fold" && fold.expanded).toBe(true);
    expect(view.navigable.map((task) => task.threadId)).toContain("run-1");
  });

  it("keeps an empty untitled task when it is the one open", () => {
    const view = buildTaskListView(tasks, { ...base, activeId: "empty" });
    expect(view.sections[0]!.entries.map((entry) => entry.type === "task" && entry.task.threadId)).toContain("empty");
  });

  it("filters by kind and unread", () => {
    expect(shape(buildTaskListView(tasks, { ...base, filter: "chats" }))).toEqual([["Today", ["chat"]]]);
    expect(shape(buildTaskListView(tasks, { ...base, filter: "routines" }))).toEqual([
      ["Today", ["fold:Morning brief:3"]],
      ["Previous 7 days", ["watch"]],
    ]);
    expect(shape(buildTaskListView(tasks, { ...base, filter: "bots" }))).toEqual([["Previous 7 days", ["peer"]]]);
    expect(shape(buildTaskListView(tasks, { ...base, filter: "unread" }))).toEqual([
      ["Today", ["run-3"]],
      ["Previous 7 days", ["peer"]],
    ]);
  });

  it("searches every task, raw or readable title, without folding and whatever the filter", () => {
    const raw = buildTaskListView(tasks, { ...base, filter: "chats", query: "message from" });
    expect(shape(raw)).toEqual([["Matches", ["peer"]]]);
    const readable = buildTaskListView(tasks, { ...base, filter: "chats", query: "from kessler" });
    expect(shape(readable)).toEqual([["Matches", ["peer"]]]);
    expect(shape(buildTaskListView(tasks, { ...base, query: "morning" }))).toEqual([["Matches", ["run-3", "run-2", "run-1"]]]);
  });

  it("groups by creation date when sorted by creation", () => {
    const moved = tasks.map((t) => (t.threadId === "run-1" ? { ...t, lastActivityAt: ny("2026-09-19T11:30:00-04:00") } : t));
    const byActivity = buildTaskListView(moved, { ...base, expanded: new Set(["brief"]) });
    const fold = byActivity.sections[0]!.entries.find((entry) => entry.type === "fold");
    expect(fold?.type === "fold" && fold.latest.threadId).toBe("run-1");
    const byCreated = buildTaskListView(moved, { ...base, sort: "created" });
    const createdFold = byCreated.sections[0]!.entries.find((entry) => entry.type === "fold");
    expect(createdFold?.type === "fold" && createdFold.latest.threadId).toBe("run-3");
  });

  it("does not fold a routine that ran once, and keeps pinned runs out of the fold", () => {
    const pinned = tasks.map((t) => (t.threadId === "run-2" ? { ...t, pinned: true } : t));
    expect(shape(buildTaskListView(pinned, base))).toEqual([
      ["Pinned", ["run-2"]],
      ["Today", ["chat", "fold:Morning brief:2"]],
      ["Previous 7 days", ["peer", "watch"]],
    ]);
  });
});
