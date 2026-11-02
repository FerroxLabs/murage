// The reuse gauge: a logical turn counts once, sealed and refused turns stay in the
// denominator, and a small sample never reads as a pass.
import { describe, expect, it } from "vitest";

import { createReuseStats, REPEAT_WINDOW_MS } from "./reuse-stats.ts";

function rig() {
  const clock = { t: 1_000_000 };
  const stats = createReuseStats(() => clock.t);
  const user = (turnId: string, threadId = "t1", extra: { sealed?: boolean } = {}) => ({ engine: "claude", threadId, turnId, ...extra });
  /** One whole user turn: submitted, then settled a moment later. */
  const turn = (turnId: string, process: "reused" | "spare" | "spawned", threadId = "t1", extra: { sealed?: boolean } = {}) => {
    stats.submitted({ ...user(turnId, threadId, extra), process, spawnReason: process === "spawned" ? "no-process" : null });
    clock.t += 1_000;
    stats.settled({ threadId });
    clock.t += 20_000;
  };
  return { clock, stats, user, turn };
}

describe("reuse gauge", () => {
  it("a first turn is not a repeat; the next one within the window is, and hot counts it", () => {
    const r = rig();
    r.turn("a", "spawned");
    r.turn("b", "reused");
    expect(r.stats.snapshot()).toMatchObject({ userTurns: 2, repeatTurns: 1, hot: 1, hotRepeatTurns: 1, hotShare: 0.5 });
  });

  it("under five repeat turns the rate is insufficient evidence, never a number", () => {
    const r = rig();
    for (const id of ["a", "b", "c", "d", "e"]) r.turn(id, "reused");
    const s = r.stats.snapshot();
    expect(s.repeatTurns).toBe(4);
    expect(s.reuseRate).toBeNull();
    expect(s.reuseRateNote).toBe("insufficient evidence");
    r.turn("f", "reused");
    expect(r.stats.snapshot().reuseRate).toBe(1);
    expect(r.stats.snapshot().reuseRateNote).toBeUndefined();
  });

  it("sealed turns stay in the denominator: a thread that can never reuse shows as cold, not as absent", () => {
    const r = rig();
    for (let i = 0; i < 7; i++) r.turn(`s${i}`, "spawned", "t1", { sealed: true });
    const s = r.stats.snapshot();
    expect(s).toMatchObject({ userTurns: 7, repeatTurns: 6, hot: 0, reuseRate: 0, sealedTurns: 7 });
  });

  it("a retry of one turn counts once, and the first submission decides", () => {
    const r = rig();
    r.turn("a", "spawned");
    r.stats.submitted({ ...r.user("b"), process: "reused" });
    r.stats.submitted({ ...r.user("b"), process: "spawned", spawnReason: "process-exited" });
    expect(r.stats.snapshot()).toMatchObject({ userTurns: 2, repeatTurns: 1, hot: 1 });
  });

  it("a refused repeat turn stays in the denominator, and a retry that lands counts by its own process", () => {
    const r = rig();
    r.turn("a", "spawned");
    r.stats.refused({ ...r.user("b"), reason: "submission refused" });
    expect(r.stats.snapshot()).toMatchObject({ userTurns: 2, repeatTurns: 1, hot: 0, refused: { "submission refused": 1 } });
    r.stats.submitted({ ...r.user("b"), process: "reused" });
    expect(r.stats.snapshot()).toMatchObject({ userTurns: 2, repeatTurns: 1, hot: 1 });
  });

  it("background turns are never user turns and never start a repeat window", () => {
    const r = rig();
    r.stats.submitted({ ...r.user("bg"), background: true, process: "reused" });
    r.stats.settled({ threadId: "t1", background: true });
    r.turn("a", "reused");
    expect(r.stats.snapshot()).toMatchObject({ userTurns: 1, repeatTurns: 0, hot: 1, excluded: { backgroundTurns: 1 } });
  });

  it("a turn past the window is not a repeat, and windows are per thread", () => {
    const r = rig();
    r.turn("a", "spawned");
    r.clock.t += REPEAT_WINDOW_MS + 1;
    r.turn("b", "spawned");
    r.turn("c", "spawned", "t2");
    expect(r.stats.snapshot().repeatTurns).toBe(0);
  });

  it("spare is hot", () => {
    const r = rig();
    r.turn("a", "spare");
    expect(r.stats.snapshot().hot).toBe(1);
  });

  it("every spare ends in exactly one final state, and the two rates differ by whether a turn arrived", () => {
    const r = rig();
    const served = r.stats.spare(); served.parked(); served.served(); served.lost("idle");
    const key = r.stats.spare(); key.parked(); key.lost("key:mcp"); key.served();
    const nobody = r.stats.spare(); nobody.parked(); nobody.lost("no-send");
    const s = r.stats.snapshot();
    expect(s.spares).toEqual({ started: 3, parked: 3, served: 1, lost: { "key:mcp": 1 }, noSend: 1 });
    expect(s.spareHitRate).toBe(0.333);
    expect(s.spareServeRate).toBe(0.5);
  });

  it("a reason's own detail never reaches the gauge, so an engine's error text stays out", () => {
    const r = rig();
    r.stats.closed("turn failed: could not read /Users/someone/private notes.txt");
    r.stats.closed("key:cwd");
    expect(r.stats.snapshot().closes).toEqual({ "turn failed": 1, "key:cwd": 1 });
  });

  it("closes are counted by reason without their process counts", () => {
    const r = rig();
    r.stats.closed("child processes alive at settle (8)");
    r.stats.closed("child processes alive at settle (1)");
    r.stats.closed("server failed on reuse");
    expect(r.stats.snapshot().closes).toEqual({ "child processes alive at settle": 2, "server failed on reuse": 1 });
  });

  it("first token keeps hot and cold apart", () => {
    const r = rig();
    for (const ms of [100, 200, 300]) r.stats.firstToken("reused", ms);
    r.stats.firstToken("spare", 400);
    r.stats.firstToken("spawned", 3_000);
    expect(r.stats.snapshot().firstToken).toEqual({ hot: { p50: 200, p90: 400, n: 4 }, cold: { p50: 3_000, p90: 3_000, n: 1 } });
  });

  it("stays bounded: reasons, turns and samples cannot grow without limit", () => {
    const r = rig();
    for (let i = 0; i < 100; i++) r.stats.closed(`spawn contract changed: field${i}`);
    expect(Object.keys(r.stats.snapshot().closes).length).toBeLessThanOrEqual(41);
    for (let i = 0; i < 3_000; i++) r.stats.firstToken("reused", i);
    expect(r.stats.snapshot().firstToken.hot.n).toBe(512);
  });

  it("the summary line holds counts and rates only", () => {
    const r = rig();
    r.turn("a", "spawned");
    expect(r.stats.line()).toBe("userTurns=1 repeatTurns=0 hot=0 reuseRate=none hotShare=0 sealedTurns=0 spares=0/0");
  });
});
