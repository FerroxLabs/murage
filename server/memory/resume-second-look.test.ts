// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// designs/RESUME-SECOND-LOOK-1013.md: a resume check that stopped on the clock looks once more on its own allowance. Only a finished, clean
// check resumes; a real reason, a read too big for its nodes and a second stop all reset as before.
import { afterEach, describe, expect, it } from "vitest";
import { LineageAllowance, RESUME_SECOND_LOOK_MS, setLineageTimeBudgetForTest, withSecondLook } from "./lineage-allowance.ts";

const spin = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* a slow read */ } };
/** A check in the shape of the real ones: it pays for a read, and a limit reports "lineage-warming". */
const stepped = (why: { reason?: string }, steps: Array<{ slowMs?: number; reason?: string }>) => {
  const seen: LineageAllowance[] = [];
  const check = (allowance: LineageAllowance): boolean => {
    const step = steps[seen.length] ?? {};
    seen.push(allowance);
    try {
      if (step.slowMs) spin(step.slowMs);
      allowance.spendNodes("t", 1);
      if (step.reason) { why.reason = step.reason; return true; }
      return false;
    } catch { why.reason = "lineage-warming"; return true; }
  };
  return { check, seen };
};

afterEach(() => setLineageTimeBudgetForTest(undefined));

describe("a resume check's second look", () => {
  it("finishes a check the clock stopped, on an allowance of its own, and restarts the turn's clock", () => {
    setLineageTimeBudgetForTest(5);
    const allowance = LineageAllowance.turn();
    const why: { reason?: string } = {};
    const { check, seen } = stepped(why, [{ slowMs: 10 }, {}]);
    expect(withSecondLook(allowance, why, check)).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(allowance);
    expect(why.reason).toBeUndefined();
    expect(allowance.hit).toBe(false);
    expect(allowance.spentOut()).toBe(false);
  });

  it("resets on the second look's real answer", () => {
    setLineageTimeBudgetForTest(5);
    const why: { reason?: string } = {};
    const { check } = stepped(why, [{ slowMs: 10 }, { reason: "memory-changed" }]);
    expect(withSecondLook(LineageAllowance.turn(), why, check)).toBe(true);
    expect(why.reason).toBe("memory-changed");
  });

  it("gives no second look to a real reason, even past the clock", () => {
    setLineageTimeBudgetForTest(5);
    const allowance = LineageAllowance.turn();
    const why: { reason?: string } = {};
    let calls = 0;
    const ok = withSecondLook(allowance, why, () => { calls++; spin(10); why.reason = "writetime-deny-session"; return true; });
    expect(ok).toBe(true);
    expect(calls).toBe(1);
    expect(why.reason).toBe("writetime-deny-session");
  });

  it("gives no second look to a read too big for its nodes", () => {
    const why: { reason?: string } = {};
    const allowance = LineageAllowance.turn(1);
    let calls = 0;
    const check = (a: LineageAllowance) => { calls++; try { a.spendNodes("t", 5); return false; } catch { why.reason = "lineage-warming"; return true; } };
    expect(withSecondLook(allowance, why, check)).toBe(true);
    expect(calls).toBe(1);
  });

  it("draws every look of an allowance on one allowance, and resets once that is spent", () => {
    setLineageTimeBudgetForTest(5);
    const allowance = LineageAllowance.turn();
    const why: { reason?: string } = {};
    const { check, seen } = stepped(why, [{ slowMs: 10 }, {}, { slowMs: 10 }, { slowMs: 10 }, { slowMs: 10 }]);
    expect(withSecondLook(allowance, why, check)).toBe(false);
    expect(withSecondLook(allowance, why, check)).toBe(true);
    expect(why.reason).toBe("lineage-warming");
    expect(withSecondLook(allowance, why, check)).toBe(true);
    expect(seen).toHaveLength(6);
    expect(new Set(seen.filter(item => item !== allowance)).size).toBe(1);
  });

  it("gives none to a closed allowance", () => {
    setLineageTimeBudgetForTest(5);
    const allowance = LineageAllowance.turn();
    allowance.close();
    const why: { reason?: string } = {};
    const { check, seen } = stepped(why, [{ slowMs: 1 }]);
    expect(withSecondLook(allowance, why, check)).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("still resets on a time budget of 0, and the real second look has its own stated time", () => {
    setLineageTimeBudgetForTest(0);
    const why: { reason?: string } = {};
    const { check, seen } = stepped(why, []);
    expect(withSecondLook(LineageAllowance.turn(), why, check)).toBe(true);
    expect(seen).toHaveLength(2);
    expect(why.reason).toBe("lineage-warming");
    expect(RESUME_SECOND_LOOK_MS).toBe(500);
  });
});
