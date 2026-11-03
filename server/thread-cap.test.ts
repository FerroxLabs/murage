// U4 S1 (upstream D29 fc839de38, #4212 b6d45fa27 cap part): the per-bot thread limit is the owner's saved number or a guard sized from
// this computer's memory, the whole home never runs more than that guard, and both are read live on every admission and slot pump.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR, loadConfig, parseConfigPatch, parseStoredConfig, saveConfig } from "./config.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { botThreadCap, homeThreadGuard, savedThreadsPerBot } from "./thread-cap.ts";

const GIB = 1024 ** 3;

describe("thread cap numbers", () => {
  it("sizes the home guard as total GB less 2, at least 1: 4 GB runs 2, 8 GB runs 6, 16 GB runs 14, 32 GB runs 30", () => {
    expect(homeThreadGuard(4 * GIB)).toBe(2);
    expect(homeThreadGuard(8 * GIB)).toBe(6);
    expect(homeThreadGuard(16 * GIB)).toBe(14);
    expect(homeThreadGuard(32 * GIB)).toBe(30);
    // a 4 GB server whose kernel keeps some back still counts as 4 GB
    expect(homeThreadGuard(3.8 * GIB)).toBe(2);
    expect(homeThreadGuard(2 * GIB)).toBe(1);
    expect(homeThreadGuard(1 * GIB)).toBe(1);
    expect(homeThreadGuard(Number.NaN)).toBe(1);
  });
  it("never drops an 8 GB Mac below the 3 threads a bot ran before", () => {
    expect(botThreadCap(undefined, 8 * GIB)).toBeGreaterThanOrEqual(3);
    expect(homeThreadGuard(8 * GIB)).toBeGreaterThanOrEqual(3);
  });
  it("uses the saved number only when it is lower than the guard", () => {
    expect(botThreadCap({ threadsPerBot: 8 }, 32 * GIB)).toBe(8);
    expect(botThreadCap({ threadsPerBot: 8 }, 8 * GIB)).toBe(6);
    expect(botThreadCap({ threadsPerBot: 8 }, 4 * GIB)).toBe(2);
    expect(botThreadCap({ threadsPerBot: 1 }, 4 * GIB)).toBe(1);
    expect(botThreadCap(undefined, 32 * GIB)).toBe(30);
    expect(botThreadCap({}, 4 * GIB)).toBe(2);
    expect(botThreadCap({}, 8 * GIB)).toBe(6);
  });
  it("reads 0, 17, a fraction, text or null as unset", () => {
    for (const bad of [0, 17, 2.5, "x", null, -1]) {
      expect(savedThreadsPerBot({ threadsPerBot: bad })).toBeUndefined();
      expect(botThreadCap({ threadsPerBot: bad }, 32 * GIB)).toBe(30);
    }
  });
  it("keeps a saved 8 through the config schema, drops an out-of-range stored value without failing the config, refuses it on a write", () => {
    expect(parseStoredConfig({ features: { threadsPerBot: 8 } } as never).features?.threadsPerBot).toBe(8);
    expect(parseStoredConfig({ features: { threadsPerBot: 17, browser: true } } as never).features).toEqual({ browser: true });
    expect(() => parseConfigPatch({ features: { threadsPerBot: "x" } } as never)).toThrow();
    expect(parseConfigPatch({ features: { threadsPerBot: 5 } } as never).features?.threadsPerBot).toBe(5);
    expect(parseConfigPatch({ features: { threadsPerBot: null } } as never).features?.threadsPerBot).toBeNull();
  });
  it("PATCH 8 then PATCH null: config.json has no threadsPerBot and the live limit on a 4 GB size is the guard, 2", () => {
    const file = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true }); rmSync(file, { force: true });
    try {
      const cfg = loadConfig();
      const runs = new IndependentThreadRuns<object>({ perBot: () => botThreadCap(cfg.features, 4 * GIB), home: () => homeThreadGuard(4 * GIB) });
      saveConfig(parseConfigPatch({ features: { threadsPerBot: 1 } } as never));
      Object.assign(cfg, loadConfig());
      expect(runs.capFor("bot")).toBe(1);
      saveConfig(parseConfigPatch({ features: { threadsPerBot: 8 } } as never));
      saveConfig(parseConfigPatch({ features: { threadsPerBot: null } } as never));
      Object.assign(cfg, loadConfig());
      expect(cfg.features?.threadsPerBot).toBeUndefined();
      expect(runs.capFor("bot")).toBe(2);
    } finally { rmSync(file, { force: true }); }
  });
});

describe("live limits in the run set", () => {
  it("at a limit of 5 runs a fifth start, refuses the sixth naming 5, and gives the owner one reserved slot above it", () => {
    const runs = new IndependentThreadRuns<object>({ perBot: () => 5 });
    for (let index = 1; index <= 5; index++) runs.admit("bot", `t${index}`, {});
    expect(() => runs.admit("bot", "t6", {})).toThrow("This bot is already running 5 threads. Wait for one to finish.");
    expect(runs.limitRefusal("bot")).toBe("This bot is already running 5 threads. Wait for one to finish.");
    const owner = runs.admit("bot", "owner", {}, [], { ownerFirst: true });
    return runs.awaitSlot(owner).then(granted => {
      expect(granted).toBe(true);
      // the reserved slot is taken: the next owner send waits instead
      const second = runs.admit("bot", "owner-2", {}, [], { ownerFirst: true });
      let waited = false;
      void runs.awaitSlot(second, () => { waited = true; });
      expect(waited).toBe(true);
    });
  });
  it("applies a changed limit to the next start without a restart, and a lowered one stops nothing", () => {
    let cap = 2;
    const runs = new IndependentThreadRuns<object>({ perBot: () => cap });
    const a = runs.admit("bot", "a", {});
    runs.admit("bot", "b", {});
    expect(() => runs.admit("bot", "c", {})).toThrow("2 threads");
    cap = 3;
    expect(runs.admit("bot", "c", {}).threadId).toBe("c");
    cap = 1;
    expect(runs.forBot("bot")).toHaveLength(3);
    expect(() => runs.admit("bot", "d", {})).toThrow("This bot is already running a thread. Wait for it to finish.");
    expect(runs.release(a)).toBe(true);
    expect(() => runs.admit("bot", "d", {})).toThrow("already running a thread");
  });
  it("after the limit is lowered under what runs, the owner's reserved slot never takes the bot past the new limit + 1", async () => {
    let cap = 8;
    const runs = new IndependentThreadRuns<object>({ perBot: () => cap });
    const held = [1, 2, 3, 4, 5].map(index => runs.admit("bot", `t${index}`, {}));
    cap = 1;
    const owner = runs.admit("bot", "owner", {}, [], { ownerFirst: true });
    let waited = false;
    const slot = runs.awaitSlot(owner, () => { waited = true; });
    expect(waited).toBe(true);
    // three finish: two still run, one over the new limit, so the owner still waits
    for (const run of held.slice(0, 3)) runs.release(run);
    let granted = false;
    void slot.then(value => { granted = value; });
    await Promise.resolve();
    expect(granted).toBe(false);
    // one more finishes: one runs, the owner takes the reserved slot (limit 1 + 1)
    runs.release(held[3]!);
    await expect(slot).resolves.toBe(true);
    expect(runs.forBot("bot")).toHaveLength(2);
  });
  it("an owner send that must wait is in line from admission: a release before it awaits never goes to automation", async () => {
    const runs = new IndependentThreadRuns<object>({ perBot: () => 4, home: () => 1 });
    const holder = runs.admit("alpha", "a1", {});
    const routine = runs.admit("beta", "b-routine", {}, [], { queueForSlot: true });
    const routineSlot = runs.awaitSlot(routine);
    const owner = runs.admit("beta", "b-owner", {}, [], { ownerFirst: true });
    // the release lands while the owner's setup is still yielding, before awaitSlot
    runs.release(holder);
    await expect(runs.awaitSlot(owner)).resolves.toBe(true);
    let routineDone = false;
    void routineSlot.then(() => { routineDone = true; });
    await Promise.resolve();
    expect(routineDone).toBe(false);
  });
  it("a raised limit starts a queued run on recheck, with nothing released", async () => {
    let cap = 1;
    const runs = new IndependentThreadRuns<object>({ perBot: () => cap });
    runs.admit("bot", "a", {});
    const queued = runs.admit("bot", "routine", {}, [], { queueForSlot: true });
    const slot = runs.awaitSlot(queued);
    cap = 2;
    runs.recheck();
    await expect(slot).resolves.toBe(true);
  });
  it("an unreadable per-bot limit falls back to the home guard when one is given", () => {
    expect(new IndependentThreadRuns<object>({ perBot: () => { throw new Error("config gone"); }, home: () => 2 }).capFor("bot")).toBe(2);
    expect(new IndependentThreadRuns<object>({ perBot: () => 0, home: () => 30 }).capFor("bot")).toBe(30);
  });
  it("an unreadable limit with no home guard falls back to 3", () => {
    const runs = new IndependentThreadRuns<object>({ perBot: () => { throw new Error("config gone"); } });
    expect(runs.capFor("bot")).toBe(3);
    expect(new IndependentThreadRuns<object>({ perBot: () => 0 }).capFor("bot")).toBe(3);
    expect(new IndependentThreadRuns<object>({ perBot: () => 30 }).capFor("bot")).toBe(30);
    expect(new IndependentThreadRuns<object>({ perBot: () => 2.5 }).capFor("bot")).toBe(3);
  });
  it("on a 4 GB server the whole home runs 2 at once: another bot's start is refused, the owner's send queues until one finishes", async () => {
    const mem = 4 * GIB;
    const runs = new IndependentThreadRuns<object>({ perBot: () => botThreadCap({ threadsPerBot: 8 }, mem), home: () => homeThreadGuard(mem) });
    const a = runs.admit("alpha", "a1", {});
    runs.admit("beta", "b1", {});
    expect(() => runs.admit("gamma", "g1", {})).toThrow("Murage is already running 2 threads on this computer. Wait for one to finish.");
    const queued = runs.admit("gamma", "g-routine", {}, [], { queueForSlot: true });
    const owner = runs.admit("gamma", "g-owner", {}, [], { ownerFirst: true });
    let ownerWaited = false;
    const ownerSlot = runs.awaitSlot(owner, () => { ownerWaited = true; });
    const routineSlot = runs.awaitSlot(queued);
    expect(ownerWaited).toBe(true);
    // one finishes: the owner's send goes first, the routine keeps waiting
    runs.release(a);
    await expect(ownerSlot).resolves.toBe(true);
    expect(runs.homeHolding()).toBe(2);
    let routineDone = false;
    void routineSlot.then(() => { routineDone = true; });
    await Promise.resolve();
    expect(routineDone).toBe(false);
  });
});

describe("server wiring", () => {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("passes live getters, never a captured number, to the run set and both arbiters", () => {
    expect(index).not.toMatch(/MAX_CONCURRENT_BOT_THREADS/);
    expect(index).toMatch(/new IndependentThreadRuns<BotRecord>\(\{ perBot: \(\) => botThreadCap\(cfg\.features, totalmem\(\)\), home: \(\) => homeThreadGuard\(totalmem\(\)\) \}\)/);
    expect(index).toMatch(/canDispatch: \(\) => coordinationHasCapacity\(\) && directRuns\.homeHolding\(\) < directRuns\.homeCap\(\)/);
    expect(index).toMatch(/maxThreads: \(botId\) => directRuns\.capFor\(botId\)/);
    expect(index).toMatch(/homeFull: \(\) => directRuns\.homeHolding\(\) >= directRuns\.homeCap\(\)/);
    // a saved change pumps waiting starts at once
    expect(index).toMatch(/if \(patch\.features\) \{[\s\S]{0,800}directRuns\.recheck\(\);/);
    expect(index).toMatch(/directRuns\.limitRefusal\(botId,rebuildOf\)/);
  });
});
