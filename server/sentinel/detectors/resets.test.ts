// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S08 continuation reset loop: >= 4 automatic resets in one scope within 10 min (Medium); High only when that loop
// also has >= 3 distinct exhausted turns in 15 min, then presented under S07. One issue per engine; it resolves only
// when every contributing scope has recovered.
import { describe, expect, it } from "vitest";
import { fingerprint } from "../types.ts";
import { dispatchTuple } from "./dispatch.ts";
import { resetsDetector } from "./resets.ts";
import { INST, completedRow, perWindow, turn, win } from "./fixtures.ts";

const reset = (scope: number, count = 1, n = scope * 100) => turn({ scope, n, resetDelta: count });
const quiet = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => win(from + k));

describe("S08 resets detector", () => {
  it("F:23-28 trace: four automatic resets in one scope in ten minutes is Medium", () => {
    const r = perWindow(resetsDetector, [1, 4, 7, 10].map(i => win(i, { facts: [reset(1)] }))).last[0]!;
    expect(r.triggered).toBe("medium");
    expect(r.pageEligible).toBe(false);
    expect(r.presentedBy).toBeUndefined();
  });

  it("3 resets, or 4 split over two scopes, stays quiet", () => {
    expect(perWindow(resetsDetector, [win(1, { facts: [reset(1, 3)] })]).last[0]!.triggered).toBeNull();
    expect(perWindow(resetsDetector, [win(1, { facts: [reset(1, 2), reset(2, 2)] })]).last[0]!.triggered).toBeNull();
  });

  it("the 10 min window excludes its left endpoint", () => {
    expect(perWindow(resetsDetector, [win(1, { facts: [reset(1)] }), win(11, { facts: [reset(1, 3)] })]).last[0]!.triggered).toBeNull();
    expect(perWindow(resetsDetector, [win(2, { facts: [reset(1)] }), win(11, { facts: [reset(1, 3)] })]).last[0]!.triggered).toBe("medium");
  });

  it("High only with 3 distinct exhausted turns in that scope, and then presented under S07", () => {
    const exhausted = [1, 2, 3].map(n => turn({ scope: 1, n, final: "exhausted" }));
    const high = perWindow(resetsDetector, [win(1, { facts: [reset(1, 4), ...exhausted] })]).last[0]!;
    expect(high.triggered).toBe("high");
    expect(high.presentedBy).toBe(fingerprint(dispatchTuple(INST, "claude")));
    const otherScope = [1, 2, 3].map(n => turn({ scope: 2, n, final: "exhausted" }));
    expect(perWindow(resetsDetector, [win(1, { facts: [reset(1, 4), ...otherScope] })]).last[0]!.triggered).toBe("medium");
    expect(perWindow(resetsDetector, [win(1, { facts: [reset(1, 4), ...exhausted.slice(0, 2)] })]).last[0]!.triggered).toBe("medium");
  });

  it("each scope must recover: 30 complete active minutes, 3 completed turns and at most 1 reset", () => {
    const run = (scopes: number[], extraFacts: ReturnType<typeof turn>[] = [], perScope = 3) => {
      const later = quiet(2, 31);
      // completed turns arrive as keyed S07 counter rows; a folded row (no scope) proves nothing for a scope
      later[4] = win(6, { counters: [...scopes.map(s => completedRow(perScope, s)), completedRow(9, null)] });
      // extra resets land at minute 16, outside the trigger's 10 min window
      if (extraFacts.length) later[14] = win(16, { facts: extraFacts });
      return perWindow(resetsDetector, [win(1, { facts: [reset(1, 4), reset(2, 4)] }), ...later]).last[0]!;
    };
    expect(run([1, 2]).recovery.complete).toBe(true);
    expect(run([1]).recovery.complete).toBe(false); // scope 2 has not recovered
    expect(run([1, 2], [reset(1, 1, 7)]).recovery.complete).toBe(true); // one reset is allowed
    expect(run([1, 2], [reset(1, 2, 7)]).recovery.complete).toBe(false); // two are not
    expect(run([1, 2], [], 2).recovery.complete).toBe(false); // 2 completed turns per scope are not enough
  });
});
