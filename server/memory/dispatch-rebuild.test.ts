// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SETUP-LAST-RESORT: one rule for every rebuild of a turn refused over memory (direct setup, direct late write, room member), and a
// session check that ran out of its allowance says so instead of reading as a revoke.
import { describe, expect, it } from "vitest";
import { MEMORY_REDISPATCH_ATTEMPTS, nextMemoryRebuild, refusalCauseNote, sessionCheckRefusal } from "./dispatch.ts";

describe("nextMemoryRebuild", () => {
  it("rebuilds three times, and the third rebuild is the last resort; past it the turn ends with a card", () => {
    expect(MEMORY_REDISPATCH_ATTEMPTS).toBe(3);
    expect(nextMemoryRebuild(0)).toEqual({ attempt: 1, lastResort: false });
    expect(nextMemoryRebuild(1)).toEqual({ attempt: 2, lastResort: false });
    expect(nextMemoryRebuild(2)).toEqual({ attempt: 3, lastResort: true });
    expect(nextMemoryRebuild(3)).toBeUndefined();
    expect(nextMemoryRebuild(7)).toBeUndefined();
    expect(nextMemoryRebuild(Number.NaN)).toBeUndefined();
    expect(nextMemoryRebuild(-1)).toBeUndefined();
  });
});

describe("sessionCheckRefusal", () => {
  it("is always MEMORY_CONTEXT_REVOKED (fail closed), and marks a check that ran out of its allowance as unproven", () => {
    const timedOut = sessionCheckRefusal({ reason: "lineage-warming" });
    expect(timedOut.message).toBe("MEMORY_CONTEXT_REVOKED");
    expect((timedOut as Error & { unproven?: string }).unproven).toBe("lineage-warming");
    expect(refusalCauseNote(timedOut)).toBe("; the session check ran out of its lineage allowance (lineage-warming), not a revoke");
    for (const reason of ["receipt-revoked", "memory-changed", "checking", "lineage", undefined]) {
      const revoked = sessionCheckRefusal({ reason });
      expect(revoked.message).toBe("MEMORY_CONTEXT_REVOKED");
      expect((revoked as Error & { unproven?: string }).unproven).toBeUndefined();
      expect(refusalCauseNote(revoked)).toBe("");
    }
    expect(refusalCauseNote(new Error("MEMORY_CONTEXT_REVOKED"))).toBe("");
    expect(refusalCauseNote("not an error")).toBe("");
  });
});
