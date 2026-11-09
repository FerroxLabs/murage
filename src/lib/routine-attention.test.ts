import { describe, expect, it } from "vitest";
import { hasRoutineAttention } from "./routine-attention";

describe("routine attention ignores orphan history", () => {
  const run = { status: "failed", routineId: "routine", botId: "bot" };
  const routines = [{ id: "routine" }], bots = [{ id: "bot" }], groups = [{ id: "room" }];
  it("requires the definition and bot, including for missed runs", () => {
    for (const status of ["failed", "missed"]) {
      expect(hasRoutineAttention([{ ...run, status }], routines, bots, [])).toBe(true);
      expect(hasRoutineAttention([{ ...run, status }], [], bots, [])).toBe(false);
      expect(hasRoutineAttention([{ ...run, status }], routines, [], [])).toBe(false);
    }
  });
  it("requires a room when the run belongs to one, and respects seen and completed states", () => {
    expect(hasRoutineAttention([{ ...run, groupId: "room" }], routines, bots, groups)).toBe(true);
    expect(hasRoutineAttention([{ ...run, groupId: "room" }], routines, bots, [])).toBe(false);
    expect(hasRoutineAttention([{ ...run, seenAt: 1 }], routines, bots, groups)).toBe(false);
    expect(hasRoutineAttention([{ ...run, status: "completed" }], routines, bots, groups)).toBe(false);
  });
});
