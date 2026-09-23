import { describe, expect, it } from "vitest";
import { routineHealthNotes, routineOverlapHelp } from "./routine-health";

describe("routine health notes (upstream #1564)", () => {
  it("says nothing for a healthy routine", () => {
    expect(routineHealthNotes({})).toEqual([]);
  });

  it("reports a failure streak and skipped occurrences", () => {
    expect(routineHealthNotes({ failureStreak: 1 })).toEqual([{ tone: "danger", text: "The last run failed." }]);
    const notes = routineHealthNotes({ failureStreak: 3, skippedRuns: 2, lastSkippedAt: new Date(2026, 8, 20, 9, 0).getTime() });
    expect(notes[0]).toEqual({ tone: "danger", text: "The last 3 runs failed." });
    expect(notes[1]!.tone).toBe("muted");
    expect(notes[1]!.text).toMatch(/^Skipped 2 scheduled times because a run was still going, most recently .+\.$/);
  });

  it("explains both overlap choices without em dashes", () => {
    expect(routineOverlapHelp("queue")).toContain("One scheduled run waits");
    expect(routineOverlapHelp("skip")).toContain("skipped");
    expect(routineOverlapHelp("queue") + routineOverlapHelp("skip")).not.toContain("—");
  });
});
