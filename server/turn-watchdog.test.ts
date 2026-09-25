// Stall-watchdog contract: activity keeps a turn alive indefinitely, human
// approvals pause the clock, silence past the ceiling stalls exactly once.
import { describe, expect, it } from "vitest";

import { TurnWatchdog, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 10_000;

function rig() {
  let now = 0;
  const stalls: WatchedTurn[] = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    checkMs: 60_000,
    onStall: (turn) => stalls.push(turn),
    now: () => now,
  });
  return { dog, stalls, tick: (ms: number) => (now += ms) };
}

describe("TurnWatchdog", () => {
  it("stalls a silent turn once, and only once", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "t1", botId: "bot1" })]);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(dog.watching("t1")).toBe(false);
  });

  it("any event on the thread resets the clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    for (let i = 0; i < 10; i++) {
      tick(STALL - 1);
      dog.touch("t1");
    }
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("never stalls a turn waiting on a human, however long they take", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    // the answer restarts the clock rather than inheriting the wait
    dog.setWaitingOnHuman("t1", false);
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("a settled turn is forgotten", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.settle("t1");
    tick(STALL * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("re-watching a thread replaces the previous turn", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.watch("t1", "bot2");
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(STALL);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ botId: "bot2" })]);
  });
});

// Upstream #1682 (index hunks e8a4418e, 0b2694a4), hand port: the watch is
// armed when the turn is ADMITTED, so a turn that wedges in setup, before any
// provider event exists, is caught too. A false stall kills real work, so
// every legitimate wait before dispatch is exempt, and setup as a whole has
// its own, longer ceiling.
describe("TurnWatchdog from admission", () => {
  const SETUP = STALL * 6;
  function admissionRig() {
    let now = 0;
    const stalls: WatchedTurn[] = [];
    const dog = new TurnWatchdog({
      stallMs: STALL,
      setupStallMs: SETUP,
      checkMs: 60_000,
      onStall: (turn) => stalls.push(turn),
      now: () => now,
    });
    return { dog, stalls, tick: (ms: number) => (now += ms) };
  }

  const reasons = [
    "thread-slot", // a routine queued for one of the bot's three thread slots
    "coordination-slot", // a handoff waiting for a running handoff to finish
    "capacity", // engine setup, a fenced provider bank or a restart gate
    "computer", // the bot's computer (VM, VPS, cloud box or this Mac)
    "browser", // the bot's browser profile and screen
    "working-folder", // another thread's writer lease on the project folder
    "room-turn", // queued behind a room turn of the same bot
  ] as const;

  for (const reason of reasons) {
    it(`never stalls a turn waiting on ${reason}, however long, and restarts the clock after`, () => {
      const { dog, stalls, tick } = admissionRig();
      dog.watch("t1", "bot1", { generation: "g1", setup: true });
      const release = dog.waitingOn("t1", reason, "g1");
      tick(SETUP * 50);
      dog.sweep();
      expect(stalls).toHaveLength(0);
      expect(dog.waits("t1")).toEqual([reason]);
      release();
      expect(dog.waits("t1")).toEqual([]);
      tick(SETUP - 1);
      dog.sweep();
      expect(stalls).toHaveLength(0);
      tick(2);
      dog.sweep();
      expect(stalls).toHaveLength(1);
    });
  }

  it("never stalls a turn behind a folder-trust question card (a person deciding)", () => {
    const { dog, stalls, tick } = admissionRig();
    dog.watch("t1", "bot1", { generation: "g1", setup: true });
    dog.dispatched("t1", "bot1", "g1");
    dog.setWaitingOnHuman("t1", true);
    tick(SETUP * 50);
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("holds while ANY of several overlapping waits is open", () => {
    const { dog, stalls, tick } = admissionRig();
    dog.watch("t1", "bot1", { generation: "g1", setup: true });
    const folder = dog.waitingOn("t1", "working-folder", "g1");
    const computer = dog.waitingOn("t1", "computer", "g1");
    folder();
    folder(); // releasing twice is harmless
    tick(SETUP * 10);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    computer();
    tick(SETUP + 1);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("latches setup: slow provider or integration setup gets the longer setup ceiling, not the running one", () => {
    const { dog, stalls, tick } = admissionRig();
    dog.watch("t1", "bot1", { generation: "g1", setup: true });
    tick(STALL * 3); // box provisioning, connected apps, memory: silent but alive
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(SETUP - STALL * 3 + 1); // but a setup that never returns is still caught
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "t1", phase: "setup" })]);
  });

  it("dispatch ends the setup latch and restarts the clock at the running ceiling", () => {
    const { dog, stalls, tick } = admissionRig();
    dog.watch("t1", "bot1", { generation: "g1", setup: true });
    tick(SETUP - 1);
    dog.dispatched("t1", "bot1", "g1");
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ phase: "running" })]);
  });

  it("dispatch re-arms a watch another event cleared, but never one that already stalled", () => {
    const { dog, stalls, tick } = admissionRig();
    dog.watch("t1", "bot1", { generation: "g1", setup: true });
    dog.settle("t1"); // e.g. a late terminal event from an earlier turn
    dog.dispatched("t1", "bot1", "g1");
    expect(dog.watching("t1")).toBe(true);
    dog.settle("t1", "g1");

    dog.watch("t2", "bot1", { generation: "g2", setup: true });
    tick(SETUP + 1);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    dog.dispatched("t2", "bot1", "g2");
    expect(dog.watching("t2")).toBe(false);
  });

  it("a generation settles only its own watch, and a stale wait release never touches a newer turn", () => {
    const { dog, stalls, tick } = admissionRig();
    dog.watch("t1", "bot1", { generation: "old", setup: true });
    const staleRelease = dog.waitingOn("t1", "computer", "old");
    dog.watch("t1", "bot1", { generation: "new", setup: true });
    dog.settle("t1", "old");
    expect(dog.watching("t1")).toBe(true);
    const current = dog.waitingOn("t1", "working-folder", "new");
    staleRelease();
    expect(dog.waits("t1")).toEqual(["working-folder"]);
    expect(dog.waitingOn("t1", "computer", "old")).toBeTypeOf("function"); // wrong generation: no hold
    expect(dog.waits("t1")).toEqual(["working-folder"]);
    current();
    dog.settle("t1", "new");
    expect(dog.watching("t1")).toBe(false);
    tick(SETUP * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("settleSetup clears only a watch still in setup", () => {
    const { dog } = admissionRig();
    dog.watch("t1", "bot1", { generation: "g1", setup: true });
    dog.settleSetup("t1", "g1");
    expect(dog.watching("t1")).toBe(false);
    dog.watch("t1", "bot1", { generation: "g2", setup: true });
    dog.dispatched("t1", "bot1", "g2");
    dog.settleSetup("t1", "g2");
    expect(dog.watching("t1")).toBe(true);
  });
});
