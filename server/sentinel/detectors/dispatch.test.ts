// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S07 exhausted dispatch: Medium on one terminal exhausted turn, High on 3 distinct exhausted turns in 15 min, each
// turn counted once; "attempt 3" without a terminal outcome is never exhaustion; recovery after 30 complete active
// minutes with no exhaustion and at least 3 completed turns on that engine.
import { describe, expect, it } from "vitest";
import { dispatchDetector } from "./dispatch.ts";
import { completedRow, perWindow, turn, win } from "./fixtures.ts";

const ex = (n: number, extra = {}) => turn({ n, final: "exhausted", ...extra });
const quiet = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => win(from + k));

describe("S07 dispatch-exhausted detector", () => {
  it("F:23-28 trace: one exhausted turn is Medium, digest only", () => {
    const r = perWindow(dispatchDetector, [win(1, { facts: [ex(1)] })]).last[0]!;
    expect(r.triggered).toBe("medium");
    expect(r.pageEligible).toBe(false);
    expect(r.occurrences).toBe(1);
  });

  it("refusals and rebuilds without a terminal outcome never prove exhaustion", () => {
    const r = perWindow(dispatchDetector, [win(1, { facts: [turn({ n: 1, refusalDelta: 3, rebuildMsDelta: 9_000 })] })]).last;
    expect(r.every(x => x.triggered === null)).toBe(true);
  });

  it("High at 3 distinct exhausted turns within 15 min; 2 turns, a repeated turn, or one outside the window is Medium", () => {
    expect(perWindow(dispatchDetector, [win(1, { facts: [ex(1), ex(2), ex(3)] })]).last[0]!.triggered).toBe("high");
    expect(perWindow(dispatchDetector, [win(1, { facts: [ex(1), ex(2)] })]).last[0]!.triggered).toBe("medium");
    const repeated = perWindow(dispatchDetector, [win(1, { facts: [ex(1), ex(2)] }), win(2, { facts: [ex(2)] })]);
    expect(repeated.results[1]!.length === 0 || repeated.results[1]![0]!.triggered === null).toBe(true);
    expect(perWindow(dispatchDetector, [win(1, { facts: [ex(1)] }), win(16, { facts: [ex(2), ex(3)] })]).last[0]!.triggered).toBe("medium");
    expect(perWindow(dispatchDetector, [win(2, { facts: [ex(1)] }), win(16, { facts: [ex(2), ex(3)] })]).last[0]!.triggered).toBe("high");
  });

  it("direct and room turns use the same definition, per engine", () => {
    const r = perWindow(dispatchDetector, [win(1, { facts: [ex(1), ex(2, { engineKind: "codex" }), ex(3, { scope: 9 })] })]).last;
    expect(r.find(x => x.tuple.engineKind === "claude")!.triggered).toBe("medium");
    expect(r.find(x => x.tuple.engineKind === "codex")!.triggered).toBe("medium");
  });

  it("recovers after 30 complete active minutes with no exhaustion and at least 3 completed turns", () => {
    const withTurns = (count: number) => {
      const later = quiet(2, 31);
      later[5] = win(7, { counters: [completedRow(count - 1, 1), completedRow(1, null)] }); // keyed and folded rows both count
      return perWindow(dispatchDetector, [win(1, { facts: [ex(1)] }), ...later]).last[0]!;
    };
    expect(withTurns(3).recovery.complete).toBe(true);
    expect(withTurns(2).recovery.complete).toBe(false);
    const short = perWindow(dispatchDetector, [win(1, { facts: [ex(1)] }), win(2, { counters: [completedRow(3)] }), ...quiet(3, 30)]).last[0]!;
    expect(short.recovery.complete).toBe(false); // 29 active minutes
    const incomplete = quiet(2, 32);
    incomplete[0] = win(2, { complete: false });
    incomplete[5] = win(7, { counters: [completedRow(3)] });
    // the incomplete minute freezes accumulation: 30 complete minutes still needed
    expect(perWindow(dispatchDetector, [win(1, { facts: [ex(1)] }), ...incomplete.slice(0, 30)]).last[0]!.recovery.complete).toBe(false);
    expect(perWindow(dispatchDetector, [win(1, { facts: [ex(1)] }), ...incomplete]).last[0]!.recovery.complete).toBe(true);
    // another engine's completed turns never count
    const other = quiet(2, 31);
    other[5] = win(7, { counters: [completedRow(3, 1, "codex")] });
    expect(perWindow(dispatchDetector, [win(1, { facts: [ex(1)] }), ...other]).last[0]!.recovery.complete).toBe(false);
  });
});
