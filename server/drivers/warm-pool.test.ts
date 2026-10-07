// Adaptive, activity-scaled warm pool: memory figures and the clock are
// injected, nothing here depends on real ps, real memory or real time.
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { awaitCliTreeStopped, killCliTree, spawnCli } from "../procs.ts";
import { createPrewarmGate, createTurnMemory, createWarmPool, DEFAULT_WARM_MAX_AGE_MS, pastWarmMaxAge, spawnInputsOf, TAKEOVER_BOUND_MS, treeRss, warmMaxAgeMs, type WarmEngine, type WarmMember } from "./warm-pool.ts";

const MB = 1024 * 1024, GB = 1024 * MB;
const WINDOW = 15 * 60_000;

function rig(opts: { sizesMB?: Record<number, number>; budgetMB?: number; totalGB?: number; freeMB?: number; minFreeMB?: number; active?: boolean } = {}) {
  const sizes = new Map<number, number>(Object.entries(opts.sizesMB ?? {}).map(([pid, v]) => [Number(pid), v * MB]));
  const clock = { t: 1_000_000 };
  const free = { mb: opts.freeMB ?? 64_000 };
  const logs: string[] = [];
  const closed: string[] = [];
  const env: NodeJS.ProcessEnv = { MURAGE_WARM_POOL_MIN_FREE_MB: String(opts.minFreeMB ?? 1500) };
  if (opts.budgetMB !== undefined) env.MURAGE_WARM_POOL_BUDGET_MB = String(opts.budgetMB);
  const pool = createWarmPool({
    now: () => clock.t, totalmem: () => (opts.totalGB ?? 64) * GB, freemem: () => free.mb * MB, env, timer: false, sampleFree: async () => {},
    log: (l) => logs.push(l),
    measure: async (pids) => new Map(pids.filter((p) => sizes.has(p)).map((p) => [p, sizes.get(p)!])),
  });
  if (opts.active !== false) pool.noteUserActivity();
  const member = (pid: number, engine: WarmEngine = "claude", background = false): [object, WarmMember] => {
    const key = {};
    return [key, { engine, threadId: `t${pid}`, pid: () => pid, background, close: (reason) => closed.push(`${pid}:${reason}`) }];
  };
  const settle = (pid: number, engine: WarmEngine = "claude", background = false) => { const [k, m] = member(pid, engine, background); const p = pool.markIdle(k, m); return { k, p }; };
  return { pool, sizes, clock, free, logs, closed, settle, member };
}

describe("activity-scaled warm pool", () => {
  it("retires an idle engine past the warm max age (5 h default) with reason max-age, and keeps a younger one", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100 }, budgetMB: 8000 });
    const HOUR = 60 * 60_000;
    r.clock.t = 24 * HOUR; r.pool.noteUserActivity();
    const [k1, m1] = r.member(1, "claude");
    await r.pool.markIdle(k1, { ...m1, spawnedAt: r.clock.t - 4 * HOUR });
    const [k2, m2] = r.member(2, "codex");
    await r.pool.markIdle(k2, { ...m2, spawnedAt: r.clock.t - 1 * HOUR });
    expect(r.closed).toEqual([]);
    r.clock.t += HOUR; r.pool.noteUserActivity(); await r.pool.tick();
    expect(r.closed).toEqual(["1:max-age"]);
    expect(r.logs.some((l) => l.includes("engine=claude thread=t1 reason=max-age"))).toBe(true);
    expect(r.pool.idleCount()).toBe(1);
  });

  it("never retires a busy engine for its age: that waits for the turn boundary", async () => {
    const r = rig({ sizesMB: { 1: 100 }, budgetMB: 8000 });
    const [k, m] = r.member(1, "acp");
    await r.pool.markIdle(k, { ...m, spawnedAt: r.clock.t - DEFAULT_WARM_MAX_AGE_MS - 1, busy: () => true });
    expect(r.closed).toEqual([]);
  });

  it("MURAGE_WARM_MAX_AGE_MS sets the age, for every engine kind (fake timers)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
      const spawnedAt = Date.now();
      expect(warmMaxAgeMs({})).toBe(5 * 60 * 60_000);
      expect(warmMaxAgeMs({ MURAGE_WARM_MAX_AGE_MS: "nonsense" })).toBe(DEFAULT_WARM_MAX_AGE_MS);
      vi.advanceTimersByTime(DEFAULT_WARM_MAX_AGE_MS - 1);
      expect(pastWarmMaxAge(spawnedAt, Date.now(), {})).toBe(false);
      vi.advanceTimersByTime(1);
      expect(pastWarmMaxAge(spawnedAt, Date.now(), {})).toBe(true);
      expect(pastWarmMaxAge(Date.now() - 60_000, Date.now(), { MURAGE_WARM_MAX_AGE_MS: "60000" })).toBe(true);
      expect(pastWarmMaxAge(undefined, Date.now(), {})).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one idle spare per engine kind while active: the most recently used thread", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100 }, budgetMB: 8000 });
    await r.settle(1).p; await r.settle(2).p; await r.settle(3).p;
    expect(r.closed).toEqual(["1:spare limit", "2:spare limit"]);
    await r.settle(4, "codex").p; await r.settle(5, "acp").p;
    expect(r.pool.idleCount()).toBe(3); // one per kind
    expect(r.closed).toHaveLength(2);
  });

  it("goes back to zero idle engines once the activity window passes", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100 }, budgetMB: 8000 });
    await r.settle(1, "claude").p; await r.settle(2, "codex").p;
    expect(r.pool.idleCount()).toBe(2);
    r.clock.t += WINDOW - 1_000; await r.pool.tick();
    expect(r.pool.idleCount()).toBe(2);
    r.clock.t += 2_000; await r.pool.tick();
    expect(r.pool.idleCount()).toBe(0);
    expect(r.closed.sort()).toEqual(["1:activity window", "2:activity window"]);
  });

  it("a new user turn restarts the window", async () => {
    const r = rig({ sizesMB: { 1: 100 }, budgetMB: 8000 });
    await r.settle(1).p;
    r.clock.t += WINDOW - 1_000; r.pool.noteUserActivity();
    r.clock.t += WINDOW - 1_000; await r.pool.tick();
    expect(r.closed).toEqual([]);
  });

  it("background turns release their engine at once and never keep a spare", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100 }, budgetMB: 8000 });
    await r.settle(1, "claude", true).p;
    expect(r.closed).toEqual(["1:background turn"]);
    expect(r.pool.idleCount()).toBe(0);
    await r.settle(2, "claude").p; // a user turn's spare is untouched by a later background close
    await r.settle(3, "claude", true).p;
    expect(r.closed).toEqual(["1:background turn", "3:background turn"]);
    expect(r.pool.idleCount()).toBe(1);
  });

  it("an engine that is not idle is never closed by the pressure backstop", async () => {
    const r = rig({ sizesMB: { 1: 900, 2: 900, 3: 900 }, budgetMB: 1000 });
    const busy = r.settle(1, "claude"); await busy.p;
    r.pool.release(busy.k); // a turn began on it
    await r.settle(2, "codex").p; await r.settle(3, "acp").p; await r.pool.tick();
    expect(r.closed.some((c) => c.startsWith("1:"))).toBe(false);
    expect(r.closed.map((c) => c.split(":")[1])).toContain("pool budget");
  });

  it("memory pressure closes the least recently used idle engine first, even while active", async () => {
    const r = rig({ sizesMB: { 1: 600, 2: 600, 3: 600 }, budgetMB: 1500 });
    await r.settle(1, "claude").p; await r.settle(2, "codex").p;
    expect(r.closed).toEqual([]);
    await r.settle(3, "acp").p;
    expect(r.closed).toEqual(["1:pool budget"]);
    expect(r.logs.some((l) => /^warm pool evict engine=claude thread=t1 reason=pool budget poolMB=\d+ budgetMB=1500$/.test(l))).toBe(true);
  });

  it("intent warm holds the thread's engine and is released when nothing is sent", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100 }, budgetMB: 8000 });
    await r.settle(1).p; // t1 spare
    r.pool.warmIntent("t1");
    await r.settle(2).p; // the held t1 counts toward the one spare and is the one kept
    expect(r.closed).toEqual(["2:spare limit"]);
    r.clock.t += WINDOW + 1_000; await r.pool.tick(); // no send followed
    expect(r.closed.sort()).toEqual(["1:activity window", "2:spare limit"]);
  });

  it("a send after intent ends the hold; the thread then follows normal rules", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100 }, budgetMB: 8000 });
    await r.settle(1).p;
    r.pool.warmIntent("t1"); r.pool.sent("t1");
    await r.settle(2).p;
    expect(r.closed).toEqual(["1:spare limit"]);
  });

  it("the reserve evicts one idle engine before a spawn that would exceed the budget", async () => {
    const r = rig({ sizesMB: { 1: 700, 2: 700 }, budgetMB: 2000 });
    await r.settle(1, "claude").p; await r.settle(2, "codex").p;
    await r.pool.beforeSpawn(); // 1400 + avg 700 > 2000
    expect(r.closed).toEqual(["1:pool reserve"]);
    await r.pool.beforeSpawn(); // 700 + 700 <= 2000
    expect(r.closed).toEqual(["1:pool reserve"]);
  });

  it("with no idle engines a spawn proceeds untouched", async () => {
    const empty = rig({ budgetMB: 100 });
    await empty.pool.beforeSpawn();
    expect(empty.closed).toEqual([]);
  });

  it("low free memory evicts the LRU idle engine with reason low memory", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100 }, budgetMB: 8000, freeMB: 4000 });
    await r.settle(1, "claude").p; await r.settle(2, "codex").p;
    r.free.mb = 1000;
    await r.settle(3, "acp").p;
    expect(r.closed).toEqual(["1:low memory"]);
  });

  it("a closed engine's next spawn is a known cold wake, once", async () => {
    const r = rig({ sizesMB: { 1: 100 }, budgetMB: 8000 });
    await r.settle(1).p;
    r.clock.t += WINDOW + 2_000; await r.pool.tick();
    expect(r.pool.consumeColdWake("t1")).toBe(true);
    expect(r.pool.consumeColdWake("t1")).toBe(false);
  });

  it("default budget is min(25% of RAM, RAM - 6 GB) and the env overrides it", () => {
    expect(rig({ totalGB: 64 }).pool.budgetBytes()).toBe(16 * GB);
    expect(rig({ totalGB: 16 }).pool.budgetBytes()).toBe(4 * GB);
    expect(rig({ totalGB: 8 }).pool.budgetBytes()).toBe(2 * GB);
    expect(rig({ totalGB: 6 }).pool.budgetBytes()).toBe(0);
    expect(rig({ totalGB: 16, budgetMB: 3000 }).pool.budgetBytes()).toBe(3000 * MB);
  });

  it("logs a pool summary at most every five minutes, with each engine's idle RSS", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 150, 3: 100 }, budgetMB: 8000 });
    await r.settle(1, "claude").p;
    const lines = () => r.logs.filter((l) => l.startsWith("warm pool engines="));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^warm pool engines=1 idle=1 poolMB=100 budgetMB=8000 freeMB=64000$/);
    expect(r.logs).toContain("warm pool rss engine=claude thread=t1 rssMB=100");
    r.clock.t += 60_000; await r.settle(2, "codex").p;
    expect(lines()).toHaveLength(1);
    r.clock.t += 5 * 60_000; await r.settle(3, "acp").p;
    expect(lines()).toHaveLength(2);
  });

  it("sums the whole process tree from a ps listing", () => {
    const listing = ["  10     1  1000", "  11    10  2000", "  12    11  4000", "  20     1  8000", ""].join("\n");
    const sums = treeRss(listing, [10, 20, 99]);
    expect(sums.get(10)).toBe(7000 * 1024);
    expect(sums.get(20)).toBe(8000 * 1024);
    expect(sums.has(99)).toBe(false);
  });

  it("a prewarmed engine (hold) keeps its place past the window's spare rules, then is released when no send follows", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100 }, budgetMB: 8000 });
    await r.settle(1).p; // a normal spare: the one this kind is allowed
    const [k, m] = r.member(2); // a second engine of the same kind, started on intent
    await r.pool.markIdle(k, { ...m, hold: true });
    expect(r.pool.idleCount()).toBe(1); // the hold counts toward the one spare and replaces the old one
    expect(r.closed).toEqual(["1:intent-moved"]);
    r.clock.t += WINDOW + 1;
    await r.pool.tick();
    expect(r.closed).toEqual(["1:intent-moved", "2:activity window"]);
  });

  it("a new intent hold replaces the previous idle spare of the same kind, not other kinds", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100, 3: 100 }, budgetMB: 8000 });
    await r.settle(1, "claude").p; await r.settle(3, "codex").p;
    const [k, m] = r.member(2, "claude");
    await r.pool.markIdle(k, m);
    expect(r.closed).toEqual(["1:spare limit"]);
    r.pool.warmIntent("t2");
    expect(r.closed).toEqual(["1:spare limit"]);
    const [k4, m4] = r.member(4, "claude");
    await r.pool.markIdle(k4, { ...m4, hold: true });
    expect(r.closed).toEqual(["1:spare limit", "2:intent-moved"]);
    expect(r.pool.idleCount()).toBe(2); // t4 claude + t3 codex
  });

  it("warmIntent on a thread whose engine is idle closes another thread's idle spare of that kind", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100 }, budgetMB: 8000 });
    await r.settle(1, "claude").p;
    r.pool.warmIntent("t2"); // nothing idle for t2 yet: nothing to move
    expect(r.closed).toEqual([]);
    await r.settle(2, "claude").p;
    expect(r.closed).toEqual(["1:spare limit"]); // held t2 wins over the older t1
    expect(r.pool.idleCount()).toBe(1);
  });

  it("never evicts an engine that is busy with a turn, and drops it from the idle set", async () => {
    const r = rig({ sizesMB: { 1: 900, 2: 900 }, budgetMB: 1000 });
    let busy = false;
    const [k, m] = r.member(1, "claude");
    await r.pool.markIdle(k, { ...m, busy: () => busy });
    busy = true; // adopted by a turn without release()
    await r.settle(2, "codex").p; await r.pool.tick();
    expect(r.closed.some((c) => c.startsWith("1:"))).toBe(false);
    expect(r.closed.map((c) => c.split(":")[1])).toContain("pool budget");
  });

  it("an engine whose RSS cannot be measured counts 600 MB and is logged once", async () => {
    const r = rig({ budgetMB: 1000 }); // no sizes: measurement yields nothing
    await r.settle(1, "claude").p;
    expect(r.pool.poolBytes()).toBe(600 * MB);
    expect(r.logs.filter((l) => l.includes("rss unknown, assuming 600MB"))).toHaveLength(1);
    await r.pool.tick(); await r.pool.tick();
    expect(r.logs.filter((l) => l.includes("rss unknown, assuming 600MB"))).toHaveLength(1);
    r.clock.t += 11_000; // past the measuring window: guesses count in full
    await r.settle(2, "codex").p;
    r.clock.t += 11_000; await r.pool.tick(); // 1200 MB > 1000 MB budget
    expect(r.closed).toEqual(["1:pool budget"]);
  });

  it("a send after a prewarm ends its hold; a background turn never earns one", async () => {
    const r = rig({ sizesMB: { 1: 100, 2: 100 }, budgetMB: 8000 });
    const [k, m] = r.member(1);
    await r.pool.markIdle(k, { ...m, hold: true });
    r.pool.sent("t1");
    r.pool.release(k);
    await r.settle(1).p;
    r.clock.t += WINDOW + 1;
    await r.pool.tick();
    expect(r.closed).toEqual(["1:activity window"]);
    const [bk, bm] = r.member(2);
    await r.pool.markIdle(bk, { ...bm, hold: true, background: true });
    expect(r.closed).toContain("2:background turn");
    expect(r.pool.idleCount()).toBe(0);
  });

  it("the prewarm gate makes a send wait for the warm that is starting, and times out rather than hang", async () => {
    const gate = createPrewarmGate();
    expect(await gate.wait("t")).toBe(true); // nothing starting
    expect(gate.begin("t")).toBe(true);
    expect(gate.begin("t")).toBe(false); // one warm per thread at a time
    const waited = gate.wait("t", 1_000);
    gate.end("t");
    expect(await waited).toBe(true);
    expect(gate.has("t")).toBe(false);
    gate.begin("t");
    expect(await gate.wait("t", 20)).toBe(false); // never ends: the send stops waiting
  });

  it("remembered spawn inputs drop the message, attachments and callbacks, are bounded, and live in memory only", () => {
    const kept = spawnInputsOf({ threadId: "t", text: "secret words", cwd: "/w", images: [{ mimeType: "image/png", data: "AAAA" }], onToolSurface: () => {}, beforeSubmit: () => {}, prewarm: true } as never);
    expect(kept).toMatchObject({ threadId: "t", cwd: "/w", text: "" });
    expect(kept.images).toBeUndefined();
    expect(kept.onToolSurface).toBeUndefined();
    expect(kept.beforeSubmit).toBeUndefined();
    expect(kept.prewarm).toBeUndefined();
    const memory = createTurnMemory<{ n: number; cursor?: string }>(2);
    memory.remember("a", { n: 1 }); memory.remember("b", { n: 2 }); memory.remember("c", { n: 3 });
    expect(memory.get("a")).toBeUndefined();
    memory.patch("b", { cursor: "s1" });
    memory.patch("zz", { cursor: "never" });
    expect(memory.get("b")).toEqual({ n: 2, cursor: "s1" });
    expect(memory.get("zz")).toBeUndefined();
  });

  it("takeOver cancels the prewarm and returns once its slot is free, without ending any process", async () => {
    const gate = createPrewarmGate();
    gate.begin("t");
    let busy = true, asked = false;
    const ok = await gate.takeOver("t", {
      stop: () => { setTimeout(() => { busy = false; gate.end("t"); }, 30); },
      child: () => { asked = true; return undefined; },
      slotBusy: () => busy, boundMs: 1_000,
    });
    expect(ok).toBe(true);
    expect(asked).toBe(false);
    expect(gate.has("t")).toBe(false);
  });

  it("takeOver ends the process the driver owns NOW through the owned tree lifecycle, never a remembered one", async () => {
    const gate = createPrewarmGate();
    gate.begin("t");
    const opts = { stdio: "ignore" as const };
    // the prewarm's first process was replaced (a refused session load): only the replacement is live
    const retired = spawnCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], opts);
    const current = spawnCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], opts);
    const owner: { child: ChildProcess } = { child: retired };
    owner.child = current; // the driver updated its handle on the replacement
    let busy = true;
    current.once("close", () => { busy = false; gate.end("t"); });
    await Promise.all([retired, current].map((c) => new Promise((resolve) => c.once("spawn", resolve))));
    const ended: Array<number | undefined> = [];
    try {
      const ok = await gate.takeOver("t", {
        stop: () => {}, child: () => owner.child, slotBusy: () => busy, boundMs: 4_000,
        terminate: async (c) => { ended.push(c.pid); killCliTree(c); return awaitCliTreeStopped(c, 200); },
      });
      expect(ok).toBe(true);
      expect(ended).toEqual([current.pid]);
      expect(current.exitCode !== null || current.signalCode !== null).toBe(true);
      expect(retired.exitCode === null && retired.signalCode === null).toBe(true); // never touched
    } finally {
      for (const c of [retired, current]) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    }
  });

  it("takeOver gives up inside its one hard bound when the slot never frees, instead of hanging", async () => {
    const gate = createPrewarmGate();
    gate.begin("t");
    const t0 = Date.now();
    expect(await gate.takeOver("t", { stop: () => new Promise(() => {}), child: () => undefined, slotBusy: () => true, boundMs: 200 })).toBe(false);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(1_000);
  });

  it("the takeover bound is 10 s in total by default", () => {
    expect(TAKEOVER_BOUND_MS).toBe(10_000);
  });

  it("an intent hold does not extend the global activity window: only a user turn does", async () => {
    const r = rig({ sizesMB: { 1: 100 }, budgetMB: 8000 });
    await r.settle(1).p; // a user turn at minute 0
    r.clock.t += 14 * 60_000;
    r.pool.warmIntent("some-other-thread"); // focus in another thread at minute 14
    r.clock.t += 2 * 60_000; // minute 16: past the user-turn window
    await r.pool.tick();
    expect(r.closed).toEqual(["1:activity window"]);
  });

  it("the /warm route only sets the thread's intent hold, never user activity", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const start = source.indexOf("// Warm on intent: the owner focused");
    expect(start).toBeGreaterThan(-1);
    const route = source.slice(start, source.indexOf("viewer-close", start));
    expect(route).toContain("warmPool.warmIntent(threadId)");
    expect(route).not.toContain("noteUserActivity");
  });
});

// A fresh Cloud engine is invisible to the rss hook until its systemd scope exists.
describe("early re-measure of a just-spawned engine", () => {
  function lateRig(opts: { budgetMB: number; visibleAfterMs: number; freeMB?: number; sizeMB?: (ageMs: number) => number }) {
    const clock = { t: 5_000_000 };
    const free = { mb: opts.freeMB ?? 64_000 };
    const closed: string[] = [];
    const measuredAt: number[] = [];
    const spawnedAt = new Map<number, number>();
    const hidden = new Set<number>();
    /** How long each check's free-memory sample takes (it runs after the rss reading). */
    const sampleMs = { v: 0 };
    const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
    const pool = createWarmPool({
      now: () => clock.t, totalmem: () => 64 * GB, freemem: () => free.mb * MB, timer: false, sampleFree: async () => { clock.t += sampleMs.v; }, log: () => {},
      env: { MURAGE_WARM_POOL_BUDGET_MB: String(opts.budgetMB), MURAGE_WARM_POOL_MIN_FREE_MB: "1500" },
      schedule: (fn, ms) => { const t = { at: clock.t + ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
      measure: async (pids) => {
        measuredAt.push(clock.t);
        return new Map(pids.filter((p) => !hidden.has(p) && clock.t - spawnedAt.get(p)! >= opts.visibleAfterMs).map((p) => [p, (opts.sizeMB ? opts.sizeMB(clock.t - spawnedAt.get(p)!) : 145) * MB]));
      },
    });
    pool.noteUserActivity();
    const spawn = (pid: number, engine: WarmEngine) => {
      const key = {}; spawnedAt.set(pid, clock.t);
      const p = pool.markIdle(key, { engine, threadId: `t${pid}`, pid: () => pid, hold: true, spawnedAt: clock.t, close: (r) => closed.push(`${pid}:${r}`) });
      return { key, p };
    };
    /** Advance the fake clock, firing due, uncancelled timers in order. */
    const advance = async (ms: number) => {
      const end = clock.t + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true; clock.t = Math.max(clock.t, due.at); due.fn();
        await new Promise((r) => setImmediate(r));
      }
      clock.t = end;
    };
    return { pool, clock, free, closed, measuredAt, timers, hidden, sampleMs, spawn, advance, start: clock.t };
  }

  it("an engine the hook cannot see at spawn is measured at ~2 s, and nothing is evicted", async () => {
    const r = lateRig({ budgetMB: 1200, visibleAfterMs: 2_000 });
    await r.spawn(1, "claude").p;
    expect(r.pool.poolBytes()).toBe(600 * MB); // provisional guess
    await r.advance(2_000);
    expect(r.measuredAt.at(-1)).toBe(r.start + 2_000);
    expect(r.pool.poolBytes()).toBe(145 * MB);
    expect(r.closed).toEqual([]);
    // later re-measures cancelled once measured; only the (no-op) grace-expiry check stays
    expect(r.timers.filter((t) => !t.cancelled).map((t) => t.at - r.start)).toEqual([10_001]);
  });

  it("a first reading taken while the engine is still starting (66 MB at +0.8 s) is re-measured once more at +5 s", async () => {
    const r = lateRig({ budgetMB: 8000, visibleAfterMs: 0, sizeMB: (age) => (age < 5_000 ? 66 : 140) });
    await r.spawn(1, "claude").p;
    await r.advance(800);
    await r.spawn(2, "codex").p; // a pool check triggered by another engine reads claude early
    expect(r.pool.poolBytes()).toBe((66 + 66) * MB);
    await r.advance(4_200); // +5 s: the single follow-up re-measure for claude
    expect(r.measuredAt.at(-1)).toBe(r.start + 5_000);
    expect(r.pool.poolBytes()).toBe((140 + 66) * MB); // codex (spawned +0.8 s) measured early too, its own follow-up is at +5.8 s
    await r.advance(1_000);
    expect(r.pool.poolBytes()).toBe(2 * 140 * MB);
    const n = r.measuredAt.length;
    await r.advance(5_000);
    expect(r.measuredAt.length).toBe(n); // measured: no further early re-measures
    expect(r.closed).toEqual([]);
  });

  it("a first reading taken at +0.8 s is classified by its own age, even when the check finishes after +2 s", async () => {
    const r = lateRig({ budgetMB: 8000, visibleAfterMs: 0, sizeMB: (age) => (age < 5_000 ? 66 : 140) });
    r.sampleMs.v = 2_500; // the free-memory sample outlasts the 2 s mark
    const { key } = r.spawn(1, "claude");
    await new Promise((x) => setImmediate(x));
    expect(r.pool.poolBytes()).toBe(66 * MB);
    r.sampleMs.v = 0;
    // reading at spawn (age 0): one follow-up, 5 s after spawn
    expect(r.timers.filter((t) => !t.cancelled).map((t) => t.at - r.start)).toEqual([5_000]);
    await r.advance(5_000 - (r.clock.t - r.start));
    await new Promise((x) => setImmediate(x));
    expect(r.pool.poolBytes()).toBe(140 * MB);
    expect(key).toBeDefined();
  });

  it("an unmeasured engine whose first reading arrives at +0.8 s (via a later pool check) gets its +5 s follow-up", async () => {
    const r = lateRig({ budgetMB: 8000, visibleAfterMs: 800, sizeMB: (age) => (age < 5_000 ? 66 : 140) });
    r.spawn(1, "claude");
    await new Promise((x) => setImmediate(x));
    expect(r.pool.poolBytes()).toBe(600 * MB); // unmeasured, provisional
    await r.advance(800);
    r.sampleMs.v = 2_500;
    await r.spawn(2, "codex").p; // this check reads claude at +0.8 s; its sample ends past +3 s
    expect(r.measuredAt.at(-1)).toBe(r.start + 800);
    r.sampleMs.v = 0;
    await r.advance(5_000 - (r.clock.t - r.start));
    await new Promise((x) => setImmediate(x));
    expect(r.measuredAt.at(-1)).toBe(r.start + 5_000);
  });

  it("a quick turn: back to idle with rss unavailable, the zero-byte grace still gets its +10.001 s enforcement", async () => {
    const r = lateRig({ budgetMB: 500, visibleAfterMs: 0 });
    const { key } = r.spawn(1, "claude");
    await new Promise((x) => setImmediate(x));
    expect(r.pool.poolBytes()).toBe(145 * MB); // read at once: an early entry exists
    r.pool.release(key); // a turn begins
    await r.advance(1_000);
    r.hidden.add(1); // the hook cannot read it now
    await r.pool.markIdle(key, { engine: "claude", threadId: "t1", pid: () => 1, hold: true, spawnedAt: r.start, close: (x) => r.closed.push(`1:${x}`) });
    expect(r.closed).toEqual([]); // zero-byte grace, not evicted yet
    expect(r.timers.filter((t) => !t.cancelled).map((t) => t.at - r.start)).toContain(10_001);
    await r.advance(10_001 - (r.clock.t - r.start));
    await new Promise((x) => setImmediate(x));
    expect(r.closed).toEqual(["1:pool budget"]); // counted at 600 MB once the grace expires
    // bounded: at most 3 re-measures + 1 expiry in all
    expect(r.timers.length).toBeLessThanOrEqual(4);
  });

  it("a first reading at +3 s is final: further early re-measures are cancelled", async () => {
    const r = lateRig({ budgetMB: 8000, visibleAfterMs: 3_000, sizeMB: (age) => (age < 5_000 ? 66 : 140) });
    await r.spawn(1, "claude").p;
    await r.advance(3_000); // hidden at +2 s
    await r.pool.tick(); // first reading at +3 s: 66 MB, and it is final
    expect(r.pool.poolBytes()).toBe(66 * MB);
    const n = r.measuredAt.length;
    await r.advance(7_000); // past +5 s and the grace expiry
    expect(r.measuredAt.length).toBe(n);
    expect(r.pool.poolBytes()).toBe(66 * MB);
  });

  it("two prewarms within 1 s under a 1200 MB budget: neither is evicted", async () => {
    const r = lateRig({ budgetMB: 1200, visibleAfterMs: 2_000 });
    await r.spawn(1, "claude").p;
    await r.advance(900);
    await r.spawn(2, "codex").p; // 600 + 600 provisional is not over 1200, add a third kind to cross it
    await r.advance(100);
    await r.spawn(3, "acp").p; // 1800 MB of guesses against a 1200 MB budget
    expect(r.closed).toEqual([]);
    await r.advance(5_000);
    expect(r.closed).toEqual([]);
    expect(r.pool.idleCount()).toBe(3);
    expect(r.pool.poolBytes()).toBe(3 * 145 * MB);
  });

  it("an engine that stays invisible past the window is finally counted at 600 MB (budget enforced then)", async () => {
    const r = lateRig({ budgetMB: 1000, visibleAfterMs: 1e12 });
    await r.spawn(1, "claude").p; await r.spawn(2, "codex").p;
    expect(r.closed).toEqual([]);
    await r.advance(11_000);
    expect(r.closed).toEqual(["1:pool budget"]);
  });

  it("the free-memory backstop still evicts immediately inside the window", async () => {
    const r = lateRig({ budgetMB: 1200, visibleAfterMs: 0 });
    await r.spawn(1, "claude").p; // measured
    await r.advance(1_000);
    r.free.mb = 1_000; // below the 1500 MB floor
    r.hidden.add(2);
    await r.spawn(2, "codex").p; // fresh, still invisible to the hook
    expect(r.closed).toEqual(["1:low memory"]); // not deferred by the measuring engine
    expect(r.timers.filter((t) => !t.cancelled)).toHaveLength(3); // the young engine keeps its early re-measures
  });

  it("early checks are bounded to 3 per engine, scheduled once, and do nothing once the engine left the pool", async () => {
    const r = lateRig({ budgetMB: 8000, visibleAfterMs: 1e12 });
    const { key } = r.spawn(1, "claude");
    await new Promise((x) => setImmediate(x));
    expect(r.timers).toHaveLength(3);
    expect(r.timers.map((t) => t.at - r.start)).toEqual([2_000, 5_000, 10_001]);
    r.pool.release(key); // the engine closed
    // re-measures cancelled; the grace-expiry check stays but is a no-op while not idle
    expect(r.timers.filter((t) => !t.cancelled).map((t) => t.at - r.start)).toEqual([10_001]);
    await r.advance(30_000);
    expect(r.measuredAt).toHaveLength(1); // no extra measurement after close
    // settling idle again never schedules past the bound of 3
    for (let i = 0; i < 4; i++) { await r.pool.markIdle(key, { engine: "claude", threadId: "t1", pid: () => 1, spawnedAt: r.start, close: () => {} }); r.pool.release(key); }
    expect(r.timers.length).toBeLessThanOrEqual(3);
  });

  it("beforeSpawn counts a measuring engine's provisional size against the reserve (no admission grace)", async () => {
    const r = lateRig({ budgetMB: 1200, visibleAfterMs: 1e12 });
    await r.spawn(1, "claude").p; // young and invisible: 600 MB provisional
    expect(r.closed).toEqual([]);
    await r.pool.beforeSpawn(); // 600 + 800 reserve > 1200
    expect(r.closed).toEqual(["1:pool reserve"]);
  });

  it("beforeSpawn runs the free-memory backstop, even with a young invisible engine", async () => {
    const r = lateRig({ budgetMB: 8000, visibleAfterMs: 1e12 });
    await r.spawn(1, "claude").p;
    r.free.mb = 1_000; // below the 1500 MB floor since the last check
    await r.pool.beforeSpawn();
    expect(r.closed).toEqual(["1:low memory"]);
  });

  it("a young engine whose local ps failed gets the bounded grace, then is counted at 600 MB at the 10 s check", async () => {
    const clock = { t: 7_000_000 };
    const closed: string[] = [];
    const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
    const pool = createWarmPool({
      now: () => clock.t, totalmem: () => 64 * GB, freemem: () => 64_000 * MB, timer: false, sampleFree: async () => {}, log: () => {},
      env: { MURAGE_WARM_POOL_BUDGET_MB: "1000", MURAGE_WARM_POOL_MIN_FREE_MB: "1500" },
      schedule: (fn, ms) => { const t = { at: clock.t + ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
      measure: async () => null, // ps failed
    });
    pool.noteUserActivity();
    const spawn = (pid: number, engine: WarmEngine) => pool.markIdle({}, { engine, threadId: `t${pid}`, pid: () => pid, hold: true, spawnedAt: clock.t, close: (x) => closed.push(`${pid}:${x}`) });
    await spawn(1, "claude"); await spawn(2, "codex");
    await new Promise((x) => setImmediate(x));
    expect(closed).toEqual([]); // 1200 MB of guesses inside the window: no budget eviction yet
    for (const t of timers.filter((x) => !x.cancelled).sort((a, b) => a.at - b.at)) { clock.t = t.at; t.fn(); await new Promise((x) => setImmediate(x)); }
    expect(closed).toEqual(["1:pool budget"]);
  });

  it("a quick turn (release at 3 s, idle again) still gets the grace-expiry enforcement at 10 s", async () => {
    const r = lateRig({ budgetMB: 1000, visibleAfterMs: 1e12 });
    const a = r.spawn(1, "claude"); const b = r.spawn(2, "codex");
    await a.p; await b.p;
    await r.advance(3_000);
    for (const [key, pid, engine] of [[a.key, 1, "claude"], [b.key, 2, "codex"]] as const) {
      r.pool.release(key); // a quick turn
      await r.pool.markIdle(key, { engine, threadId: `t${pid}`, pid: () => pid, hold: true, spawnedAt: r.start, close: (x) => r.closed.push(`${pid}:${x}`) });
    }
    expect(r.closed).toEqual([]);
    await r.advance(7_100); // just past spawn + 10 s, well before any 30 s tick
    expect(r.closed).toEqual(["1:pool budget"]);
  });

  it("timer:false without an injected scheduler creates no real timers", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const pool = createWarmPool({
        now: () => 1_000, totalmem: () => 64 * GB, freemem: () => 64_000 * MB, timer: false, sampleFree: async () => {}, log: () => {},
        env: { MURAGE_WARM_POOL_BUDGET_MB: "8000" }, measure: async () => null,
      });
      pool.noteUserActivity(); // active, so the engine stays idle and unmeasured
      await pool.markIdle({}, { engine: "claude", threadId: "t1", pid: () => 1, spawnedAt: 1_000, close: () => {} });
      expect(pool.idleCount()).toBe(1);
      await new Promise((x) => setImmediate(x));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
