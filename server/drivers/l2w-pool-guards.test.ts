// L2W 1.0.23 (designs/L2W-1023-WARM-MAP.md r3) pool guards for donor rows #6644 and #6359: ALREADY-HELD, no port code.
// L2W-4: an idle timer, a budget sweep or a stale measure never closes a busy or borrowed engine, and a busy engine never stays borrowable.
// L2W-5: under budget pressure only idle members close, oldest first; an intent hold does not exempt from the budget.
// Real warm pool (warm-pool.ts) with the clock, memory and measure injected, as warm-pool.test.ts does.
import { describe, expect, it } from "vitest";
import { createWarmPool, type WarmEngine, type WarmMember } from "./warm-pool.ts";

const MB = 1024 * 1024, GB = 1024 * MB;
const WINDOW = 15 * 60_000;

function rig(opts: { totalGB?: number; budgetMB?: number; active?: boolean; measure?: (pids: number[]) => Promise<Map<number, number>> } = {}) {
  const clock = { t: 1_000_000 };
  const closed: string[] = [];
  const env: NodeJS.ProcessEnv = { MURAGE_WARM_POOL_MIN_FREE_MB: "0" };
  if (opts.budgetMB !== undefined) env.MURAGE_WARM_POOL_BUDGET_MB = String(opts.budgetMB);
  const pool = createWarmPool({
    now: () => clock.t, totalmem: () => (opts.totalGB ?? 64) * GB, freemem: () => 64 * GB, env, timer: false, sampleFree: async () => {},
    log: () => {},
    measure: opts.measure ?? (async (pids) => new Map(pids.map((p) => [p, 100 * MB]))),
  });
  if (opts.active !== false) pool.noteUserActivity();
  const member = (pid: number, engine: WarmEngine, busy = false, bot?: string): [object, WarmMember] =>
    [{}, { engine, threadId: `t${pid}`, pid: () => pid, busy: () => busy, close: (reason) => closed.push(`${pid}:${reason}`), ...(bot === undefined ? {} : { bot }) }];
  return { pool, clock, closed, env, member };
}

describe("L2W-4 (#6644): a busy or borrowed engine is never closed by a sweep and never stays borrowable", () => {
  it("(a) budget 0 (6 GB RAM, no override), one measured busy member in idle: tick resolves, no close, idleCount 0", async () => {
    const r = rig({ totalGB: 6 });
    expect(r.pool.budgetBytes()).toBe(0);
    const [k, m] = r.member(1, "claude", true);
    await r.pool.markIdle(k, m);
    await r.pool.tick();
    expect(r.closed).toEqual([]);
    expect(r.pool.idleCount()).toBe(0);
  });

  it("(b) budget huge, activity window lapsed, busy member in idle: one sweep leaves it unclosed and out of idle", async () => {
    const r = rig({ budgetMB: 1_000_000, active: false });
    const [k, m] = r.member(1, "codex", true);
    await r.pool.markIdle(k, m);
    expect(r.closed).toEqual([]);
    expect(r.pool.idleCount()).toBe(0);
  });

  it("(c) window lapsed, a check's measure still pending, the engine is borrowed before it resolves: not closed", async () => {
    let resolveMeasure: (v: Map<number, number>) => void = () => {};
    const r = rig({ budgetMB: 1_000_000, active: false, measure: (pids) => new Promise((res) => { resolveMeasure = () => res(new Map(pids.map((p) => [p, 100 * MB]))); }) });
    const [k, m] = r.member(1, "claude", false); // the borrowed fake reports not-busy, so evictKey's busy guard cannot save it
    const settled = r.pool.markIdle(k, m); // check(): refresh() awaits the pending measure
    r.pool.release(k); // a turn borrows the engine while refresh() is pending
    resolveMeasure(new Map());
    await settled;
    expect(r.closed).toEqual([]);
  });
});

describe("L2W-5 (#6359): budget pressure closes only idle members, oldest first; an intent hold does not exempt", () => {
  // MAIN-RULING warm-active-only (1.0.22 WAVE-241): an active bot keeps at most one idle engine, so the three
  // members serve three active bots; budget pressure, not the per-bot spare limit, is what this row measures.
  const BOTS = ["b1", "b2", "b3"];
  it("three kinds over budget while active: idle and intent-held close with reason pool budget, the busy one never", async () => {
    const r = rig({ budgetMB: 1_000_000 });
    for (const b of BOTS) r.pool.noteUserActivity(b);
    r.pool.warmIntent("t3");
    const [k1, m1] = r.member(1, "claude", false, "b1");
    const [k2, m2] = r.member(2, "codex", true, "b2"); // a busy engine is never in idle otherwise: placed there by the test
    const [k3, m3] = r.member(3, "acp", false, "b3");
    await r.pool.markIdle(k1, m1); await r.pool.markIdle(k2, m2); await r.pool.markIdle(k3, { ...m3, hold: true });
    expect(r.closed).toEqual([]);
    expect(r.pool.idleCount()).toBe(3);
    r.env.MURAGE_WARM_POOL_BUDGET_MB = "1";
    r.clock.t += WINDOW / 2; for (const b of BOTS) r.pool.noteUserActivity(b);
    await r.pool.tick();
    // 1.0.22 (MAIN-RULING warm1022-driver-D2): an unclaimed prewarm hold (k3) closes before an older idle member (k1); both still close, the busy one never.
    expect(r.closed).toEqual(["3:pool budget", "1:pool budget"]);
    expect(r.pool.idleCount()).toBe(0);
  });
});
