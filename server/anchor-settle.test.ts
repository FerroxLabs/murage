// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CONTRACTS-B 1.5 R23' TS loop oracles L1-L9. Deterministic: a fake clock whose now() is a counter that only sleep(ms) advances (by exactly
// ms, or ms + 500 for the late variant), and a scripted poll. Nothing here waits on real time.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SETTLE_DEADLINE_MS, SETTLE_STEPS_MS, setSettleClockForTest, settleLoop, type SettleClock } from "./anchor-settle.ts";
import { readClaudeCodeSkills, type ImportFs, realImportFs } from "./claude-code-import.ts";
import { standardTree, type AnchoredWinFake } from "./testing/anchored-win-fake.ts";

function fakeClock(extra = 0) {
  let t = 0;
  const sleeps: number[] = [];
  const clock: SettleClock = {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms + extra; },
  };
  return { clock, sleeps, time: () => t };
}
/** L3's exact sleep list: [0,1,2,4,8,16,32], 38 x 50, [37]. */
const L3_SLEEPS = [0, 1, 2, 4, 8, 16, 32, ...Array<number>(38).fill(50), 37];
const scripted = (trueAt: number | null) => {
  const state = { polls: 0 };
  return { state, poll: () => { state.polls++; return state.polls === trueAt; } };
};

describe("R23' settle loop (fake clock)", () => {
  it("the constants are the contract's", () => {
    expect(SETTLE_DEADLINE_MS).toBe(2000);
    expect([...SETTLE_STEPS_MS]).toEqual([0, 1, 2, 4, 8, 16, 32, 50]);
  });

  it("L1: true at poll 1 resolves true with 1 poll, 0 sleeps, and the poll ran synchronously inside the call", async () => {
    const { clock, sleeps } = fakeClock();
    const s = scripted(1);
    const promise = settleLoop(s.poll, clock);
    expect(s.state.polls).toBe(1);               // before the promise was even awaited
    expect(await promise).toBe(true);
    expect(s.state.polls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("L2: true at poll k (k = 2..47) resolves true after k polls with the first k-1 sleeps of L3's list", async () => {
    for (let k = 2; k <= 47; k++) {
      const { clock, sleeps } = fakeClock();
      const s = scripted(k);
      expect(await settleLoop(s.poll, clock), `k=${k}`).toBe(true);
      expect(s.state.polls, `k=${k}`).toBe(k);
      expect(sleeps, `k=${k}`).toEqual(L3_SLEEPS.slice(0, k - 1));
    }
  });

  it("L3: never true resolves false at fake time 2000 after exactly 47 polls and the exact sleep list", async () => {
    const { clock, sleeps, time } = fakeClock();
    const s = scripted(null);
    expect(await settleLoop(s.poll, clock)).toBe(false);
    expect(time()).toBe(2000);
    expect(s.state.polls).toBe(47);
    expect(sleeps).toHaveLength(46);
    expect(sleeps).toEqual(L3_SLEEPS);
  });

  it("L4: true exactly at poll 47 (t = 2000) resolves true: the observation wins at the deadline", async () => {
    const { clock, time } = fakeClock();
    const s = scripted(47);
    expect(await settleLoop(s.poll, clock)).toBe(true);
    expect(time()).toBe(2000);
    expect(s.state.polls).toBe(47);
  });

  it.each([1, 3])("L5: a poll that throws at poll %i resolves false after exactly that many polls and never rejects", async (at) => {
    const { clock } = fakeClock();
    let polls = 0;
    const poll = () => { polls++; if (polls === at) throw new Error("native"); return false; };
    await expect(settleLoop(poll, clock)).resolves.toBe(false);
    expect(polls).toBe(at);
  });

  it.each([undefined, 1, "true"])("L6: a poll returning %j is not settled: the loop behaves exactly as L3", async (value) => {
    const { clock, sleeps, time } = fakeClock();
    let polls = 0;
    expect(await settleLoop(() => { polls++; return value; }, clock)).toBe(false);
    expect(polls).toBe(47);
    expect(time()).toBe(2000);
    expect(sleeps).toEqual(L3_SLEEPS);
  });

  it("L7: late sleeps (now advances ms + 500) resolve false at fake time 2007 after exactly 5 polls", async () => {
    const { clock, sleeps, time } = fakeClock(500);
    let polls = 0;
    const times: number[] = [];
    expect(await settleLoop(() => { polls++; times.push(time()); return false; }, clock)).toBe(false);
    expect(time()).toBe(2007);
    expect(polls).toBe(5);
    expect(times).toEqual([0, 500, 1001, 1503, 2007]);
    expect(sleeps).toEqual([0, 1, 2, 4]);
  });

  describe("L9: clock failures", () => {
    it("a now() that throws on its second call resolves false and never rejects", async () => {
      let calls = 0;
      let polls = 0;
      const clock: SettleClock = { now: () => { if (++calls === 2) throw new Error("clock"); return 0; }, sleep: async () => undefined };
      await expect(settleLoop(() => { polls++; return false; }, clock)).resolves.toBe(false);
      expect(polls).toBe(1);
    });
    it("a sleep() that rejects resolves false and never rejects", async () => {
      const clock: SettleClock = { now: () => 0, sleep: () => Promise.reject(new Error("sleep")) };
      await expect(settleLoop(() => false, clock)).resolves.toBe(false);
    });
    it("a now() that throws on its FIRST call still polls exactly once, synchronously", async () => {
      for (const [result, expected] of [[true, true], [false, false], ["throw", false]] as const) {
        let polls = 0;
        const clock: SettleClock = { now: () => { throw new Error("clock"); }, sleep: async () => undefined };
        const promise = settleLoop(() => { polls++; if (result === "throw") throw new Error("native"); return result; }, clock);
        expect(polls).toBe(1);
        expect(await promise).toBe(expected);
        expect(polls).toBe(1);
      }
    });
  });
});

// L8 and the L9 "first native call still occurs" case, through the real AnchoredImport: the budget handed to the standalone reader keeps its reader,
// so the test can call the reader's own end() (the production method) three times.
describe("R23' AnchoredImport.end (fake addon)", () => {
  let home: string;
  beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "settle-home-"))); });
  afterEach(() => { setSettleClockForTest(null); rmSync(home, { recursive: true, force: true }); });

  const winFs = (fake: AnchoredWinFake) => ({ ...realImportFs, platform: () => "win32", winAnchor: () => fake.anchor }) as unknown as ImportFs;
  type Ended = { reader: { end(): Promise<boolean> } };
  function readerOf(fake: AnchoredWinFake): Ended["reader"] {
    const budget = { deadline: Date.now() + 10_000, bytes: 0 } as { deadline: number; bytes: number; reader?: Ended["reader"] };
    readClaudeCodeSkills(home, winFs(fake), Date.now, budget as never);   // a caller-supplied budget is not ended by the reader function
    expect(budget.reader).toBeDefined();
    return budget.reader!;
  }

  it("L8: end() called three times returns the same promise; native calls equal the poll count; the first happened synchronously in the first end()", async () => {
    const fake = standardTree();
    fake.endScript = [false, false, true];
    const { clock, sleeps } = fakeClock();
    setSettleClockForTest(clock);
    const reader = readerOf(fake);
    expect(fake.ends).toBe(0);
    const first = reader.end();
    expect(fake.ends).toBe(1);                     // posted before the first await
    expect(reader.end()).toBe(first);
    expect(reader.end()).toBe(first);
    expect(await first).toBe(true);
    expect(reader.end()).toBe(first);
    expect(fake.ends).toBe(3);                     // one call per poll: false, false, true
    expect(sleeps).toEqual([0, 1]);
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("POSIX: the first end() is Promise.resolve(true) and every later call returns that same promise", async () => {
    const budget = { deadline: Date.now() + 10_000, bytes: 0 } as { deadline: number; bytes: number; reader?: Ended["reader"] };
    readClaudeCodeSkills(home, realImportFs, Date.now, budget as never);
    expect(budget.reader).toBeDefined();
    const first = budget.reader!.end();
    expect(budget.reader!.end()).toBe(first);
    expect(await first).toBe(true);
    expect(budget.reader!.end()).toBe(first);
  });

  it("L9: a clock whose first now() throws still makes the first native anchorEnd call, synchronously, and resolves from that one poll", async () => {
    const fake = standardTree();
    fake.endScript = [false];
    setSettleClockForTest({ now: () => { throw new Error("clock"); }, sleep: async () => undefined });
    const reader = readerOf(fake);
    const promise = reader.end();
    expect(fake.ends).toBe(1);
    expect(await promise).toBe(false);
    expect(fake.ends).toBe(1);
  });
});
