import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TASK_PICKER_DISMISS_MS,
  TASK_RENAME_HINT,
  ConversationTaskPicker,
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

describe("task list rendering", () => {
  // Same shape as the other component tests here: node, no jsdom, markup
  // through renderToStaticMarkup with the menu rendered open.
  const now = Date.parse("2026-09-19T15:00:00-04:00");
  const at = (iso: string) => Date.parse(iso);
  const noop = () => {};
  const tasks = [
    { threadId: "chat", title: "Plan the launch", createdAt: at("2026-09-19T09:00:00-04:00"), usage: { input: 600_000, output: 74_000, costUsd: null, turns: 3 } },
    { threadId: "old", title: "Last week's thing", createdAt: at("2026-09-12T00:06:00-04:00") },
    { threadId: "peer", title: "[Delegated by @Kessler] Check invoices", createdAt: at("2026-09-18T08:00:00-04:00"), unread: true },
    { threadId: "run-2", title: "Morning brief", createdAt: at("2026-09-19T07:00:00-04:00"), busy: true },
    { threadId: "run-1", title: "Morning brief", createdAt: at("2026-09-18T07:00:00-04:00") },
    { threadId: "empty", title: "New task", createdAt: at("2026-09-19T10:00:00-04:00") },
  ];
  const render = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(ConversationTaskPicker, {
        threadId: "chat",
        tasks,
        busy: false,
        onNew: noop,
        onSwitch: noop,
        onRename: noop,
        onDelete: noop,
        onTogglePin: noop,
        routineOf: (threadId: string) => (threadId.startsWith("run-") ? { routineId: "brief", routineName: "Morning brief" } : undefined),
        initialOpen: true,
        now,
        timeZone: "America/New_York",
        locale: "en-US",
        ...extra,
      }),
    );

  it("labels each date group and ties the group to its header", () => {
    const html = render();
    for (const label of ["Today", "Yesterday", "Previous 7 days"]) {
      const id = html.match(new RegExp(`id="([^"]+)"[^>]*>${label}<`))?.[1];
      expect(id, label).toBeTruthy();
      expect(html).toContain(`role="group" aria-labelledby="${id}"`);
    }
  });

  it("shows a date, not a bare time, for an older task", () => {
    const html = render();
    expect(html).toContain("Sep 12");
    expect(html).not.toContain(">12:06 AM<");
  });

  it("names the token unit and keeps the split in the hover detail", () => {
    const html = render();
    expect(html).toContain("674k tokens");
    expect(html).toContain('title="674,000 tokens · 600,000 in · 74,000 out · 3 turns"');
  });

  it("reads a handoff title as its sender with a badge", () => {
    const html = render();
    expect(html).toContain("From Kessler: Check invoices");
    expect(html).not.toContain(">[Delegated by @Kessler]");
    expect(html).toContain(">Delegated<");
  });

  it("folds routine runs into one expandable row with the latest run's status", () => {
    const html = render();
    expect(html).toContain("Morning brief · 2 runs");
    expect(html).toMatch(/aria-expanded="false"[^>]*>|aria-expanded="false"/);
    expect(html).toContain("Working");
  });

  it("offers the filters and the sort, and hides an empty untitled task", () => {
    const html = render();
    for (const chip of ["All", "Chats", "Routines", "From other bots", "Unread"]) {
      expect(html).toMatch(new RegExp(`aria-pressed="(true|false)"[^>]*>${chip}<`));
    }
    expect(html).toContain('aria-label="Sort tasks"');
    expect(html).toContain(">Last activity<");
    expect(html).toContain(">Created<");
    expect(html).not.toContain(">New task</div>");
  });
});
