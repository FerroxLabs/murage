import { describe, expect, it } from "vitest";

import { pollWhileProgressing } from "./progress-poll.ts";

/** A run that takes `perTurnMs` per turn on a clock the test drives. */
function slowRun(turns: number, perTurnMs: number) {
  let clock = 0;
  const read = () => {
    clock += 50;
    const turnCount = Math.min(turns, Math.floor(clock / perTurnMs));
    return { status: turnCount >= turns ? "completed" : "working", turnCount };
  };
  return { read, now: () => clock };
}

describe("pollWhileProgressing", () => {
  it("waits past the idle window while the turn count keeps moving", async () => {
    // 13 turns at 3 s each is 39 s, far past a 10 s idle window.
    const run = slowRun(13, 3_000);
    const done = await pollWhileProgressing(run.read, {
      done: (value) => value.status !== "working",
      progress: (value) => value.turnCount,
      idleMs: 10_000,
      maxMs: 60_000,
      intervalMs: 0,
      now: run.now,
    });
    expect(done).toEqual({ status: "completed", turnCount: 13 });
  });

  it("gives up once the turn count stands still for the idle window", async () => {
    let clock = 0;
    await expect(pollWhileProgressing(() => { clock += 50; return { status: "working", turnCount: 3 }; }, {
      done: (value) => value.status !== "working",
      progress: (value) => value.turnCount,
      idleMs: 1_000,
      maxMs: 60_000,
      intervalMs: 0,
      now: () => clock,
    })).rejects.toThrow(/no progress for 1000 ms.*"turnCount":3/);
    expect(clock).toBeLessThan(1_200);
  });

  it("never runs past the overall cap, even while moving", async () => {
    const run = slowRun(1_000, 100);
    await expect(pollWhileProgressing(run.read, {
      done: (value) => value.status !== "working",
      progress: (value) => value.turnCount,
      idleMs: 10_000,
      maxMs: 5_000,
      intervalMs: 0,
      now: run.now,
    })).rejects.toThrow(/5000 ms in all/);
  });
});
