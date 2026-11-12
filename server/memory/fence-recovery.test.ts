// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { fenceVerdict } from "./deny-read.ts";

describe("bounded fence recovery", () => {
  it("R7 rebuilds selectively then message-only, at most twice", async () => {
    const { FENCE_REBUILDS, nextFenceTier } = await import("./fence-recovery.ts");
    expect(FENCE_REBUILDS).toBe(2);
    expect([0, 1, 2, 3, -1, NaN, .5].map(nextFenceTier)).toEqual([{ tier: 1 }, { tier: 2 }, undefined, undefined, undefined, undefined, undefined]);
  });
  it("R8 real message-only prompt uses raw human input and never queries the database", async () => {
    const { messageOnlyPrompt } = await import("./fence-recovery.ts");
    const prompt = messageOnlyPrompt(undefined, { rawHumanText: "raw human words", frame: "static frame", now: "time" });
    const db = new Proxy({}, { get() { throw new Error("database must not be touched"); } }) as DatabaseSync;
    expect(fenceVerdict(db, prompt, { audience: null })).toEqual({ state: "shown" });
    expect(prompt.text).toContain("raw human words");
    expect(prompt.parts.every(p => p.lineageOf.length && p.lineageOf.every(r => r.kind === "none"))).toBe(true);
    expect(messageOnlyPrompt(undefined, { rawHumanText: undefined, frame: "static frame", now: "time" }).text).not.toContain("undefined");
  });
  it("R9 notes are calm, truthful for changed/checking/unknown causes and absent without an omission", async () => {
    const { recoveryNote } = await import("./fence-recovery.ts");
    expect(recoveryNote(0, { omitted: 0, cause: "checking" })).toBeNull();
    for (const cause of ["checking", "changed", "unknown"] as const) {
      expect(recoveryNote(1, { omitted: 1, cause })?.line).toBeTruthy();
      expect(recoveryNote(2, { omitted: 1, cause })?.kind).toBe("message-only");
      expect(recoveryNote(0, { omitted: 1, cause })?.line).toBeTruthy();
      if (cause !== "checking") expect(recoveryNote(1, { omitted: 1, cause })?.line).not.toMatch(/finishes|few/);
    }
  });
});
