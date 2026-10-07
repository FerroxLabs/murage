// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-X 13.2: the sidebar's shared rows, the work thread's header and
// closed state, the task switcher's Team work, all from one set of helpers.
import { expect, it } from "vitest";
import { SHARING_COPY, activeWorkThread, allTeamsLine, cannotShareLine, closedComposerLine, closedWorkThreadLine, noLearnedSkillsLine, notesAfterConflict, sharedIntoTeam, sharedRowLabel, sharedRowStatus, sharedRowsForSection, sharingLoadLine, teamsLosingRunningWork, workThreadHeader, workThreadRequest } from "./shared-teams";
import { buildTaskListView } from "./task-list";

const iris = {
  id: "iris", name: "Iris", threadId: "home", section: "Design",
  sharedRows: [
    { teamId: "sales", teamName: "Sales", threadId: null, working: false, waiting: 0 },
    { teamId: "support", teamName: "Support", threadId: "work-support", working: true, waiting: 1 },
  ],
  tasks: [{ threadId: "home" }, { threadId: "work-support", sharedWork: { teamId: "support", teamName: "Support", createdAt: 1 } }],
};
const zed = { id: "zed", name: "Zed", threadId: "z", section: "Support", sharedRows: [{ teamId: "sales", teamName: "Sales", threadId: null }] };
const carl = { id: "carl", name: "Carl", threadId: "c", section: "Design" };

it("sidebar rows: under each covered team, never under the bot's home team or General, and hidden bots never", () => {
  expect(sharedRowsForSection([zed, iris, carl], "Sales").map(({ bot }) => bot.name)).toEqual(["Iris", "Zed"]);
  expect(sharedRowsForSection([iris], "Design")).toEqual([]);
  expect(sharedRowsForSection([iris], "")).toEqual([]);
  expect(sharedRowsForSection([{ ...iris, hidden: true }], "Sales")).toEqual([]);
  expect(sharedRowLabel("Iris", "Design")).toBe("Iris · shared from Design");
  expect(sharedRowLabel("Iris", "")).toBe("Iris · shared from General");
  expect(sharedRowStatus(iris.sharedRows[1])).toBe("working");
  expect(sharedRowStatus({ working: false, waiting: 2 })).toBe("2 waiting");
  expect(sharedRowStatus(iris.sharedRows[0])).toBe("");
  expect(sharedIntoTeam([iris, zed], "Sales").map(entry => `${entry.bot.name}<${entry.from}`)).toEqual(["Iris<Design", "Zed<Support"]);
});

it("work thread: the header names the team and the bot, and a closed thread locks the composer with the 10.1 line", () => {
  const open = { ...iris, threadId: "work-support" };
  expect(activeWorkThread(open)?.teamName).toBe("Support");
  expect(workThreadHeader("Iris", "Sales")).toBe("Work for Sales. Iris follows the Sales brief and Iris's Sales notes here.");
  expect(closedComposerLine(open)).toBeNull();
  const closed = { ...open, tasks: [{ threadId: "work-support", sharedWork: { teamId: "support", teamName: "Support", createdAt: 1, closedAt: 5, closedReason: "revoked" as const } }] };
  expect(closedComposerLine(closed)).toBe("Iris is no longer shared with Support. This conversation is kept for reading.");
  expect(closedWorkThreadLine("Iris", { teamName: "Sales", closedReason: "team-deleted" })).toBe("Sales was deleted. This conversation is kept for reading.");
  // the bot's own conversation is never locked
  expect(closedComposerLine(iris)).toBeNull();
});

it("task switcher: work threads sit under Team work, after the bot's own conversations", () => {
  const tasks = [
    { threadId: "home", title: "Direct chat", createdAt: 3, lastActivityAt: 3 },
    { threadId: "work-sales", title: "Work for Sales", createdAt: 2, lastActivityAt: 4, sharedWork: { teamId: "sales" } },
  ];
  const view = buildTaskListView(tasks, { query: "", filter: "all", sort: "activity", now: 10, activeId: "home", routineOf: () => undefined, expanded: new Set() } as never);
  expect(view.sections.at(-1)).toMatchObject({ key: "team-work", label: "Team work" });
  expect(view.sections.at(-1)!.entries.map(entry => entry.type === "task" && entry.task.threadId)).toEqual(["work-sales"]);
  expect(view.sections.slice(0, -1).flatMap(section => section.entries).some(entry => entry.type === "task" && entry.task.threadId === "work-sales")).toBe(false);
});

it("load and running-work choices", () => {
  expect(sharingLoadLine([{ teamId: "s", name: "Sales", running: 1, queued: 0, waitingOnYou: 0 }, { teamId: "t", name: "Support", running: 0, queued: 2, waitingOnYou: 0 }])).toBe("Working for Sales · 2 waiting from Support");
  expect(allTeamsLine([])).toBe("Covers any team you add later.");
  const view = { teams: [{ id: "s", name: "Sales", covered: true, selectable: true }, { id: "t", name: "Support", covered: true, selectable: true }], load: [{ teamId: "s", name: "Sales", running: 1, queued: 0, waitingOnYou: 0 }] };
  expect(teamsLosingRunningWork(view, { mode: "list", teamIds: ["t"] })).toEqual(["Sales"]);
  expect(teamsLosingRunningWork(view, { mode: "list", teamIds: ["s"] })).toEqual([]);
  expect(teamsLosingRunningWork(view, { mode: "all", teamIds: [] })).toEqual([]);
  expect(teamsLosingRunningWork(view, { mode: "none", teamIds: [] })).toEqual(["Sales"]);
});

it("R4 a row with no team id yet opens its work thread by the team's name", () => {
  expect(workThreadRequest({ teamId: "sales", teamName: "Sales" })).toEqual({ teamId: "sales" });
  expect(workThreadRequest({ teamId: null, teamName: "Sales" })).toEqual({ teamName: "Sales" });
  expect(sharedRowsForSection([{ ...zed, sharedRows: [{ teamId: null, teamName: "Sales", threadId: null }] }], "Sales")).toHaveLength(1);
});

it("R4 a 409 on the notes keeps the owner's draft and shows the newer notes", () => {
  expect(notesAfterConflict("MY_DRAFT", { text: "THEIR_NOTES", revision: "r2" })).toEqual({ text: "MY_DRAFT", saved: "THEIR_NOTES", revision: "r2", newer: "THEIR_NOTES" });
  expect(SHARING_COPY.notesChanged).not.toContain("\u2014");
});

it("R4 copy names the bot, never a pronoun", () => {
  expect(noLearnedSkillsLine("Iris")).toBe("Iris has not learned a skill yet.");
  expect(cannotShareLine("Iris")).toBe("An Individual Assistant or the Chief of Staff works for you alone, so Iris is not shared with teams.");
  for (const text of [noLearnedSkillsLine("Iris"), cannotShareLine("Iris")]) expect(text).not.toMatch(/\b(its|it)\b/i);
});
