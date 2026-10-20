import { afterEach, describe, expect, it } from "vitest";
import { ceilingAdmits, ceilingReached, learningSpendLedgerId, learningSpendMonth, LEARNING_REFUSAL_REASONS, semanticStatusPhrase, SLICE_CALL_GUARD, SLICE_ATTEMPT_LIMIT, SLICE_CALL_LIMIT_REASON } from "./memory-learning-contract.ts";

describe("the I0 learning contract", () => {
  const tz = process.env.TZ;
  afterEach(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });

  it("names the month by the server-local clock", () => {
    const at = Date.parse("2026-09-30T17:30:00Z"); // Oct 1 00:30 in Bangkok, Sep 30 10:30 in Los Angeles
    process.env.TZ = "Asia/Bangkok"; expect(learningSpendMonth(at)).toBe("2026-10");
    process.env.TZ = "America/Los_Angeles"; expect(learningSpendMonth(at)).toBe("2026-09");
    expect(learningSpendLedgerId("2026-10")).toBe("learning-spend:2026-10");
  });

  it("admits a reserve only when both sides stay within the ceiling; a zero ceiling admits nothing", () => {
    const ceiling = { input: 1000, output: 100 };
    expect(ceilingAdmits(ceiling, { input: 900, output: 50 }, { input: 100, output: 50 })).toBe(true);
    expect(ceilingAdmits(ceiling, { input: 901, output: 50 }, { input: 100, output: 50 })).toBe(false);
    expect(ceilingAdmits(ceiling, { input: 0, output: 51 }, { input: 1, output: 50 })).toBe(false);
    expect(ceilingAdmits({ input: 0, output: 0 }, { input: 0, output: 0 }, { input: 1, output: 1 })).toBe(false);
    expect(ceilingReached(ceiling, { input: 1000, output: 0 })).toBe(true);
    expect(ceilingReached(ceiling, { input: 999, output: 99 })).toBe(false);
    expect(ceilingReached({ input: 0, output: 0 }, { input: 0, output: 0 })).toBe(true);
  });

  it("freezes the reasons and the per-slice limits", () => {
    expect(LEARNING_REFUSAL_REASONS).toContain("spend-ceiling");
    expect(LEARNING_REFUSAL_REASONS).toContain("budget-exhausted");
    expect(SLICE_CALL_LIMIT_REASON).toBe("slice-call-limit");
    expect([SLICE_ATTEMPT_LIMIT, SLICE_CALL_GUARD]).toEqual([3, 24]);
  });

  it("says what smart search is doing, with no dashes", () => {
    expect(semanticStatusPhrase({ state: "indexing", done: 1240, total: 3412 })).toBe("Indexing for smart search, 1,240 of 3,412.");
    expect(semanticStatusPhrase({ state: "indexing", done: 0, total: 0 })).toBe("Getting smart search ready.");
    expect(semanticStatusPhrase({ state: "ready", done: 3412, total: 3412 })).toBe("Smart search ready.");
    expect(semanticStatusPhrase({ state: "keyword-only", done: 0, total: 0 })).toBe("Keyword memory until smart search is ready.");
    for (const state of ["ready", "indexing", "keyword-only"] as const) expect(semanticStatusPhrase({ state, done: 1, total: 2 })).not.toMatch(/—|\bsafe\b|\bunsafe\b/i);
  });
});
