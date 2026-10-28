// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S06 send-fence rebuilding: >= 10 refusals over >= 5 distinct turns in 15 min with >= 3 slow (>= 5 s) rebuilds;
// recovery after 30 complete active minutes with fewer than 3 affected turns and no exhaustion; the row is presented
// under S07 when every affected turn ended exhausted.
import { describe, expect, it } from "vitest";
import type { TurnWindowFact } from "../../../shared/health-protocol.mjs";
import { fingerprint } from "../types.ts";
import { dispatchTuple } from "./dispatch.ts";
import { sendFenceDetector } from "./send-fence.ts";
import { INST, perWindow, turn, win } from "./fixtures.ts";

/** Five turns, two refusals each, the first `slow` of them with a 5 s rebuild. */
function burst(opts: { turns?: number; refusals?: number[]; rebuild?: number[]; final?: TurnWindowFact["final"] } = {}): TurnWindowFact[] {
  const turns = opts.turns ?? 5;
  return Array.from({ length: turns }, (_, k) => turn({ n: k + 1, refusalDelta: opts.refusals?.[k] ?? 2, rebuildMsDelta: opts.rebuild?.[k] ?? (k < 3 ? 5_000 : 0), final: opts.final ?? null }));
}
const at1 = (facts: TurnWindowFact[], extra = {}) => perWindow(sendFenceDetector, [win(1, { facts, ...extra })]).last[0];

describe("S06 send-fence detector", () => {
  it("F:23-28 trace: 10 refusals across 5 turns with 3 slow rebuilds is Medium, digest only", () => {
    const r = at1(burst())!;
    expect(r.triggered).toBe("medium");
    expect(r.pageEligible).toBe(false);
    expect(r.affectedTurns).toBe(5);
  });

  it("one below each threshold stays normal enforcement", () => {
    expect(at1(burst({ refusals: [2, 2, 2, 2, 1] }))!.triggered).toBeNull(); // 9 refusals
    expect(at1(burst({ turns: 4, refusals: [3, 3, 2, 2] }))!.triggered).toBeNull(); // 4 turns
    expect(at1(burst({ rebuild: [5_000, 5_000, 4_999, 0, 0] }))!.triggered).toBeNull(); // 2 slow turns
    expect(at1(burst({ rebuild: [5_000, 5_000, 5_000, 0, 0] }))!.triggered).toBe("medium");
  });

  it("the 15 min window excludes its left endpoint", () => {
    const early = [turn({ n: 1, refusalDelta: 2, rebuildMsDelta: 5_000 })];
    const rest = burst().slice(1);
    expect(perWindow(sendFenceDetector, [win(1, { facts: early }), win(16, { facts: rest })]).last[0]!.triggered).toBeNull();
    expect(perWindow(sendFenceDetector, [win(2, { facts: early }), win(16, { facts: rest })]).last[0]!.triggered).toBe("medium");
  });

  it("only fully covered minutes count", () => {
    expect(at1(burst(), { complete: false })?.triggered ?? null).toBeNull();
  });

  it("is presented under S07 when every affected turn ended exhausted, and keeps its own fingerprint", () => {
    const s07 = fingerprint(dispatchTuple(INST, "claude"));
    const all = at1(burst({ final: "exhausted" }))!;
    expect(all.presentedBy).toBe(s07);
    expect(all.relatedFingerprints).toContain(s07);
    expect(fingerprint(all.tuple)).not.toBe(s07);
    const mixed = burst();
    mixed[0] = { ...mixed[0]!, final: "exhausted" };
    expect(at1(mixed)!.presentedBy).toBeUndefined();
  });

  it("recovers after 30 complete active minutes with fewer than 3 affected turns and no exhaustion", () => {
    const quiet = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => win(from + k));
    const run = (later: ReturnType<typeof win>[]) => perWindow(sendFenceDetector, [win(1, { facts: burst() }), ...later]).last[0]!;
    expect(run(quiet(2, 30)).recovery.complete).toBe(false); // 29 minutes
    expect(run(quiet(2, 31)).recovery.complete).toBe(true);
    // two affected turns are still fewer than 3
    const two = quiet(2, 31);
    // (minute 17 is outside the trigger's 15 min window, so the original burst no longer counts there)
    two[15] = win(17, { facts: [turn({ n: 50, refusalDelta: 1 }), turn({ n: 51, refusalDelta: 1 })] });
    expect(run(two).recovery.complete).toBe(true);
    // an exhausted dispatch restarts the recovery window
    const exhausted = quiet(2, 31);
    exhausted[15] = win(17, { facts: [turn({ n: 60, final: "exhausted" })] });
    expect(run(exhausted).recovery.complete).toBe(false);
    // inactive minutes do not count
    expect(run(quiet(2, 31).map(w => win(Math.ceil((w.endAt - Date.UTC(2026, 9, 27, 12)) / 60_000), { activeMs: 0 }))).recovery.complete).toBe(false);
  });
});
