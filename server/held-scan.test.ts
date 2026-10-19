// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13 real-data run (cand/rc13 9b2d0469c): the roomQueue start step walked every thread of every bot for held items in one synchronous run,
// `[loop] stall blocked=2106ms holder=startup.roomQueue:2027ms`. The walk now hands the loop back every HELD_SCAN_SLICE_MS (held-scan.ts),
// walks of several bots share that budget, and a walk that fits in it still runs in one go.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { HELD_SCAN_SLICE_MS, heldScanYield } from "./held-scan.ts";
import { runnableContinuation } from "./restore-fence.ts";

const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* work */ } };
/** The longest the loop went without a turn while `work` ran. */
async function longestHold(work: () => Promise<unknown>): Promise<number> {
  let worst = 0, last = performance.now(), done = false;
  const watch = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; if (!done) setImmediate(watch); };
  setImmediate(watch);
  await work();
  done = true;
  await new Promise(resolve => setImmediate(resolve));
  return worst;
}

it("walks that share the budget hand the loop back: none of them holds it much past HELD_SCAN_SLICE_MS, and all of them finish", async () => {
  const visited = [0, 0, 0];
  const walk = async (n: number) => { for (let i = 0; i < 60; i++) { await heldScanYield(); busy(1); visited[n]!++; } };
  const worst = await longestHold(() => Promise.all([walk(0), walk(1), walk(2)]));
  expect(visited).toEqual([60, 60, 60]);
  // 180 ms of work in all, never more than one slice (plus the one thread that crosses it) between two turns of the loop
  expect(worst).toBeLessThan(HELD_SCAN_SLICE_MS * 4);
});

it("a walk that fits in the budget runs in one go: it never hands the loop back", async () => {
  await new Promise(resolve => setImmediate(resolve)); // a fresh turn of the loop
  const yielded: boolean[] = [];
  for (let i = 0; i < 5; i++) yielded.push(await heldScanYield());
  expect(yielded).toEqual([false, false, false, false, false]);
});

it("the production walk over a bot's threads (drainHeldContinuations) hands the loop back between threads", async () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("const heldDispatches =");
  const end = source.indexOf("\nstore.onChange(change =>", start);
  expect(start).toBeGreaterThan(0);
  const threads = Array.from({ length: 120 }, (_, i) => `t${i}`);
  const bot = { id: "b", busy: false, modelSelection: { instanceId: "i", model: "m" } };
  const store = {
    // every thread holds work, so the drain visits all of them (store.pendingThreadsForSliced)
    bot: () => bot, tasks: () => threads.map(threadId => ({ threadId })), groups: [], continuationHolder: () => undefined, pendingThreadsFor: () => threads,
    pendingThreadsForSliced: async () => threads,
    projectBotForTask: () => null, taskByThread: () => undefined, groupByThread: () => undefined,
  };
  let noted = 0;
  const noteHeldQueue = () => { noted++; busy(2); }; // a thread costing 2 ms (240 ms for the bot)
  const drain = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\ndrainHeldContinuations;", {
    store, roomEngine: { ready: true }, registry: { get: () => undefined }, routeHasTools: () => true, noteHeldQueue, heldScanYield, runnableContinuation,
  });
  const worst = await longestHold(() => drain(bot.id));
  expect(noted).toBe(threads.length);
  expect(worst).toBeLessThan(50);
});

// 1.0.3 lane 3 (stall r1): after the walk hands the loop back it routes by the bot as it is now (not the walk-start snapshot), and a group the
// bot joined while the walk was paused is walked before it ends, not left for the next trigger.
it("the production walk routes by the current bot after a yield, and walks a group joined mid-walk", async () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("const heldDispatches =");
  const end = source.indexOf("\nstore.onChange(change =>", start);
  const threads = Array.from({ length: 60 }, (_, i) => `t${i}`);
  let bot = { id: "b", busy: false, modelSelection: { instanceId: "old", model: "m" } };
  const groups: Array<{ id: string; threadId: string; memberIds: string[] }> = [];
  const held = [{ id: "h1", botId: "b", text: "go on", dispatcher: "direct" }];
  const pending = (): string[] => [...threads, ...groups.filter(group => group.memberIds.includes("b")).map(group => group.threadId)];
  const store = {
    bot: () => bot, tasks: () => threads.map(threadId => ({ threadId })), groups,
    continuationHolder: (_bot: string, threadId: string) => (threadId === "g-thread" ? { heldContinuations: held } : undefined),
    projectBotForTask: () => null, taskByThread: () => undefined, groupByThread: () => undefined,
    // 1.0.3 idle-scan: the walk visits only the threads with held work (every task thread here, then the room once the bot joins it)
    pendingThreadsFor: () => pending(),
    pendingThreadsForSliced: async () => pending(),
  };
  const noted: string[] = [], routed: string[] = [];
  let changed = false;
  const noteHeldQueue = (_bot: string, threadId: string) => {
    noted.push(threadId); busy(2);
    // part-way through (after the walk has handed the loop back at least once): a new engine, and a group joined
    if (!changed && noted.length === 30) { changed = true; bot = { ...bot, modelSelection: { instanceId: "new", model: "m" } }; groups.push({ id: "g", threadId: "g-thread", memberIds: ["b"] }); }
  };
  const drain = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\ndrainHeldContinuations;", {
    store, roomEngine: { ready: true }, registry: { get: (id: string) => { routed.push(id); return undefined; } }, routeHasTools: () => true, noteHeldQueue, heldScanYield, runnableContinuation,
  });
  await drain(bot.id);
  expect(noted).toContain("g-thread");
  expect(noted.filter(t => t === "g-thread")).toHaveLength(1);
  expect(routed).toEqual(["new"]);
});
