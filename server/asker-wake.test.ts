// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { AskerWakes, askerWakeHeldIds, askerWakePrompt, askerWakeTurnOptions, heldWakeId, MAX_ASKER_RESULTS, MAX_ASKER_WAKES, MAX_ASKER_WAKE_ATTEMPTS, type AskerWakeIntent, type AskerWakeSnapshot } from "./asker-wake.ts";
import { askerWakeIntent, wakeAfterRecoveredReceipt, type AskerWakePort } from "./handoff-boundary.ts";

const intent = (threadId = "t1"): AskerWakeIntent => ({
  botId: "lead", threadId, depth: 0, coordination: { rootId: "r", path: ["lead"] }, notOwnerAudience: false, unattended: false,
});
const reply = { toBotId: "mate", toBotName: "Mate", ok: true };
/** A store stand-in: what the wakes write per thread, as JSON (what a restart reads back). */
function kept() {
  const saved = new Map<string, AskerWakeSnapshot>();
  const persist = (botId: string, threadId: string, snapshot: AskerWakeSnapshot | undefined) => {
    expect(botId).toBe("lead");
    if (snapshot) saved.set(threadId, JSON.parse(JSON.stringify(snapshot))); else saved.delete(threadId);
  };
  return { saved, persist, wakes: () => saved.get("t1")?.wakes ?? [] };
}
const stillOwed = () => true;
const owedOnly = (ids: string[]) => (r: { messageId?: string }) => Boolean(r.messageId && ids.includes(r.messageId));

describe("asker wakes", () => {
  it("owes one wake per handed-over ask, once", () => {
    const wakes = new AskerWakes();
    wakes.register("task-1", intent());
    expect(wakes.deliver("task-1", reply)).toBe(true);
    expect(wakes.deliver("task-1", reply)).toBe(false);
    expect(wakes.deliver("never-registered", reply)).toBe(false);
    const record = wakes.claim("t1")!;
    expect(record.results.map((r) => r.taskId)).toEqual(["task-1"]);
    expect(record.intent.coordination).toEqual({ rootId: "r", path: ["lead"] });
    expect(record.state).toBe("claimed");
    expect(wakes.claim("t1")).toBeUndefined();
  });
  it("merges replies for one thread into one wake and caps them", () => {
    const wakes = new AskerWakes();
    for (let i = 0; i < MAX_ASKER_RESULTS + 5; i++) { wakes.register(`k${i}`, intent()); wakes.deliver(`k${i}`, reply); }
    expect(wakes.claim("t1")!.results).toHaveLength(MAX_ASKER_RESULTS);
    // the overflow is a second wake, not a lost reply
    expect(wakes.claim("t1")!.results).toHaveLength(5);
  });
  it("owes nothing for a task the asker read itself", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.register("b", intent());
    wakes.deliver("a", reply); wakes.deliver("b", reply);
    wakes.consume("a");
    expect(wakes.claim("t1")!.results.map((r) => r.taskId)).toEqual(["b"]);
    wakes.register("c", intent()); wakes.consume("c");
    expect(wakes.deliver("c", reply)).toBe(false);
  });
  it("drops a stopped asker's wake and bounds the starts given back", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.deliver("a", reply);
    wakes.drop("t1");
    expect(wakes.has("t1")).toBe(false);
    wakes.register("b", intent()); wakes.deliver("b", reply);
    let record = wakes.claim("t1")!;
    let requeued = 0;
    while (wakes.requeue(record.id)) { requeued += 1; record = wakes.claim("t1")!; }
    expect(requeued).toBe(MAX_ASKER_WAKE_ATTEMPTS - 1);
    // the last refusal ended the record, not only the attempt
    expect(wakes.startable(record.id)).toBe(false);
    expect(wakes.has("t1")).toBe(false);
  });
  it("names the task and teammate but never repeats the reply", () => {
    const text = askerWakePrompt([{ taskId: "x1", toBotId: "m", toBotName: "Mate", ok: true }, { taskId: "x2", toBotId: "n", toBotName: "Nia", ok: false }]);
    expect(text).toContain("@Mate replied to the task you handed off (task id x1)");
    expect(text).toContain("@Nia did not finish the task you handed off (task id x2)");
  });
  it("forgets asks still out when the asker is stopped, so a late reply cannot restart it", () => {
    const wakes = new AskerWakes();
    wakes.register("late", intent());
    wakes.register("other-thread", intent("t2"));
    wakes.drop("t1");
    expect(wakes.deliver("late", reply)).toBe(false);
    expect(wakes.deliver("other-thread", reply)).toBe(true);
  });
  it("never merges replies that were asked under different authority", () => {
    const wakes = new AskerWakes();
    const owner = intent();
    const deeper: AskerWakeIntent = { ...intent(), depth: 1, notOwnerAudience: true, coordination: { rootId: "r2", path: ["boss", "lead"] } };
    wakes.register("a", owner); wakes.register("b", deeper);
    wakes.deliver("a", reply); wakes.deliver("b", reply);
    const first = wakes.claim("t1")!;
    expect(first.results.map((r) => r.taskId)).toEqual(["a"]);
    expect(first.intent).toEqual(owner);
    const second = wakes.claim("t1")!;
    expect(second.results.map((r) => r.taskId)).toEqual(["b"]);
    expect(second.intent.notOwnerAudience).toBe(true);
    expect(second.intent.depth).toBe(1);
  });
  it("keeps the automation budget the ask ran under", () => {
    const wakes = new AskerWakes();
    wakes.register("a", { ...intent(), eventId: "evt-1" });
    wakes.deliver("a", reply);
    expect(wakes.claim("t1")!.intent.eventId).toBe("evt-1");
  });
  // Opus gate: a routine run that has ended leaves no trace on its thread, so
  // a plain new turn there would be judged as the owner's own.
  it("runs the wake of a routine run's ask unattended, and an owner's ask as the owner's", () => {
    expect(askerWakeTurnOptions(intent())).toEqual({ askerWake: true, coordination: { rootId: "r", path: ["lead"] } });
    expect(askerWakeTurnOptions({ ...intent(), routineRun: true, eventId: "evt-1" })).toEqual({ askerWake: true, coordination: { rootId: "r", path: ["lead"] }, unattended: true, eventId: "evt-1" });
    expect(askerWakeTurnOptions({ ...intent(), depth: 1, notOwnerAudience: true, unattended: true, coordination: undefined }))
      .toEqual({ askerWake: true, commsDepth: 1, notOwnerAudience: true, chainNotOwner: true, unattended: true });
  });
  it("never merges a routine run's reply into the owner's wake", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.register("b", { ...intent(), routineRun: true });
    wakes.deliver("a", reply); wakes.deliver("b", reply);
    expect(wakes.claim("t1")!.results.map((r) => r.taskId)).toEqual(["a"]);
    expect(wakes.claim("t1")!.intent.routineRun).toBe(true);
  });
  it("forgets everything a stopped or deleted bot asked for, in every thread, and nobody else's", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent("t1")); wakes.register("b", intent("t2")); wakes.register("c", intent("t2"));
    wakes.register("d", { ...intent("t3"), botId: "other" }); wakes.register("e", { ...intent("t4"), botId: "other" });
    wakes.deliver("a", reply); wakes.deliver("d", reply);
    wakes.dropBot("lead");
    expect(wakes.threads()).toEqual(["t3"]);
    expect(wakes.deliver("b", reply)).toBe(false);
    expect(wakes.deliver("c", reply)).toBe(false);
    expect(wakes.deliver("e", reply)).toBe(true);
  });
  // Astra r1 item 1: the woken turn's ceiling is the one the asker had when it asked, carried on the wake. Reading it
  // from the live per-thread map lets an owner turn in between clear it, and the wake would run at the bot's own level.
  it("carries the asking turn's routine ceiling into the wake", () => {
    const ceiling = { permissionMode: "ask" as const, triggerSource: "manual" as const };
    const wakes = new AskerWakes();
    wakes.register("a", { ...intent(), routineAuthority: ceiling });
    wakes.deliver("a", reply);
    const record = wakes.claim("t1")!;
    expect(askerWakeTurnOptions(record.intent)).toEqual({ askerWake: true, coordination: { rootId: "r", path: ["lead"] }, routineAuthority: ceiling });
  });
  // Astra build r3 High 1: the asking bot's own level is part of the ceiling. Raised to Full access after the ask, the wake still runs
  // at the level it asked under (the lower of the two is applied at admission).
  it("carries the asking bot's own level, keeps it apart from a wake asked at another, and refuses one that does not read back", () => {
    const wakes = new AskerWakes();
    wakes.register("a", { ...intent(), askingMode: "ask" }); wakes.register("b", { ...intent(), askingMode: "full" });
    wakes.deliver("a", reply); wakes.deliver("b", reply);
    const first = wakes.claim("t1")!;
    expect(first.results.map((r) => r.taskId)).toEqual(["a"]);
    expect(askerWakeTurnOptions(first.intent)).toEqual({ askerWake: true, askerWakeCeiling: "ask", coordination: { rootId: "r", path: ["lead"] } });
    expect(wakes.claim("t1")!.intent.askingMode).toBe("full");
    const restored = new AskerWakes();
    restored.restore("t1", { intents: [{ taskId: "x", intent: { ...intent(), askingMode: "ask" } }, { taskId: "y", intent: { ...intent(), askingMode: "root" } }], wakes: [] } as never, new Set());
    expect(restored.deliver("x", reply)).toBe(true);
    expect(restored.deliver("y", reply)).toBe(false);
    expect(restored.claim("t1")!.intent.askingMode).toBe("ask");
  });
  it("tells a caller the state it must decide by", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.deliver("a", reply);
    const record = wakes.claim("t1")!;
    expect(wakes.stateOf(record.id)).toBe("claimed");
    expect(wakes.isHeld(record.id)).toBe(false);
    wakes.hold(record.id);
    expect(wakes.isHeld(record.id)).toBe(true);
    wakes.start(record.id);
    expect(wakes.stateOf(record.id)).toBe("started");
    expect(wakes.isHeld(record.id)).toBe(false);
    wakes.done(record.id);
    expect(wakes.stateOf(record.id)).toBeUndefined();
  });
  it("never merges replies asked under different routine ceilings", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.register("b", { ...intent(), routineAuthority: { permissionMode: "ask", triggerSource: "manual" } });
    wakes.deliver("a", reply); wakes.deliver("b", reply);
    expect(wakes.claim("t1")!.results.map((r) => r.taskId)).toEqual(["a"]);
    expect(wakes.claim("t1")!.intent.routineAuthority?.permissionMode).toBe("ask");
  });
  it("captures the asker's ceiling and audience when the hand-off is made", () => {
    const ceiling = { permissionMode: "auto" as const, triggerSource: "schedule" as const };
    const seen: Array<[string | undefined, string | undefined]> = [];
    const captured = askerWakeIntent({
      isUnattended: () => false,
      ownerSurfacesByThread: new Map([["t1", false]]),
      routinePeerSource: (threadId, botId) => { seen.push([threadId, botId]); return ceiling; },
      internalClaim: { notOwnerAudience: undefined } as never,
      internalEventId: undefined,
      internalOwner: undefined as never,
    }, "lead", "t1", 0);
    expect(captured.routineAuthority).toEqual(ceiling);
    expect(captured.notOwnerAudience).toBe(true);
    expect(seen).toEqual([["t1", "lead"]]);
  });

  // ── the state machine (DELEGATE-WAKE-DESIGN.md section 2) ──────────────────

  // Astra r2 High: Stop between the claim (or the drain's selection of a held wake) and admission. Admission re-checks the record.
  it("refuses to start a wake that Stop cancelled after it was claimed, wherever it waited", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.deliver("a", reply);
    const first = wakes.claim("t1")!;
    expect(wakes.startable(first.id)).toBe(true);
    wakes.drop("t1");
    expect(wakes.startable(first.id)).toBe(false);
    expect(wakes.check(first.id, stillOwed)).toBe(false);
    // held for an engine without tools, then Stop: the held item's replay finds no record
    wakes.register("b", intent()); wakes.deliver("b", reply);
    const second = wakes.claim("t1")!;
    expect(wakes.check(second.id, stillOwed)).toBe(true);
    wakes.hold(second.id);
    expect(heldWakeId(second.id)).toBe(`wake:${second.id}`);
    expect(wakes.check(second.id, stillOwed)).toBe(true);
    wakes.dropBot("lead");
    expect(wakes.check(second.id, stillOwed)).toBe(false);
    expect(wakes.replayHeld(second.id)).toBe(false);
    // handed to the engine (started), then Stop before the engine accepted: the rebuild finds no record either
    wakes.register("c", intent()); wakes.deliver("c", reply);
    const third = wakes.claim("t1")!;
    expect(wakes.start(third.id)).toBe(true);
    expect(wakes.check(third.id, stillOwed)).toBe(true);
    wakes.drop("t1");
    expect(wakes.check(third.id, stillOwed)).toBe(false);
    expect(wakes.start(third.id)).toBe(false);
    expect(wakes.has("t1")).toBe(false);
    // Stop between admission and the fence: the fence is the compare-and-set that refuses the submission
    wakes.register("d", intent()); wakes.deliver("d", reply);
    const fourth = wakes.claim("t1")!;
    expect(wakes.check(fourth.id, stillOwed)).toBe(true);
    wakes.drop("t1");
    expect(wakes.start(fourth.id)).toBe(false);
  });
  // the state x event matrix (design section 2): an event that does not apply to a record's state changes nothing
  it("events on the wrong state are inert", () => {
    const { persist, wakes: onDisk } = kept();
    const wakes = new AskerWakes(persist);
    wakes.register("a", intent()); wakes.deliver("a", reply);
    const owed = onDisk()[0];
    expect(wakes.start(owed.id)).toBe(false);
    wakes.hold(owed.id);
    expect(wakes.replayHeld(owed.id)).toBe(false);
    expect(wakes.requeue(owed.id)).toBe(false);
    wakes.done(owed.id);
    expect(onDisk()).toEqual([owed]);
    expect(wakes.check(owed.id, () => false)).toBe(false); // never claimed: the re-check cancels nothing it was not handed
    const record = wakes.claim("t1")!;
    expect(wakes.replayHeld(record.id)).toBe(false); // not held
    wakes.start(record.id);
    wakes.hold(record.id); // the hold is decided before the fence
    expect(onDisk().map((w) => [w.state, w.held])).toEqual([["started", undefined]]);
    expect(wakes.replayHeld(record.id)).toBe(false); // a started record is not replayed
    wakes.done(record.id);
    wakes.done(record.id);
    wakes.cancel(record.id);
    expect(wakes.check(record.id, () => false)).toBe(true); // cancel leaves the tombstone; only Stop clears it
    expect(wakes.claim("t1")).toBeUndefined();
  });
  it("claims a wake exactly once, and never one that is claimed, held or started", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.deliver("a", reply);
    const record = wakes.claim("t1")!;
    expect(wakes.has("t1")).toBe(false);
    expect(wakes.threads()).toEqual([]);
    expect(wakes.claim("t1")).toBeUndefined();
    wakes.hold(record.id);
    expect(wakes.claim("t1")).toBeUndefined();
    wakes.start(record.id);
    expect(wakes.claim("t1")).toBeUndefined();
    // a reply that lands meanwhile is a wake of its own, never added to the one in flight
    wakes.register("b", intent()); wakes.deliver("b", reply);
    const next = wakes.claim("t1")!;
    expect(next.id).not.toBe(record.id);
    expect(next.results.map((r) => r.taskId)).toEqual(["b"]);
  });
  // Astra r2 Q4 and design r1 High 2: a memory redispatch rebuilds the same turn, before acceptance (claimed or started) or after
  // it (done). It is the same turn, not a second wake, and Stop in between still ends it: the done tombstone goes with the thread.
  it("lets a rebuilt turn pass the re-check before and after acceptance, but never after Stop", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.deliver("a", reply);
    const record = wakes.claim("t1")!;
    expect(wakes.start(record.id)).toBe(true);
    expect(wakes.start(record.id)).toBe(true); // the fence is idempotent
    expect(wakes.check(record.id, stillOwed)).toBe(true);
    wakes.done(record.id);
    expect(wakes.startable(record.id)).toBe(false);
    expect(wakes.check(record.id, () => false)).toBe(true);
    expect(wakes.start(record.id)).toBe(true);
    // Astra build r3 High 2: accepted before the fence, or rebuilt, the authority of what it carried is asked again
    expect(wakes.start(record.id, () => false, () => false)).toBe(false);
    expect(wakes.check(record.id, () => false, () => false)).toBe(false);
    expect(wakes.start(record.id, () => false, (r) => r.toBotId === "mate")).toBe(true);
    // design r2 Medium 1: the late memory refusal ends the engine's turn without success before its rebuild runs; that
    // ending keeps the tombstone (only Stop clears it), so the rebuild is still told apart from a cancelled wake
    wakes.failed("t1");
    expect(wakes.check(record.id, () => false)).toBe(true);
    wakes.drop("t1");
    expect(wakes.check(record.id, stillOwed)).toBe(false);
    // design r2 Medium 2: an engine that hands its turn id back early accepts before the fence; done from claimed, the fence a no-op
    wakes.register("b", intent()); wakes.deliver("b", reply);
    const early = wakes.claim("t1")!;
    wakes.done(early.id);
    expect(wakes.start(early.id)).toBe(true);
    expect(wakes.startable(early.id)).toBe(false);
    expect(wakes.has("t1")).toBe(false);
    expect(wakes.check(early.id, () => false)).toBe(true);
    wakes.drop("t1");
    expect(wakes.start(early.id)).toBe(false);
    // the tombstones are bounded, and a bot-wide stop clears them too
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) { wakes.register(`d${i}`, intent()); wakes.deliver(`d${i}`, reply); const r = wakes.claim("t1")!; wakes.start(r.id); wakes.done(r.id); ids.push(r.id); }
    expect(wakes.check(ids[0], stillOwed)).toBe(false);
    expect(wakes.check(ids[9], stillOwed)).toBe(true);
    wakes.dropBot("lead");
    expect(wakes.check(ids[9], stillOwed)).toBe(false);
  });
  it("cancels a wake at the re-check when none of its replies is still owed to the engine", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.deliver("a", { ...reply, messageId: "m1" });
    wakes.register("b", intent()); wakes.deliver("b", { ...reply, messageId: "m2" });
    const record = wakes.claim("t1")!;
    expect(wakes.check(record.id, owedOnly(["m2"]))).toBe(true);
    wakes.hold(record.id);
    wakes.requeue(record.id); // a held wake given back is owed again, and no longer held
    const back = wakes.claim("t1")!;
    expect(back.held).toBeUndefined();
    wakes.requeue(back.id);
    const again = wakes.claim("t1")!;
    expect(wakes.check(again.id, () => false)).toBe(false);
    expect(wakes.startable(again.id)).toBe(false);
    expect(wakes.has("t1")).toBe(false);
    // the fence asks the same question: the teammate deleted, or the edge revoked, between admission and submission refuses it
    wakes.register("c", intent()); wakes.deliver("c", { ...reply, messageId: "m3" });
    const gated = wakes.claim("t1")!;
    expect(wakes.check(gated.id, stillOwed)).toBe(true);
    expect(wakes.start(gated.id, () => false)).toBe(false);
    expect(wakes.startable(gated.id)).toBe(false);
  });
  // Sean's contract: delivery is idempotent by task and by line, and overflow drops nothing that is kept.
  it("delivers one return once, however many paths bring it, and refuses a newcomer when the thread is full", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent());
    expect(wakes.deliver("a", { ...reply, messageId: "m1" })).toBe(true);
    expect(wakes.deliver("a", { ...reply, messageId: "m1" })).toBe(false);
    wakes.register("a", intent()); // registered again (a replayed commit): the same line is still one wake
    expect(wakes.deliver("a", { ...reply, messageId: "m1" })).toBe(false);
    wakes.register("a-copy", intent());
    expect(wakes.deliver("a-copy", { ...reply, messageId: "m1" })).toBe(false);
    expect(wakes.claim("t1")!.results).toHaveLength(1);
    const full = new AskerWakes();
    for (let i = 0; i < MAX_ASKER_WAKES; i++) { full.register(`k${i}`, { ...intent(), eventId: `evt-${i}` }); expect(full.deliver(`k${i}`, reply)).toBe(true); }
    full.register("late", { ...intent(), eventId: "evt-late" });
    expect(full.deliver("late", reply)).toBe(false);
    let kept = 0;
    while (full.claim("t1")) kept += 1;
    expect(kept).toBe(MAX_ASKER_WAKES);
  });
  // Astra build r5 Medium: a cancellation whose write the disk refused is written again, by the sweep or by the next change.
  it("writes a refused cancellation again as soon as the disk takes it", () => {
    let broken = false;
    const saved = new Map<string, AskerWakeSnapshot | undefined>();
    const wakes = new AskerWakes((botId, threadId, snapshot) => { if (broken) throw new Error("disk full"); expect(botId).toBe("lead"); saved.set(threadId, snapshot); });
    wakes.register("a", intent()); wakes.deliver("a", reply);
    expect(saved.get("t1")?.wakes).toHaveLength(1);
    broken = true;
    wakes.drop("t1");
    expect(wakes.has("t1")).toBe(false);
    expect(saved.get("t1")?.wakes).toHaveLength(1); // disk still says owed
    expect(wakes.retryWrites()).toBe(false);
    broken = false;
    expect(wakes.retryWrites()).toBe(true);
    expect(saved.get("t1")).toBeUndefined();
    // the same for a bot-wide stop, caught up by the next change to the thread instead of the sweep
    wakes.register("b", intent()); wakes.deliver("b", reply);
    broken = true;
    wakes.dropBot("lead");
    broken = false;
    wakes.register("c", intent());
    expect(saved.get("t1")?.wakes).toEqual([]);
    expect(wakes.retryWrites()).toBe(true);
  });
  // Astra design r4 High: a transition that must be durable before it counts is refused, and undone, when its write fails.
  it("refuses a claim, a fence and a replay whose write did not land", () => {
    let broken = false;
    const wakes = new AskerWakes(() => { if (broken) throw new Error("disk full"); });
    wakes.register("a", intent()); wakes.deliver("a", reply);
    broken = true;
    expect(wakes.claim("t1")).toBeUndefined();
    broken = false;
    const record = wakes.claim("t1")!;
    broken = true;
    expect(wakes.start(record.id)).toBe(false);
    expect(wakes.startable(record.id)).toBe(true);
    broken = false;
    wakes.hold(record.id);
    broken = true;
    expect(wakes.replayHeld(record.id)).toBe(false);
    broken = false;
    expect(wakes.replayHeld(record.id)).toBe(true);
    expect(wakes.claim("t1")).toBeUndefined();
  });
  // design r1 Medium 3 and r2 Medium 3: a held wake's replays are bounded like a direct wake's starts, where a card's retry is not,
  // and each replay is paid for on disk before it begins, so a replay that crashes in setup cannot loop for free after a restart.
  it("spends one attempt per held replay, on disk first, and ends the wake at the cap", () => {
    const { persist, wakes: onDisk } = kept();
    const wakes = new AskerWakes(persist);
    wakes.register("a", intent()); wakes.deliver("a", reply);
    const record = wakes.claim("t1")!;
    wakes.hold(record.id);
    expect(wakes.replayHeld(record.id)).toBe(true);
    expect(onDisk()[0].attempts).toBe(1);
    expect(wakes.startable(record.id)).toBe(true);
    // one counter: a start given back and a replay both spend from it
    wakes.requeue(record.id);
    const again = wakes.claim("t1")!;
    expect(again.attempts).toBe(2);
    wakes.hold(again.id);
    let replayed = 0;
    while (wakes.replayHeld(again.id)) replayed += 1;
    // attempts 2 spent already; replays 3 to 6 begin; the call that would begin a seventh ends the wake
    expect(replayed).toBe(MAX_ASKER_WAKE_ATTEMPTS - 2);
    expect(wakes.startable(again.id)).toBe(false);
    expect(onDisk()).toEqual([]);
    expect(wakes.replayHeld("never")).toBe(false);
  });
  it("drops a wake found at the cap after a restart, claimed or held", () => {
    const { saved, persist, wakes: onDisk } = kept();
    const before = new AskerWakes(persist);
    before.register("a", intent()); before.deliver("a", reply);
    before.register("b", { ...intent(), routineRun: true }); before.deliver("b", reply);
    let claimed = before.claim("t1")!;
    for (let i = 0; i < MAX_ASKER_WAKE_ATTEMPTS - 2; i++) { before.requeue(claimed.id); claimed = before.claim("t1")!; }
    expect(claimed.attempts).toBe(MAX_ASKER_WAKE_ATTEMPTS - 2);
    const held = before.claim("t1")!;
    before.hold(held.id);
    // every one of its attempts was spent on replays that never came back (a crash in setup each time)
    for (let i = 0; i < MAX_ASKER_WAKE_ATTEMPTS; i++) expect(before.replayHeld(held.id)).toBe(true);
    const after = new AskerWakes(persist);
    for (const [threadId, snapshot] of saved) after.restore(threadId, snapshot, new Set([heldWakeId(held.id)]));
    // the claimed one came back once more, its lost attempt counted (5 of 6); the held one had spent all 6 and is gone
    expect(onDisk().map((w) => [w.id, w.state, w.attempts])).toEqual([[claimed.id, "owed", MAX_ASKER_WAKE_ATTEMPTS - 1]]);
    expect(after.startable(held.id)).toBe(false);
    // a restart while it is owed costs nothing: nothing was running
    const again = new AskerWakes(persist);
    for (const [threadId, snapshot] of saved) again.restore(threadId, snapshot, new Set());
    expect(onDisk().map((w) => [w.state, w.attempts])).toEqual([["owed", MAX_ASKER_WAKE_ATTEMPTS - 1]]);
    // its sixth start is the last: refused, it is over
    const last = again.claim("t1")!;
    expect(again.requeue(last.id)).toBe(false);
    expect(onDisk()).toEqual([]);
    expect(again.threads()).toEqual([]);
  });
  it("gives a refused start back as owed, bounded, and a failed start up", () => {
    const wakes = new AskerWakes();
    wakes.register("a", intent()); wakes.deliver("a", reply);
    const record = wakes.claim("t1")!;
    wakes.start(record.id);
    expect(wakes.requeue(record.id)).toBe(true);
    expect(wakes.has("t1")).toBe(true);
    const again = wakes.claim("t1")!;
    expect(again.id).toBe(record.id);
    expect(again.attempts).toBe(1);
    wakes.cancel(again.id);
    expect(wakes.has("t1")).toBe(false);
    expect(wakes.requeue(again.id)).toBe(false);
  });
  it("finds only the wake items among a thread's held continuations", () => {
    expect(askerWakeHeldIds([
      { id: "w1", text: "x", at: 1, options: { askerWake: true } },
      { id: "card", text: "y", at: 2, options: { cardContinuation: true } },
      { id: "plain", text: "z", at: 3 },
    ])).toEqual(["w1"]);
    expect(askerWakeHeldIds(undefined)).toEqual([]);
  });

  // Astra r1 item 5: a result recovered from its receipt after the final commit failed wakes the asker too.
  it("wakes the asker for a direct hand-off's result recovered from its receipt", () => {
    const calls: unknown[] = [];
    const port: AskerWakePort = { register: () => {}, consume: (taskId) => { calls.push(["consume", taskId]); }, returned: (...args) => { calls.push(["returned", ...args]); } };
    const receipt = { id: "task-1", sourceThreadId: "t1", toBotId: "mate", toBotName: "Mate" };
    wakeAfterRecoveredReceipt(port, { ...receipt, status: "done" }, "line-1");
    wakeAfterRecoveredReceipt(port, { ...receipt, id: "task-2", status: "failed" }, "line-2");
    // a hand-off the owner or the ledger ended restarts nobody, and nothing is owed without its line
    wakeAfterRecoveredReceipt(port, { ...receipt, id: "task-3", status: "cancelled" }, "line-3");
    wakeAfterRecoveredReceipt(port, { ...receipt, id: "task-4", status: "done" }, undefined);
    wakeAfterRecoveredReceipt(undefined, { ...receipt, id: "task-5", status: "done" }, "line-5");
    expect(calls).toEqual([
      ["returned", "task-1", "t1", { toBotId: "mate", toBotName: "Mate", ok: true, messageId: "line-1" }],
      ["returned", "task-2", "t1", { toBotId: "mate", toBotName: "Mate", ok: false, messageId: "line-2" }],
      ["consume", "task-3"],
    ]);
  });

  // ── what is kept, and what a restart makes of it (design sections 2 and 4) ──

  // Astra r1 item 2: owed wakes survive a restart, through the asker's own task record.
  it("persists every change to a thread's owed wakes and restores them after a restart", () => {
    const { saved, persist } = kept();
    const before = new AskerWakes(persist);
    const ceiling = { permissionMode: "ask" as const, triggerSource: "manual" as const };
    before.register("asked", { ...intent(), routineAuthority: ceiling, eventId: "evt-1" });
    before.register("answered", intent());
    before.deliver("answered", { ...reply, messageId: "m1" });
    expect(saved.get("t1")?.intents.map((i) => i.taskId)).toEqual(["asked"]);
    const after = new AskerWakes(persist);
    for (const [threadId, snapshot] of saved) after.restore(threadId, snapshot, new Set());
    expect(after.threads()).toEqual(["t1"]);
    expect(after.claim("t1")!.results.map((r) => [r.taskId, r.messageId])).toEqual([["answered", "m1"]]);
    expect(after.deliver("asked", reply)).toBe(true);
    const restored = after.claim("t1")!;
    expect(restored.intent.routineAuthority).toEqual(ceiling);
    expect(restored.intent.eventId).toBe("evt-1");
    after.drop("t1");
    expect(saved.has("t1")).toBe(false);
  });
  // Astra r2 Medium: the kept record used to lose a wake that was taken but not yet admitted (a second return's flush),
  // and to be cleared when startTurn resolved, before the engine accepted. A claimed or started wake stays kept until done.
  it("keeps a claimed and a started wake on disk until the engine accepts it", () => {
    const { persist, wakes: onDisk } = kept();
    const wakes = new AskerWakes(persist);
    wakes.register("a", intent()); wakes.deliver("a", { ...reply, messageId: "m1" });
    const record = wakes.claim("t1")!;
    expect(onDisk().map((w) => [w.id, w.state])).toEqual([[record.id, "claimed"]]);
    // a second return while the first is mid-start: both are on disk, as two records
    wakes.register("b", intent()); wakes.deliver("b", { ...reply, messageId: "m2" });
    expect(onDisk().map((w) => w.state)).toEqual(["claimed", "owed"]);
    wakes.hold(record.id);
    expect(onDisk().map((w) => [w.state, w.held])).toEqual([["claimed", true], ["owed", undefined]]);
    wakes.start(record.id);
    expect(onDisk().map((w) => [w.state, w.held])).toEqual([["started", true], ["owed", undefined]]);
    wakes.done(record.id);
    expect(onDisk().map((w) => [w.state, w.results[0]?.taskId])).toEqual([["owed", "b"]]);
  });
  // design r1 High 1: the fence is written before the prompt goes out, the delivery accounting after the engine accepts. A record
  // found started at boot may have reached the engine, so it is never run again by itself (as a submitted hand-off is not); one found
  // claimed died before the prompt went out and is owed again, once.
  it("restores a claimed wake as owed once with the attempt counted, and never runs a started one again", () => {
    const { saved, persist, wakes: onDisk } = kept();
    const before = new AskerWakes(persist);
    before.register("a", intent()); before.deliver("a", { ...reply, messageId: "m1" });
    before.register("b", { ...intent(), depth: 1, coordination: { rootId: "r2", path: ["boss", "lead"] } }); before.deliver("b", { ...reply, messageId: "m2" });
    before.register("c", { ...intent(), routineRun: true }); before.deliver("c", { ...reply, messageId: "m3" });
    const claimed = before.claim("t1")!;
    const started = before.claim("t1")!;
    before.start(started.id);
    const startedHeld = before.claim("t1")!;
    before.hold(startedHeld.id); before.start(startedHeld.id);
    expect(onDisk().map((w) => w.state)).toEqual(["claimed", "started", "started"]);
    const after = new AskerWakes(persist);
    for (const [threadId, snapshot] of saved) after.restore(threadId, snapshot, new Set([heldWakeId(startedHeld.id)]));
    expect(onDisk().map((w) => [w.id, w.state, w.attempts])).toEqual([[claimed.id, "owed", 1]]);
    expect(after.claim("t1")!.id).toBe(claimed.id);
    expect(after.claim("t1")).toBeUndefined();
    expect(after.startable(started.id)).toBe(false);
    expect(after.startable(startedHeld.id)).toBe(false);
  });
  // Astra r2 Q3 Medium: a crash after the held copy was saved and before the owed record was cleared used to leave both, and the
  // asker was woken twice. The held item is now the one carrier of a claimed record: present, the record stays with it; gone, so is the record.
  it("restores a held wake to its held item alone, and drops one whose held item is gone", () => {
    const { saved, persist, wakes: onDisk } = kept();
    const before = new AskerWakes(persist);
    before.register("a", intent()); before.deliver("a", { ...reply, messageId: "m1" });
    before.register("b", { ...intent(), routineRun: true }); before.deliver("b", { ...reply, messageId: "m2" });
    const carried = before.claim("t1")!; before.check(carried.id, stillOwed); before.hold(carried.id);
    const lost = before.claim("t1")!; before.check(lost.id, stillOwed); before.hold(lost.id);
    const after = new AskerWakes(persist);
    for (const [threadId, snapshot] of saved) after.restore(threadId, snapshot, new Set([heldWakeId(carried.id), "some-card"]));
    expect(onDisk().map((w) => [w.id, w.state, w.held])).toEqual([[carried.id, "claimed", true]]);
    // not owed: the sweeps never claim it a second time; the held item's replay starts it
    expect(after.has("t1")).toBe(false);
    expect(after.claim("t1")).toBeUndefined();
    expect(after.check(carried.id, stillOwed)).toBe(true);
    after.start(carried.id);
    after.done(carried.id);
    expect(saved.has("t1")).toBe(false);
  });
  // Astra r2 Q2 Medium: a depth-0 intent without a trace reached beginInternalTurn, which mints a fresh root allowance.
  // The asking turn always had one (coordinationBudget.begin), so a record without it is not the asking turn's and is refused.
  it("restores no depth-0 intent or wake without the asking turn's hand-off allowance", () => {
    const { saved, persist } = kept();
    const before = new AskerWakes(persist);
    before.register("asked", intent());
    before.register("answered", intent());
    before.deliver("answered", { ...reply, messageId: "m1" });
    const snapshot = JSON.parse(JSON.stringify(saved.get("t1"))) as AskerWakeSnapshot;
    delete snapshot.intents[0].intent.coordination;
    delete snapshot.wakes[0].intent.coordination;
    const after = new AskerWakes(persist);
    after.restore("t1", snapshot, new Set());
    expect(after.deliver("asked", reply)).toBe(false);
    expect(after.threads()).toEqual([]);
    // a deeper intent without a trace is a wake that cannot hand off at all: kept
    const deeper = new AskerWakes(persist);
    deeper.restore("t2", { intents: [], wakes: [{ ...snapshot.wakes[0], intent: { ...snapshot.wakes[0].intent, threadId: "t2", depth: 1 } }] }, new Set());
    expect(deeper.claim("t2")!.intent.coordination).toBeUndefined();
  });
  it("restores nothing from a malformed record, and nothing that widens a wake", () => {
    const wakes = new AskerWakes();
    wakes.restore("t1", { intents: [{ taskId: "x", intent: { ...intent(), routineAuthority: { permissionMode: "root", triggerSource: "manual" } } }] } as never, new Set());
    wakes.restore("t1", { intents: [{ taskId: "y", intent: { ...intent(), threadId: "elsewhere" } }] } as never, new Set());
    wakes.restore("t1", { intents: "nope" } as never, new Set());
    wakes.restore("t1", null as never, new Set());
    wakes.restore("t1", { intents: [], wakes: [{ id: "w", state: "running", intent: intent(), results: [{ taskId: "a", ...reply }], attempts: 0 }] } as never, new Set());
    wakes.restore("t1", { intents: [], wakes: [{ id: "w", state: "owed", intent: intent(), results: [], attempts: 0 }] } as never, new Set());
    // a counter that does not read back exactly is not repaired into fresh attempts, and a reply list is not trimmed to fit
    wakes.restore("t1", { intents: [], wakes: [{ id: "w", state: "owed", intent: intent(), results: [{ taskId: "a", ...reply }], attempts: -1 }] } as never, new Set());
    wakes.restore("t1", { intents: [], wakes: [{ id: "w", state: "owed", intent: intent(), results: [{ taskId: "a", ...reply }], attempts: "0" }] } as never, new Set());
    wakes.restore("t1", { intents: [], wakes: [{ id: "w", state: "owed", intent: intent(), results: Array.from({ length: MAX_ASKER_RESULTS + 1 }, (_, i) => ({ taskId: `a${i}`, ...reply })), attempts: 0 }] } as never, new Set());
    wakes.restore("t1", { intents: [], wakes: [{ id: "w", state: "owed", intent: intent(), results: [{ taskId: "a", ...reply }, "junk"], attempts: 0 }] } as never, new Set());
    // the round-2 shape (owed results under one list) never shipped and restores as nothing
    wakes.restore("t1", { intents: [], owed: { results: [{ taskId: "a", ...reply, intent: intent() }], attempts: 0 } } as never, new Set());
    expect(wakes.deliver("x", reply)).toBe(false);
    expect(wakes.deliver("y", reply)).toBe(false);
    expect(wakes.threads()).toEqual([]);
  });
});
