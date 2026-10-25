// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELETION-DRAIN-V2 (Grok r4): a direct turn refused over memory keeps its run while it waits to be rebuilt (phase "rebuilding"), so every
// check that asks whether a thread is working, and every Stop, sees it; the rebuilt turn takes that run over at its admission. The server
// paths are covered by direct-rebuild-hold-api.test.ts; this is the run table's half.
import { expect, it } from "vitest";
import { DirectRebuildCancelled, IndependentThreadRuns } from "./independent-thread-runs.ts";

const refused = (runs: IndependentThreadRuns<{ name: string }>, threadId = "t", resources: string[] = []) => {
  const run = runs.admit("bot", threadId, { name: "refused" }, resources);
  runs.dispatch(run);runs.accepted(run, "provider-1");runs.settling(run);
  return run;
};

it("a held rebuild keeps the thread working: busy to every check, one turn per thread, a bot delete sees it on any thread", () => {
  const runs = new IndependentThreadRuns<{ name: string }>();
  const run = refused(runs, "other-thread");
  expect(runs.holdForRebuild(run)).toBe(true);
  const held = runs.get("other-thread")!;
  expect(held).toMatchObject({ generation: run.generation, phase: "rebuilding" });
  // the refused provider turn is over: its redelivered terminal event names nothing held
  expect(held.providerTurnId).toBeUndefined();
  expect(runs.rebuilding(run)).toBe(true);
  // a conversation delete's directThreadBusy and a bot delete's forBot both see it
  expect(runs.forBot("bot")).toHaveLength(1);
  // a second turn cannot start beside it
  expect(() => runs.admit("bot", "other-thread", { name: "second" })).toThrow("already running");
  // a terminal event of the old turn does not move it, and it is held only once
  expect(runs.settling(run)).toBe(false);
  expect(runs.holdForRebuild(run)).toBe(false);
  expect(runs.get("other-thread")?.phase).toBe("rebuilding");
});

it("the rebuilt turn takes the held run over in one step: the thread is never free, and what it held reaches its waiter", async () => {
  const runs = new IndependentThreadRuns<{ name: string }>();
  const released: string[] = [];
  runs.onReleased = threadId => { released.push(threadId); };
  const run = refused(runs, "t", ["browser:profile"]);
  const waiter = runs.admit("bot", "w", { name: "waiter" });
  const granted = runs.acquire(waiter, ["browser:profile"]);
  expect(runs.waiting(waiter)).toBe(true);
  expect(runs.holdForRebuild(run)).toBe(true);
  const rebuilt = runs.admit("bot", "t", { name: "rebuilt" }, [], { takeOver: run.generation });
  expect(rebuilt.generation).not.toBe(run.generation);
  expect(runs.get("t")).toMatchObject({ generation: rebuilt.generation, phase: "setup" });
  expect(runs.current(run)).toBe(false);
  // no release was announced: nothing queued on the thread could take it in between
  expect(released).toEqual([]);
  // the browser the refused turn held went to the turn waiting for it (the rebuilt one did not ask for it)
  await expect(granted).resolves.toBe(true);
  // the slot is counted once: the bot still has room for its other threads
  runs.admit("bot", "third", { name: "third" });
  expect(runs.forBot("bot")).toHaveLength(3);
});

it("a Stop in the wait ends the hold: the rebuild cannot take it over, and the thread is freed", () => {
  const runs = new IndependentThreadRuns<{ name: string }>();
  const run = refused(runs);
  expect(runs.holdForRebuild(run)).toBe(true);
  expect(runs.cancel(run)).toBe(true);
  expect(runs.get("t")?.phase).toBe("stopping");
  expect(runs.rebuilding(run)).toBe(false);
  expect(() => runs.admit("bot", "t", { name: "rebuilt" }, [], { takeOver: run.generation })).toThrow(DirectRebuildCancelled);
  // still the stopped run's until it is released (the rebuild or the Stop's own release does it)
  expect(runs.get("t")?.generation).toBe(run.generation);
  expect(runs.release(run)).toBe(true);
  expect(runs.get("t")).toBeUndefined();
  // a turn the Stop already ended is never held again
  const next = refused(runs);
  runs.cancel(next);
  expect(runs.holdForRebuild(next)).toBe(false);
});

it("only the held generation, still rebuilding, can be taken over; a takeover refused at the limit frees the thread", () => {
  const runs = new IndependentThreadRuns<{ name: string }>();
  const released: string[] = [];
  runs.onReleased = threadId => { released.push(threadId); };
  const run = refused(runs);
  // not held: nothing to take over
  expect(() => runs.admit("bot", "t", { name: "rebuilt" }, [], { takeOver: run.generation })).toThrow(DirectRebuildCancelled);
  expect(runs.holdForRebuild(run)).toBe(true);
  expect(() => runs.admit("bot", "t", { name: "rebuilt" }, [], { takeOver: "another-generation" })).toThrow(DirectRebuildCancelled);
  expect(runs.rebuilding(run)).toBe(true);
  // a refused takeover (here a resource another thread holds) gives the thread back as a release does
  const holder = runs.admit("bot", "h", { name: "holder" }, ["workspace:/w"]);
  expect(() => runs.admit("bot", "t", { name: "rebuilt" }, ["workspace:/w"], { takeOver: run.generation })).toThrow("Another thread");
  expect(runs.get("t")).toBeUndefined();
  expect(released).toEqual(["t"]);
  expect(runs.current(holder)).toBe(true);
});

it("a restart in the wait holds nothing: the run table is in memory only", () => {
  const before = new IndependentThreadRuns<{ name: string }>();
  const run = refused(before);
  expect(before.holdForRebuild(run)).toBe(true);
  const after = new IndependentThreadRuns<{ name: string }>();
  expect(after.get("t")).toBeUndefined();
  expect(after.rebuilding(run)).toBe(false);
  expect(() => after.admit("bot", "t", { name: "rebuilt" }, [], { takeOver: run.generation })).toThrow(DirectRebuildCancelled);
});
