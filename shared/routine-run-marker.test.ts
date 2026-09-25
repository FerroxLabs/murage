// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The line between two runs in a routine's conversation, and the note that
// tells the engine a repeated instruction is a new run, not the owner
// repeating himself (0.1.60 Mac pass, defect 3).
import { describe, expect, it } from "vitest";
import { routineRunMarker, routineRunMarkerName, routineRunPromptNote } from "./routine-run-marker";

describe("the run marker in a routine's conversation", () => {
  it("names the kind of run and the routine", () => {
    expect(routineRunMarkerName("manual", "Log tick")).toBe("Run now: Log tick");
    expect(routineRunMarkerName("schedule", "Log tick")).toBe("Scheduled run: Log tick");
  });

  it("reads back only the server's own marker row", () => {
    const row = (name: string, extra: Record<string, unknown> = {}) => ({ role: "bot" as const, kind: "activity" as const, tool: { name, ok: true }, ...extra });
    expect(routineRunMarker(row("Run now: Log tick"))).toEqual({ trigger: "manual", routineName: "Log tick" });
    expect(routineRunMarker(row("Scheduled run: Morning sweep: news"))).toEqual({ trigger: "schedule", routineName: "Morning sweep: news" });
    // a tool call a turn made is never a marker, whatever it is called
    expect(routineRunMarker(row("Run now: Log tick", { turnId: "t1" }))).toBeUndefined();
    expect(routineRunMarker({ ...row("Run now: Log tick"), tool: { name: "Run now: Log tick", ok: false } })).toBeUndefined();
    expect(routineRunMarker({ ...row("Run now: Log tick"), role: "user" as const })).toBeUndefined();
    expect(routineRunMarker(row("Run now:"))).toBeUndefined();
    expect(routineRunMarker(row("Bash: ls"))).toBeUndefined();
  });

  it("tells the engine this is a new run of the routine", () => {
    const note = routineRunPromptNote("schedule", "Log tick");
    expect(note).toContain('scheduled run of the routine "Log tick"');
    expect(note).toMatch(/earlier runs/i);
    expect(note).toMatch(/not the owner repeating/i);
    expect(routineRunPromptNote("manual", "Log tick")).toContain('run of the routine "Log tick" that the owner started with Run now');
    expect(note).not.toMatch(/—/);
  });
});
