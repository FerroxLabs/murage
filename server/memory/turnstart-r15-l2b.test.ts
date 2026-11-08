// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r15 L2b red-before tests for two warmer bugs T12 exposed once its seeds ran all 400 ops (TURNSTART lead + MurageMain
// 11-07: each fix carries its own focused test, red on e7b0a962d).
//   (i)  REDO CONSUMED: a pinned key's eviction queues a redo (VS:242). Nothing took it, so the record read "pending: redo" after every clean
//        confirm and the warmer re-confirmed it every step (T12 hit its 45 s timeout). The confirm subsumes the redo and takes it.
//   (ii) CONFIRM_TRIES IN A ROW: RECOVERING after CONFIRM_TRIES consecutive unclean confirms. Counting every confirm since the send made a
//        record that re-confirmed clean after other turns' dispatches RECOVERING on its next unclean one (T12: the owner never matched).
import { describe, expect, it } from "vitest";
import { HOT_DEADLINE, lineageThreadState, r14Surface } from "./testing/turnstart-r14-surface.ts";
import * as LW from "./lineage-warm.ts";
import { verdictStore as store, type Trace, type Verdict } from "./verdict-store.ts";
import { forgetRootSetHandles } from "./root-set-handles.ts";

describe("L2b (i) redo consumed", () => {
  it("a queued redo is taken by the confirm that subsumes it: the record re-warms and the warmer settles", () => {
    const s = r14Surface();
    try {
      const [t] = s.fixture("plain");
      s.send(t!); s.dispatch(t!); s.advance(HOT_DEADLINE);
      expect(lineageThreadState(t!), "precondition: warm").toBe("warm");
      const key = LW.lineageTraceKeysForTest(t!).find(k => store.peekVerdict(k) !== undefined);
      expect(key, "precondition: a kept trace key").toBeDefined();
      store.loseVerdict(key!, "evict");
      expect(store.redoOf(t!).length + (store.redoOverflow(t!) ? 1 : 0), "precondition: the pinned key's eviction queued a redo").toBeGreaterThan(0);
      const before = LW.lineageWarmCounters().confirms;
      s.advance(HOT_DEADLINE);
      expect(lineageThreadState(t!), JSON.stringify(s.record(t!))).toBe("warm");
      expect(store.redoOf(t!)).toEqual([]);
      expect(LW.lineageWarmCounters().confirms - before, "the warmer settles: a few confirms, not one per scheduled step").toBeLessThanOrEqual(4);
    } finally { s.setLimits(null); }
  });
});

describe("L2b (ii) CONFIRM_TRIES counts consecutive unclean confirms", () => {
  it("clean re-confirms after other turns' dispatches are no tries: the record stays warm, never RECOVERING", () => {
    const s = r14Surface();
    try {
      const [a] = s.fixture("plain");
      const [b] = s.fixture("plain");
      s.send(a!); s.dispatch(a!); s.advance(HOT_DEADLINE);
      expect(lineageThreadState(a!), "precondition: warm").toBe("warm");
      for (let round = 0; round < 4; round++) {
        const r0 = s.record(a!)!.confirmRounds;
        // another thread's turn: its cold legacy answer forgets what is kept, so a's next confirm is unclean (work), then clean
        s.send(b!); s.dispatch(b!); s.advance(HOT_DEADLINE);
        const rec = s.record(a!)!;
        expect(rec.outcome, `round ${round}: ${JSON.stringify(rec)}`).toBeNull();
        expect(rec.confirmRounds, `round ${round}: precondition, an unclean then a clean confirm of a ${JSON.stringify(rec)}`).toBeGreaterThanOrEqual(r0 + 2);
        expect(lineageThreadState(a!), `round ${round}: ${JSON.stringify(rec)}`).toBe("warm");
      }
    } finally { s.setLimits(null); }
  });
});

// L2c (11-07, TURNSTART r15.1 mutants): one direct test per guard the integration tests do not reach on their own. Each is red under its
// mutant (/root/ts14-l4/mutants.tsv) and green without it. The store tests drive the process's one VerdictStore and reset it before and after.
describe("L2c guards, direct", () => {
  const trace = (thread: string, verdicts: string[]): Trace => ({ thread, keys: { verdicts: new Set(verdicts), sessionSound: new Set(), threadGroupStore: new Set(), sessionHolds: new Set() }, usedMemos: false, usedHandles: false, holdRead: false, ownLosses: 0 });
  const verdict = (deps: Iterable<string> = []): Verdict => ({ withheld: false, unproven: false, deps: new Set(deps) });
  it("hold-evict-uncounted: a hold evicted for room is a counted loss of its owner (lossOf moves; the loss rule logs it as evict)", () => {
    store.resetForTest();
    const log: Array<{ map: string; key: string; why: string }> = [];
    try {
      store.watch("A");
      store.onStoreLog(entry => { log.push({ map: entry.map, key: entry.key, why: entry.why }); });
      const held = JSON.stringify(["A", "session-a"]);
      store.setHold(held, { hold: "a" }, 1);
      expect(store.lossOf("A")).toBe(0);
      store.setHold(JSON.stringify(["B", "session-b"]), { hold: "b" }, 1);
      expect(store.holdCount(), "precondition: A's hold was the one evicted").toBe(1);
      expect(store.lossOf("A"), "the eviction is a loss of A").toBe(1);
      expect(log).toContainEqual({ map: "sessionHolds", key: held, why: "evict" });
    } finally { store.onStoreLog(null); store.resetForTest(); }
  });
  it("redo-on-unpinned-eviction: an unpinned key's eviction counts a loss and queues no redo; a pinned key's queues its own", () => {
    store.resetForTest();
    try {
      store.watch("A");
      const loose = JSON.stringify(["A", "m-loose"]), kept = JSON.stringify(["A", "m-kept"]);
      store.setVerdict(loose, verdict()); store.setVerdict(kept, verdict());
      expect(store.pin("A", trace("A", [kept]))).toBe(true);
      store.loseVerdict(loose, "evict");
      expect(store.lossOf("A"), "the unpinned eviction is still a counted loss").toBe(1);
      expect(store.redoOf("A"), "an unpinned key queues no redo (Fable r13 H1)").toEqual([]);
      store.loseVerdict(kept, "evict");
      expect(store.redoOf("A")).toEqual([{ kind: "m", message: "m-kept" }]);
    } finally { store.resetForTest(); }
  });
  it("no-c-edges: admission refuses a trace whose retained closure would carry the pinned edges past WARM_EDGES (4 x verdictLimit), pinning nothing", () => {
    const limit = store.verdictLimit();
    store.resetForTest();
    try {
      store.setVerdictLimit(16); // WARM_EDGES = 64
      const deps = (n: number, tag: string) => Array.from({ length: n }, (_, index) => `x:${tag}:${index}`);
      const over = JSON.stringify(["B", "m-over"]), at = JSON.stringify(["C", "m-at"]), one = JSON.stringify(["D", "m-one"]);
      store.setVerdict(over, verdict(deps(65, "b"))); store.setVerdict(at, verdict(deps(64, "c"))); store.setVerdict(one, verdict(deps(1, "d")));
      expect(store.closureEdges(trace("B", [over]), 64), "precondition: B's closure is 65 edges").toBe(65);
      expect(store.admit("B", trace("B", [over]))).toBe("edges");
      expect(store.pinnedCount("verdicts")).toBe(0);
      expect(store.edgesPinnedForTest("B")).toBeUndefined();
      expect(store.admit("C", trace("C", [at])), "at the bound exactly: admitted").toBe("ok");
      expect(store.edgesPinnedForTest("C")).toBe(64);
      expect(store.admit("D", trace("D", [one])), "64 pinned + 1 more is over").toBe("edges");
      expect(store.pinnedCount("verdicts")).toBe(1);
    } finally { store.setVerdictLimit(limit); store.resetForTest(); }
  });
  it("handle-epoch-skip: forgetting the stored root-set handles moves handleEpoch (RH:142 -> the onHandlesForgotten hook, RL:47)", () => {
    const before = store.handleEpoch();
    forgetRootSetHandles(new Map());
    expect(store.handleEpoch(), "a handle forget is a handleEpoch move (W1 compares it for a usedHandles trace)").toBeGreaterThan(before);
  });
  it("gen-clears-oversize: a gen move keeps an OVERSIZE record's outcome and counters (send-only reset): the warmer does not re-confirm it", () => {
    const s = r14Surface();
    try {
      const [t] = s.fixture("plain", { lines: 40 });
      s.send(t!); s.dispatch(t!); s.advance(HOT_DEADLINE);
      expect(lineageThreadState(t!), "precondition: a clean confirm wrote the record's stamps").toBe("warm");
      s.setLimits({ verdictLimit: 64 });
      s.send(t!); s.dispatch(t!); s.advance(HOT_DEADLINE);
      const rec = s.record(t!)!;
      expect(rec.outcome, JSON.stringify(rec)).toBe("OVERSIZE");
      const rounds = rec.confirmRounds, confirms = LW.lineageWarmCounters().confirms;
      store.resetSessionHolds(); // a whole-store gen move
      LW.lineageWarmStep(50); s.advance(HOT_DEADLINE);
      expect(s.record(t!)!.outcome).toBe("OVERSIZE");
      expect(s.record(t!)!.confirmRounds).toBe(rounds);
      expect(LW.lineageWarmCounters().confirms - confirms, "no re-confirm of an OVERSIZE record until the next send").toBe(0);
    } finally { s.setLimits(null); }
  });
});

describe("L2c guards, bounded", () => {
  // T10(o) runs advance(600_000): under no-confirm-tries the warmer never stops and that advance does not end in 15 min (NO-RUN). The same
  // guard here, in a bounded number of warm steps.
  it("no-confirm-tries: CONFIRM_TRIES unclean confirms in a row make the record RECOVERING (bounded warm steps)", () => {
    const s = r14Surface();
    try {
      const [t] = s.fixture("endless-unclean"); s.setLimits({ judgeBudget: 1 });
      s.send(t!); s.dispatch(t!);
      for (let step = 0; step < 24 && s.record(t!)!.outcome !== "RECOVERING"; step++) LW.lineageWarmStep(50);
      const rec = s.record(t!)!;
      expect(rec.outcome, JSON.stringify(rec)).toBe("RECOVERING");
      expect(rec.confirmRounds).toBe(LW.CONFIRM_TRIES);
    } finally { s.setLimits(null); }
  });
});
