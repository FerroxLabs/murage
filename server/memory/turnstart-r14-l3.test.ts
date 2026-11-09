// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 + r15, builder L3's own units (the turn side): the footprint hash and the turn's one compare (lineage-footprint.ts),
// the extracted widening loop and its confirm-only head slot (turn-replay-inputs.ts), the allowance's reserve charge and readable time
// (lineage-allowance.ts) and EARLIEST WINS in the warm scheduler (worker-controller.ts). The warmer's own record and W3' are L2's
// (lineage-warm.ts) and are driven here only through the registration hook, stood in for.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import type { Message } from "../store.ts";
import { LineageAllowance, RECALL_RESERVE, TURN_LINEAGE_NODES } from "./lineage-allowance.ts";
import * as FP from "./lineage-footprint.ts";
import { setMemoryMode } from "./repository.ts";
import { REPLAY_LINES_START, turnReplayInputs, type ReplayLineIndex } from "./turn-replay-inputs.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });

const F = (over: Partial<FP.LineageFootprint> = {}): FP.LineageFootprint => ({
  botId: "bot", threadId: "chat", accessStamp: "p0.d0", userKind: "APPENDED", userMessageId: "u1", exclude: [], projectCardRun: false,
  routeHasTools: false, externalUpdates: FP.externalUpdatesKey([]), maxBytes: 200_000, cursor: null, ...over,
});

describe("footprint hash (r14 1D, r15 sec. 2)", () => {
  it("an APPENDED turn hashes its kind and no message id; every other kind keeps its id", () => {
    expect(FP.footprintHash(F({ userMessageId: "u1" }))).toBe(FP.footprintHash(F({ userMessageId: "u2" })));
    expect(FP.footprintHash(F({ userMessageId: undefined }))).toBe(FP.footprintHash(F({ userMessageId: "u2" })));
    for (const kind of ["EXPLICIT", "PROJECT", "EDIT", "HELD", "SYNTHETIC"] as const)
      expect(FP.footprintHash(F({ userKind: kind, userMessageId: "u1" })), kind).not.toBe(FP.footprintHash(F({ userKind: kind, userMessageId: "u2" })));
    expect(FP.footprintHash(F({ userKind: "EDIT" }))).not.toBe(FP.footprintHash(F()));
  });
  it("every other field is an input: exclude (not its order), model maxBytes, access stamp, cursor, projection, project card run", () => {
    const base = FP.footprintHash(F());
    expect(FP.footprintHash(F({ exclude: ["b", "a"] }))).toBe(FP.footprintHash(F({ exclude: ["a", "b"] })));
    for (const over of [{ exclude: ["m1"] }, { maxBytes: 50_000 }, { accessStamp: "p1.d0" }, { routeHasTools: true }, { externalUpdates: FP.externalUpdatesKey(["x"]) },
      { projectCardRun: true }, { cursor: { instanceId: "engine", nativeSession: "S", incarnation: 0 } }] as Partial<FP.LineageFootprint>[])
      expect(FP.footprintHash(F(over)), JSON.stringify(over)).not.toBe(base);
    expect(FP.externalUpdatesKey(["b", "a"])).toBe(FP.externalUpdatesKey(["a", "b"]));
  });
});

describe("the turn's one compare (r15 sec. 2 W3'(1), delegated (2)-(6))", () => {
  afterEach(() => { FP.setLineageFootprintRecords(null); FP.resetLineageFootprintCountersForTest(); });
  it("with no warmer registered every compare is a counted miss (not-covered), and the record is a no-op", () => {
    FP.resetLineageFootprintCountersForTest();
    expect(FP.compareLineageFootprint("chat", F(), { id: "u1", seq: 9 }, false)).toBe("not-covered");
    FP.noteLineageFootprint("chat", F());
    expect(FP.lineageFootprintCounters()).toMatchObject({ footprintMatch: 0, footprintMiss: 1, footprintMissByKind: { "not-covered": 1 } });
  });
  it("only a plain send reaches the warmer's W3'; other kinds, a project card run and the floor are misses of their own kind", () => {
    const asked: string[] = [], noted: string[] = [];
    FP.setLineageFootprintRecords({ covered: (t, u, f) => { asked.push(`${t}:${u.id}:${u.seq}`); return f.maxBytes === 200_000 ? "match" : "APPENDED-changed"; },
      note: (_t, f, hash) => { noted.push(hash); expect(hash).toBe(FP.footprintHash(f)); } });
    FP.resetLineageFootprintCountersForTest();
    expect(FP.compareLineageFootprint("chat", F(), { id: "u1", seq: 9 }, false)).toBe("match");
    expect(FP.compareLineageFootprint("chat", F({ maxBytes: 50_000 }), { id: "u1", seq: 9 }, false)).toBe("APPENDED-changed");
    for (const kind of ["EXPLICIT", "PROJECT", "EDIT", "HELD", "SYNTHETIC"] as const) expect(FP.compareLineageFootprint("chat", F({ userKind: kind }), { id: "u1", seq: 9 }, false)).toBe(kind);
    expect(FP.compareLineageFootprint("chat", F({ projectCardRun: true }), { id: "u1", seq: 9 }, false)).toBe("projectCardRun");
    expect(FP.compareLineageFootprint("chat", F(), { id: "u1", seq: 9 }, true)).toBe("floor");
    expect(asked, "W3' asked only for the two plain sends").toEqual(["chat:u1:9", "chat:u1:9"]);
    const c = FP.lineageFootprintCounters();
    expect(c.footprintMatch).toBe(1);
    expect(c.footprintMiss).toBe(8);
    expect(c.footprintMissByKind).toMatchObject({ "APPENDED-changed": 1, EXPLICIT: 1, PROJECT: 1, EDIT: 1, HELD: 1, SYNTHETIC: 1, projectCardRun: 1, floor: 1, "not-covered": 0 });
    FP.noteLineageFootprint("chat", F());
    expect(noted).toHaveLength(1);
    FP.noteWarmAllowanceHit();
    expect(FP.lineageFootprintCounters().warmAllowanceHit).toBe(1);
  });
});

describe("turnReplayInputs: the confirm's head slot (r15 sec. 2)", () => {
  // a thread of `n` settled text lines; the store hands back the newest `limit`, oldest first, and whether older ones exist
  const thread = (n: number, size = 100): Message[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, at: i + 1, role: i % 2 ? "bot" : "user", kind: "text", text: `${i}:`.padEnd(size, "x") }) as Message);
  const inexact = new Set<number>();
  const index = (rows: Message[], reads: number[] = []): ReplayLineIndex => ({
    activeTextLines: (_t, limit) => { reads.push(limit); return { messages: rows.slice(Math.max(0, rows.length - limit)), hasMore: rows.length > limit, exact: !inexact.has(limit) }; },
  });
  const run = (rows: Message[], skip: string[], headSlot: number | undefined, maxBytes: number, reads?: number[]) => turnReplayInputs({
    store: index(rows, reads), threadId: "chat", botId: "bot", routeHasTools: true, externalUpdates: [], floor: null, projectCardRun: false,
    skip: new Set(skip), replayOptions: { maxBytes }, ...(headSlot === undefined ? {} : { headSlot }),
  });
  for (const [n, maxBytes] of [[1000, 20_000], [50, 1_000_000], [1000, 2_000_000], [161, 1_000_000], [400, 15_950]] as const) {
    it(`${n} lines, maxBytes ${maxBytes}: the confirm at h (headSlot 1) reads exactly the next plain send's lines minus U`, () => {
      const h = thread(n), U = { id: "U", at: n + 1, role: "user", kind: "text", text: "now?" } as Message;
      const turnReads: number[] = [], confirmReads: number[] = [];
      const turn = run([...h, U], ["U"], undefined, maxBytes, turnReads);
      const confirm = run(h, [], 1, maxBytes, confirmReads);
      expect(confirm.window).toBe(turn.window);
      expect(confirm.replayMore).toBe(turn.replayMore);
      expect(confirm.activeMessages.map(m => m.id)).toEqual(turn.activeMessages.map(m => m.id).filter(id => id !== "U"));
      expect(confirm.replayableMessages.map(m => m.id)).toEqual(turn.replayableMessages.map(m => m.id));
      expect(confirm.replayedMessages.map(m => m.id)).toEqual(turn.replayedMessages.map(m => m.id));
      expect([...confirm.heldReplayIds]).toEqual([...turn.heldReplayIds]);
      expect(confirmReads).toEqual(turnReads.map(w => w - 1));
      expect(turnReads[0]).toBe(REPLAY_LINES_START);
    });
  }
  it("per-turn work is the window, never the history: a 200,000-line thread reads the same windows as a 2,000-line one", () => {
    const small: number[] = [], large: number[] = [];
    run(thread(2_000), [], undefined, 20_000, small);
    run(thread(200_000), [], undefined, 20_000, large);
    expect(large).toEqual(small);
  });
  it("exact only when every window was read exactly; an index that does not say is not exact", () => {
    expect(run(thread(1000), [], undefined, 20_000).exact).toBe(true);
    inexact.add(160);
    try {
      const result = run(thread(1000), [], undefined, 20_000);
      expect(result.exactWindows).toEqual([true, false, true]);
      expect(result.exact).toBe(false);
    } finally { inexact.clear(); }
    const silent: ReplayLineIndex = { activeTextLines: () => ({ messages: [], hasMore: false }) };
    expect(turnReplayInputs({ store: silent, threadId: "chat", botId: "bot", routeHasTools: true, externalUpdates: [], floor: null, projectCardRun: false,
      skip: new Set(), replayOptions: {} }).exact).toBe(false);
  });
  it("the final skip set is the turn's plus the held rows, and the turn's set is not modified", () => {
    const skip = new Set(["m3"]);
    const result = turnReplayInputs({ store: index(thread(10)), threadId: "chat", botId: "bot", routeHasTools: true, externalUpdates: [], floor: null,
      projectCardRun: true, skip, replayOptions: {} });
    expect(result.replayableMessages, "a project card run replays nothing").toEqual([]);
    expect(result.replayMore).toBe(false);
    expect([...skip]).toEqual(["m3"]);
    expect(result.skip.has("m3")).toBe(true);
  });
});

describe("LineageAllowance: the reserve charge and readable time (r14 1E, r14.1 X2)", () => {
  it("RECALL_RESERVE is half a turn's nodes; spend charges it with no read, and a charge past the room stops as a read would", () => {
    expect(RECALL_RESERVE).toBe(TURN_LINEAGE_NODES / 2);
    const allowance = LineageAllowance.turn();
    allowance.spend(RECALL_RESERVE);
    expect(allowance.spent).toBe(RECALL_RESERVE);
    expect(allowance.room()).toBe(TURN_LINEAGE_NODES - RECALL_RESERVE);
    expect(allowance.hit).toBe(false);
    expect(() => allowance.spend(TURN_LINEAGE_NODES)).toThrow("MEMORY_REPLAY_LIMIT");
    expect(allowance.hit).toBe(true);
  });
  it("warm(nodes, ms) carries a time budget; spentMs reads what the timed reads used", () => {
    const plain = LineageAllowance.warm(100);
    expect(plain.spentMs()).toBe(0);
    const timed = LineageAllowance.warm(100, 0);
    timed.timed(() => { const end = performance.now() + 2; while (performance.now() < end) { /* spin */ } });
    expect(timed.spentMs()).toBeGreaterThan(0);
    expect(timed.overTime()).toBe(true);
    expect(plain.overTime()).toBe(false);
  });
});

describe("EARLIEST WINS (r14, WC)", () => {
  let controller: MemoryWorkerController | undefined;
  afterEach(async () => { await controller?.stop().catch(() => {}); controller = undefined; });
  it("a sooner wake replaces a later pending one; a later wake never postpones a sooner one", async () => {
    let calls = 0;
    controller = new MemoryWorkerController({ onLineageWarm: () => { calls++; return false; } });
    (controller as unknown as { started: boolean }).started = true;
    controller.wakeLineageWarm(60_000);
    controller.wakeLineageWarm(0);
    const end = Date.now() + 2_000;
    while (calls === 0 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls, "the sooner wake ran").toBe(1);
    controller.wakeLineageWarm(0);
    controller.wakeLineageWarm(60_000);
    const end2 = Date.now() + 2_000;
    while (calls === 1 && Date.now() < end2) await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls, "the later wake did not postpone it").toBe(2);
  });
});
