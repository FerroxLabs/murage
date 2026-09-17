import { describe, expect, it } from "vitest";

import {
  TASK_PICKER_DISMISS_MS,
  TASK_RENAME_HINT,
  filterTasks,
  orderPickerTasks,
  taskPickerPointerIntent,
} from "./TaskPicker";

describe("taskPickerPointerIntent", () => {
  it("treats a single click as switch, not rename", () => {
    expect(taskPickerPointerIntent("click", 1)).toBe("select");
    expect(taskPickerPointerIntent("click")).toBe("select");
  });

  it("does not let the click that accompanies a double-click close the row", () => {
    // HTML fires click (detail=1), click (detail=2), then dblclick. Closing
    // on the first of those unmounts the menu before rename can start.
    expect(taskPickerPointerIntent("click", 2)).toBe("ignore");
    expect(taskPickerPointerIntent("dblclick", 2)).toBe("rename");
  });

  it("starts a rename from right-click", () => {
    expect(taskPickerPointerIntent("contextmenu")).toBe("rename");
  });

  it("ignores unrelated events", () => {
    expect(taskPickerPointerIntent("mousedown")).toBe("ignore");
  });
});

describe("task picker copy", () => {
  it("advertises both gestures the row actually handles", () => {
    expect(TASK_RENAME_HINT).toContain("double-click");
    expect(TASK_RENAME_HINT).toContain("right-click");
    expect(TASK_PICKER_DISMISS_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("filterTasks", () => {
  const tasks = [
    { title: "Clean up" },
    { title: "Murage Update" },
    { title: "Investment report" },
    { title: "Report drafts" },
  ];

  it("returns the original order when the query is empty", () => {
    expect(filterTasks(tasks, "").map((task) => task.title)).toEqual(tasks.map((task) => task.title));
    expect(filterTasks(tasks, "   ").map((task) => task.title)).toEqual(tasks.map((task) => task.title));
  });

  it("matches titles case-insensitively", () => {
    expect(filterTasks(tasks, "murage").map((task) => task.title)).toEqual(["Murage Update"]);
  });

  it("ranks prefix hits ahead of substring hits, keeping input order in each tier", () => {
    expect(filterTasks(tasks, "report").map((task) => task.title)).toEqual([
      "Report drafts",
      "Investment report",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterTasks(tasks, "zzzz")).toEqual([]);
  });
});

describe("orderPickerTasks", () => {
  const tasks = [
    { threadId: "c", title: "Newest", createdAt: 3 },
    { threadId: "b", title: "Pinned report", createdAt: 2, pinned: true },
    { threadId: "a", title: "Oldest pinned", createdAt: 1, pinned: true },
  ];

  it("lists pinned tasks first and keeps the existing order inside each group", () => {
    expect(orderPickerTasks(tasks).map((task) => task.threadId)).toEqual(["b", "a", "c"]);
    const single: { threadId: string; title: string; pinned?: boolean }[] = [{ threadId: "x", title: "x" }];
    expect(orderPickerTasks(single)).toEqual(single);
  });

  it("returns an unpinned task to its recency slot", () => {
    const unpinned = tasks.map((task) => (task.threadId === "b" ? { ...task, pinned: undefined } : task));
    expect(orderPickerTasks(unpinned).map((task) => task.threadId)).toEqual(["a", "c", "b"]);
  });

  it("still filters pinned tasks by search", () => {
    expect(filterTasks(orderPickerTasks(tasks), "newest").map((task) => task.threadId)).toEqual(["c"]);
    expect(filterTasks(orderPickerTasks(tasks), "pinned").map((task) => task.threadId)).toEqual(["b", "a"]);
  });
});
