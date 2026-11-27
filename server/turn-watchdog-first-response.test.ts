// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WINTERRY (1.0.22, customer report 2026-11-25): a dispatched turn whose engine shows no first sign of life is stopped at the
// first-response limit with its own named cause, not at the end of the whole silence limit. Only a turn given the limit (a
// routine run) is on this clock; lifecycle events are not a response; an open card, setup and waits are off it. The real server's wiring is in winterry-first-response-api.test.ts.
import { describe, expect, it } from "vitest";

import { noFirstResponseMessage, RoomTurnStallRegistry, roomTurnStallMessage } from "./room-turn-timeout.ts";
import { TurnWatchdog, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 60 * 60_000;
const FIRST = 5 * 60_000;
const MINUTE = 60_000;

function rig() {
  let now = 0;
  const stalls: WatchedTurn[] = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    setupStallMs: STALL,
    heartbeatOnlyMs: STALL,
    checkMs: 60_000,
    onStall: (turn) => stalls.push(turn),
    now: () => now,
  });
  /** A routine run's turn: admitted in setup, then dispatched with its first-response limit. */
  const dispatchRoutine = (threadId = "t1", generation = "g1") => {
    dog.watch(threadId, "bot1", { generation, setup: true });
    dog.dispatched(threadId, "bot1", generation, { firstResponseMs: FIRST });
  };
  return { dog, stalls, dispatchRoutine, tick: (ms: number) => { now += ms; dog.sweep(); } };
}
const causes = (stalls: WatchedTurn[]) => stalls.map((turn) => turn.stalledBy);

describe("TurnWatchdog first-response limit", () => {
  it("stops a dispatched turn whose engine never responds at its first-response limit, named no-first-response", () => {
    const { dog, stalls, dispatchRoutine, tick } = rig();
    dispatchRoutine();
    tick(FIRST - 1);
    expect(stalls).toEqual([]);
    tick(1);
    expect(stalls.map((turn) => [turn.threadId, turn.stalledBy])).toEqual([["t1", "no-first-response"]]);
    expect(dog.watching("t1")).toBe(false);
    tick(STALL);
    expect(stalls).toHaveLength(1); // once, and only once
  });

  it("lifecycle events keep the turn alive but are not a first response: the limit still ends it", () => {
    const { dog, stalls, dispatchRoutine, tick } = rig();
    dispatchRoutine();
    for (let minute = 1; minute < 5; minute++) { tick(MINUTE); dog.touch("t1"); } // turn.started, a retry, usage
    expect(stalls).toEqual([]);
    tick(MINUTE);
    expect(causes(stalls)).toEqual(["no-first-response"]);
  });

  it("the engine's first output or work ends the limit: the turn then has the whole silence limit", () => {
    const { dog, stalls, dispatchRoutine, tick } = rig();
    dispatchRoutine();
    tick(MINUTE);
    dog.firstResponse("t1");
    dog.touch("t1");
    tick(FIRST * 3);
    expect(stalls).toEqual([]);
    tick(STALL);
    expect(causes(stalls)).toEqual(["silence"]);
  });

  it("a turn with no first-response limit (an owner's own chat) is only on the silence limit", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1", { generation: "g1", setup: true });
    dog.dispatched("t1", "bot1", "g1");
    tick(STALL - 1);
    expect(stalls).toEqual([]);
    tick(1);
    expect(causes(stalls)).toEqual(["silence"]);
  });

  it("the limit can be given at watch, or after dispatch by the turn's own claim (as the server does for a routine run)", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t2", "bot2", { firstResponseMs: FIRST });
    dog.watch("t3", "bot3", { generation: "g3" });
    dog.watch("t4", "bot4", { generation: "g4", setup: true });
    dog.dispatched("t4", "bot4", "g4");
    dog.setFirstResponseLimit("t3", "another-claim", FIRST); // not this turn's claim: no limit
    dog.setFirstResponseLimit("t4", "g4", FIRST);
    tick(FIRST);
    expect(stalls.map((turn) => [turn.threadId, turn.stalledBy])).toEqual([["t2", "no-first-response"], ["t4", "no-first-response"]]);
    expect(dog.watching("t3")).toBe(true);
  });

  it("a card open for a person is the engine's response: not on the clock, then the silence limit", () => {
    const { dog, stalls, dispatchRoutine, tick } = rig();
    dispatchRoutine();
    tick(MINUTE);
    dog.setWaitingOnHuman("t1", true, "r1");
    tick(FIRST * 4);
    expect(stalls).toEqual([]);
    dog.setWaitingOnHuman("t1", false, "r1");
    tick(FIRST * 2);
    expect(stalls).toEqual([]);
  });

  it("setup is not on the clock: the limit starts at dispatch, and an event during setup is not the response", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1", { generation: "g1", setup: true, firstResponseMs: FIRST });
    tick(FIRST * 3);
    expect(stalls).toEqual([]);
    dog.firstResponse("t1"); // a Preparing chip before the prompt
    dog.dispatched("t1", "bot1", "g1");
    tick(FIRST - 1);
    expect(stalls).toEqual([]);
    tick(1);
    expect(causes(stalls)).toEqual(["no-first-response"]);
  });

  it("a turn waiting for a resource is not on the clock; the limit restarts when the wait ends", () => {
    const { dog, stalls, dispatchRoutine, tick } = rig();
    dispatchRoutine();
    const release = dog.waitingOn("t1", "thread-slot");
    tick(FIRST * 3);
    expect(stalls).toEqual([]);
    release();
    tick(FIRST - 1);
    expect(stalls).toEqual([]);
    tick(1);
    expect(causes(stalls)).toEqual(["no-first-response"]);
  });

  it("never longer than the turn's own silence limit, which keeps its own name", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1", { stallMs: 2 * MINUTE, firstResponseMs: FIRST });
    tick(2 * MINUTE);
    expect(causes(stalls)).toEqual(["silence"]);
  });

  // MAIN q1022-winproof r4: the retry pause has a generation fence. Only the watch's own turn's announced wait moves its clock.
  it.each([
    ["the turn's own generation and provider turn", "g1", "p1", []],
    ["a stopped turn's generation (a late retry)", "g0", "p1", ["no-first-response"]],
    ["another provider turn of the same generation", "g1", "p0", ["no-first-response"]],
    ["no generation (nobody can place it)", undefined, "p1", ["no-first-response"]],
  ] as const)("a ten-minute retry wait from %s: stopped at five minutes unless it is the turn's own", (_name, generation, providerTurnId, expected) => {
    const { dog, stalls, dispatchRoutine, tick } = rig();
    dispatchRoutine("t1", "g1");
    dog.bindProviderTurn("t1", "g1", "p1");
    dog.pauseFirstResponse("t1", 10 * MINUTE, providerTurnId, generation);
    tick(FIRST);
    expect(causes(stalls)).toEqual(expected);
  });
});

describe("the no first response line", () => {
  it("names the cause and the minutes", () => {
    expect(noFirstResponseMessage(5)).toBe("error: the engine gave no first response for 5 minutes: the turn was stopped");
    expect(noFirstResponseMessage(1)).toBe("error: the engine gave no first response for 1 minute: the turn was stopped");
  });
  it("a room's line carries the close-receipt tail, and the no activity line is unchanged", () => {
    expect(noFirstResponseMessage(5, "stopping; waiting for the engine to confirm close")).toBe("error: the engine gave no first response for 5 minutes: stopping; waiting for the engine to confirm close");
    expect(roomTurnStallMessage(20)).toBe("error: no activity for 20 minutes: stopping; waiting for the engine to confirm close");
  });
  it("the room registry hands the cause to the room's handler", () => {
    const registry = new RoomTurnStallRegistry();
    const seen: unknown[] = [];
    registry.register("t1", (cause) => seen.push(cause));
    expect(registry.stall("t1", "no-first-response")).toBe(true);
    expect(seen).toEqual(["no-first-response"]);
  });
});
