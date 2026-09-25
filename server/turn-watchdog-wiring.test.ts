// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The admission watch (upstream #1682, hand port) is only as safe as its
// wiring. turn-watchdog.test.ts proves what the watchdog does with a wait, a
// person, a setup latch and a generation; this file pins WHERE index.ts tells
// it so, because a false stall kills real work and nothing else would notice
// a wait that stopped being reported. Each assertion names the exemption it
// guards. (The stall ceiling is at least a minute, so an end-to-end stall
// test would add minutes per case; the behaviour itself is unit-tested.)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

/** The text of one top-level `function name(` or `async function name(`. */
function fn(name: string): string {
  const start = SOURCE.search(new RegExp(`\\n(?:async )?function ${name}\\s*[<(]`));
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const next = SOURCE.slice(start + 1).search(/\n(?:async )?function |\nconst |\nclass /);
  return SOURCE.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe("stall watchdog wiring (admission, exemptions, setup latch)", () => {
  it("arms the direct watch at admission, in setup, under the turn's own generation", () => {
    const body = fn("startTurn");
    const admit = body.indexOf("directRuns.admit(");
    const watch = body.indexOf('watchdog.watch(threadId, bot.id, { generation: dispatchClaimId, setup: true })');
    const firstWait = body.indexOf("await acquireDirectTurnSlot(run)");
    expect(admit).toBeGreaterThan(-1);
    expect(watch).toBeGreaterThan(admit);
    expect(watch).toBeLessThan(firstWait);
    // dispatch ends the setup latch instead of arming a second watch
    expect(body).toContain("watchdog.dispatched(threadId, bot.id, dispatchClaimId)");
    expect(body.match(/watchdog\.watch\(/g)).toHaveLength(1);
    // every setup exit lands in the catch, which settles only its own watch
    expect(body).toContain("watchdog.settle(threadId, dispatchClaimId)");
  });

  it("exempts a routine waiting for a thread slot", () => {
    const body = fn("acquireDirectTurnSlot");
    expect(body).toMatch(/watchdog\.waitingOn\(run\.threadId,"thread-slot",run\.generation\)/);
    expect(body).toMatch(/finally\{releaseStallWait\(\);\}/);
  });

  it("exempts computer, browser and working-folder claims held by another thread", () => {
    const body = fn("acquireDirectTurnResources");
    // the reason is the same kind the task shows as "waiting for ..."
    expect(body).toMatch(/releaseStallWait=watchdog\.waitingOn\(run\.threadId,waitingFor\.resource,run\.generation\)/);
    expect(body).toMatch(/\}finally\{\s*releaseStallWait\(\);/);
    // and every claim a direct turn makes goes through that helper
    const startTurn = fn("startTurn");
    expect(startTurn).not.toMatch(/directRuns\.acquire\(/);
    expect(startTurn.match(/await acquireDirectTurnResources\(run,/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("exempts waits that happen before admission: queued behind a room turn, coordination slots, capacity", () => {
    // A direct send while the bot speaks in a room is queued, not admitted.
    expect(SOURCE).toMatch(/if \(activeGroupTurnForBot\(currentAtStart\.id\)\) \{\s*const queued = queueSteeredMessage\(/);
    // Handoff capacity refuses instead of waiting inside a turn.
    expect(fn("holdCoordinationSlot")).not.toContain("watchdog");
    // A goal waiting for a busy teammate waits before the member turn runs.
    const goalStep = fn("runGroupGoalStep");
    expect(goalStep.indexOf("await waitForGroupGoalBot(")).toBeGreaterThan(-1);
    expect(goalStep).not.toContain("watchdog.watch(");
    // Only the two admission points ever arm a watch.
    expect(SOURCE.match(/watchdog\.watch\(/g)).toHaveLength(2);
  });

  it("exempts a person deciding: every request.opened, folder-trust cards included, holds the clock", () => {
    expect(SOURCE).toContain('if (event.type === "request.opened") watchdog.setWaitingOnHuman(event.threadId, true);');
    expect(SOURCE).toContain('else if (event.type === "request.resolved") watchdog.setWaitingOnHuman(event.threadId, false);');
  });

  it("latches setup to its own ceiling, never shorter than the running one", () => {
    expect(SOURCE).toMatch(/const TURN_SETUP_STALL_MS = Math\.max\(TURN_STALL_MS,/);
    expect(SOURCE).toMatch(/setupStallMs: TURN_SETUP_STALL_MS,/);
  });

  it("arms the room watch at the claim with a setup latch honoured before dispatch", () => {
    const body = fn("runGroupMemberTurn");
    const claim = body.indexOf("groupSpeakers.set(threadId, { botId: bot.id, name: bot.name, color: bot.color });");
    const latch = body.indexOf("unregisterSetupStall = roomStallCompletions.register(threadId, () => { setupStalled = true; });");
    const watch = body.indexOf("watchdog.watch(threadId, bot.id, { generation: internalGeneration, setup: true });");
    const honoured = body.indexOf("if (setupStalled) {");
    const outcome = body.indexOf("const outcome = await new Promise<GroupMemberTurnOutcome>");
    const swap = body.indexOf("unregisterSetupStall();\n    unregisterStall = roomStallCompletions.register(");
    expect(claim).toBeGreaterThan(-1);
    expect(latch).toBeGreaterThan(claim);
    expect(watch).toBeGreaterThan(latch);
    expect(honoured).toBeGreaterThan(watch);
    expect(honoured).toBeLessThan(outcome);
    // nothing yields between the latch check and the swap: the only awaits
    // are the stalled exit's own release and the Promise whose executor runs
    // synchronously up to the swap
    expect(body.slice(honoured, swap)).not.toMatch(/await (?!releaseUnstartedRoomTurn\(\)|new Promise<GroupMemberTurnOutcome>)/);
    expect(swap).toBeGreaterThan(outcome);
    expect(body).toContain("watchdog.dispatched(threadId, bot.id, internalGeneration)");
    // every other exit clears the latch and this attempt's setup watch
    expect(body).toMatch(/\} finally \{\s*unregisterSetupStall\(\);\s*watchdog\.settleSetup\(threadId, internalGeneration\);/);
  });

  it("a Stop during direct setup ends that setup's watch", () => {
    expect(fn("interruptDirectThread")).toContain("watchdog.settleSetup(threadId,run.generation)");
  });
});
