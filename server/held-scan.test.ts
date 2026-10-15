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
    bot: () => bot, tasks: () => threads.map(threadId => ({ threadId })), groups: [], continuationHolder: () => undefined,
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
