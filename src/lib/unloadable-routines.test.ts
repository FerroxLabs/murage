// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { unloadableFromResponse, unloadableRoutineNote } from "./unloadable-routines";

describe("routines Murage kept but could not read", () => {
  it("says in plain words why it will not run, and what to do", () => {
    expect(unloadableRoutineNote("schedule")).toMatch(/^This routine's schedule could not be read, so it will not run\./);
    expect(unloadableRoutineNote("watch")).toMatch(/^This routine's file watch could not be read/);
    for (const reason of ["schedule", "watch"] as const) {
      expect(unloadableRoutineNote(reason)).toMatch(/Delete it/);
      expect(unloadableRoutineNote(reason)).not.toMatch(/\u2014|\u2013|\bsafe\b|\bunsafe\b/i);
    }
  });

  it("reads the list the routines endpoint returns, and ignores anything malformed", () => {
    expect(unloadableFromResponse({ unloadable: [{ id: "r1", name: "Weekly", botId: "b", reason: "schedule" }, { id: 4 }, null, { id: "r2", reason: "other" }] }))
      .toEqual([{ id: "r1", name: "Weekly", botId: "b", reason: "schedule" }]);
    expect(unloadableFromResponse({})).toEqual([]);
    expect(unloadableFromResponse(null)).toEqual([]);
  });
});
