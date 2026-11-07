// UX L5B: the routine sheet model, the All routines list and the phone day buckets.
import { describe, expect, it } from "vitest";
import type { Routine, RoutineRun } from "./routines";
import {
  occurrenceWords,
  ROUTINE_LIST_GROUP_AT,
  routineDayBuckets,
  routineListModel,
  routineNeedsLook,
  routineSheetModel,
  runLimitWords,
  scheduleWords,
} from "./routine-sheet-model";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, 5 + day, hour, minute).getTime();
const NOW = at(0, 10);
const max = { id: "max", name: "Max", autoApprove: true, fullAccess: false };
const nova = { id: "nova", name: "Nova", autoApprove: false, fullAccess: false };
const bots = [max, nova];
const groups = [{ id: "g1", name: "Launch" }];

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: "r1", name: "Morning brief", prompt: "Send me a brief", target: "bot", botId: "max", runOn: "ember", enabled: true,
    schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: null, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function run(id: string, over: Partial<RoutineRun> = {}): RoutineRun {
  return { id, routineId: "r1", routineName: "Morning brief", target: "bot", botId: "max", runOn: "ember", scheduledFor: at(-1, 8), status: "completed", manual: false, createdAt: 0, ...over };
}

describe("routineSheetModel", () => {
  it("L5B-SHEET-DETAILS: carries the instructions, file names, run limit and health notes", () => {
    const model = routineSheetModel(routine({
      prompt: "  Read the inbox.\nWrite me three lines.  ",
      attachments: [{ id: "a1", kind: "file", name: "brief.pdf", path: "/secret/place/brief.pdf", size: 10 }],
      timeoutMinutes: 90,
      failureStreak: 2,
      skippedRuns: 1,
      carryLastReport: true,
    }), [], bots, groups, NOW);
    expect(model.instructions).toBe("Read the inbox.\nWrite me three lines.");
    // Names only: the sheet never needs a file's path.
    expect(model.attachments).toEqual([{ id: "a1", name: "brief.pdf" }]);
    expect(model.runLimitText).toBe("Stops if still running after 1 hr 30 min");
    expect(model.healthNotes.map((note) => note.text)).toEqual(["The last 2 runs failed.", "Skipped 1 scheduled time because a run was still going."]);
    expect(model.carriesLastReport).toBe(true);
  });

  it("L5B-SHEET-DETAILS: no limit, no files, no notes say so plainly", () => {
    const model = routineSheetModel(routine({ schedule: { type: "once", at: at(1, 9) }, carryLastReport: true }), [], bots, groups, NOW);
    expect(model.runLimitText).toBe("No time limit");
    expect(model.attachments).toEqual([]);
    expect(model.healthNotes).toEqual([]);
    expect(model.carriesLastReport).toBe(false);
    expect(runLimitWords(45)).toBe("Stops if still running after 45 min");
    expect(runLimitWords(120)).toBe("Stops if still running after 2 hr");
  });

  it("names Who, When, the level it follows and where it reports", () => {
    const model = routineSheetModel(routine(), [], bots, groups, NOW);
    expect(model.who?.name).toBe("Max");
    expect(model.whenText).toMatch(/^Every weekday at 8:00/);
    expect(model.level).toEqual({ mode: "auto", own: false, text: "Follows Max's level (Auto)" });
    expect(model.reportsTo).toBe("Max's chat");
    expect(model.nextAt).toBe(at(1, 8));
  });

  it("a routine with its own level shows the lower of its level and its bot's", () => {
    expect(routineSheetModel(routine({ permissionMode: "ask" }), [], bots, groups, NOW).level.text).toBe("Its own level (Ask)");
    expect(routineSheetModel(routine({ permissionMode: "full" }), [], bots, groups, NOW).level.text).toBe("Its own level (Auto)");
  });

  it("reports to the Routines list, or to a team goal's channel", () => {
    expect(routineSheetModel(routine({ deliverTo: "list" }), [], bots, groups, NOW).reportsTo).toBe("The Routines list only");
    expect(routineSheetModel(routine({ target: "room-goal", groupId: "g1" }), [], bots, groups, NOW).reportsTo).toBe("The Launch channel");
  });

  it("keeps the last five runs, newest first", () => {
    const runs = Array.from({ length: 7 }, (_, i) => run(`run${i}`, { scheduledFor: at(-7 + i, 8) }));
    const model = routineSheetModel(routine(), runs, bots, groups, NOW);
    expect(model.lastRuns.map((r) => r.id)).toEqual(["run6", "run5", "run4", "run3", "run2"]);
  });

  it("a paused routine has no next run; a run under way makes it busy", () => {
    expect(routineSheetModel(routine({ enabled: false }), [], bots, groups, NOW)).toMatchObject({ paused: true, nextAt: null });
    expect(routineSheetModel(routine(), [run("live", { status: "running" })], bots, groups, NOW).busy).toBe(true);
  });
});

describe("routineNeedsLook", () => {
  it("is on for a failed last run, a failure streak or a run waiting on the owner", () => {
    expect(routineNeedsLook(routine(), [run("a", { status: "failed" })])).toBe(true);
    expect(routineNeedsLook(routine({ failureStreak: 2 }), [])).toBe(true);
    expect(routineNeedsLook(routine(), [run("a", { status: "waiting" })])).toBe(true);
  });
  it("is off once a later run finished", () => {
    expect(routineNeedsLook(routine(), [run("old", { status: "failed", scheduledFor: at(-2, 8) }), run("new", { status: "completed", scheduledFor: at(-1, 8) })])).toBe(false);
  });
});

describe("routineListModel", () => {
  it("up to ten routines: one list by name, no filter box", () => {
    const list = routineListModel([routine({ id: "b", name: "B" }), routine({ id: "a", name: "A" })], [], bots, { now: NOW, filter: "zzz" });
    expect(list.large).toBe(false);
    expect(list.sections).toHaveLength(1);
    expect(list.sections[0]!.routines.map((r) => r.name)).toEqual(["A", "B"]);
  });

  it("past ten: Failed this week first, then grouped by bot; the filter narrows", () => {
    const many = Array.from({ length: ROUTINE_LIST_GROUP_AT + 1 }, (_, i) => routine({ id: `r${i}`, name: `Job ${String(i).padStart(2, "0")}`, botId: i % 2 ? "nova" : "max" }));
    const runs = [run("bad", { routineId: "r3", status: "failed", finishedAt: at(-2, 9) }), run("old", { routineId: "r4", status: "failed", finishedAt: at(-9, 9) })];
    const list = routineListModel(many, runs, bots, { now: NOW });
    expect(list.large).toBe(true);
    expect(list.sections.map((s) => s.title)).toEqual(["Failed this week", "Max", "Nova"]);
    expect(list.sections[0]!.routines.map((r) => r.id)).toEqual(["r3"]);
    expect(list.sections.flatMap((s) => s.routines)).toHaveLength(many.length);
    const filtered = routineListModel(many, runs, bots, { now: NOW, filter: "nova" });
    expect(filtered.sections.flatMap((s) => s.routines).every((r) => r.botId === "nova")).toBe(true);
  });
});

describe("routineDayBuckets", () => {
  it("splits by next run into Today, Tomorrow and Later this week, leaving out paused ones", () => {
    const buckets = routineDayBuckets([
      routine({ id: "today", schedule: { type: "once", at: at(0, 15) } }),
      routine({ id: "tomorrow", schedule: { type: "daily", time: "08:00", weekdays: [5] } }),
      routine({ id: "later", schedule: { type: "daily", time: "08:00", weekdays: [1] } }),
      routine({ id: "far", schedule: { type: "once", at: at(9, 8) } }),
      routine({ id: "paused", enabled: false, schedule: { type: "once", at: at(0, 16) } }),
    ], NOW);
    expect(buckets.today.map((e) => e.routine.id)).toEqual(["today"]);
    expect(buckets.tomorrow.map((e) => e.routine.id)).toEqual(["tomorrow"]);
    expect(buckets.later.map((e) => e.routine.id)).toEqual(["later"]);
  });
});

describe("words", () => {
  it("reads schedules back plainly", () => {
    expect(scheduleWords({ type: "interval", everyMinutes: 60, anchorAt: NOW }, NOW)).toBe("Every hour");
    expect(scheduleWords({ type: "interval", everyMinutes: 120, anchorAt: NOW }, NOW)).toBe("Every 2 hours");
    expect(scheduleWords({ type: "interval", everyMinutes: 15, anchorAt: NOW }, NOW)).toBe("Every 15 minutes");
    expect(scheduleWords({ type: "daily", time: "09:00", weekdays: [0, 6] }, NOW)).toMatch(/^Every weekend at 9:00/);
  });
  it("a run older than today carries its date, not only a weekday (Astra r1 Medium 9)", () => {
    const words = occurrenceWords(at(-9, 8), NOW);
    expect(words).toContain(new Date(at(-9, 8)).toLocaleDateString([], { month: "long", day: "numeric" }));
    expect(occurrenceWords(at(2, 8), NOW)).not.toContain(new Date(at(2, 8)).toLocaleDateString([], { month: "long" }));
  });
});
