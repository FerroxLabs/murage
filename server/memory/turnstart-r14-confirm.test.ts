// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 sec. 6 (+ r14.1 X6, r15, r15.1): T10(o), (o2), (q), (r); T14(a), (c); T15(a)-(f). The confirm (C5'), its outcomes, the
// capacity rule and the footprint, read through the ONE shared surface (testing/turnstart-r14-surface.ts). r15: a turn is send() (append, no
// warm step) then dispatch() (the IX:13283 compare, record, E2 -> recall -> E1, the bot reply); the warmer runs only in advance().
// RB: on b13e r14Surface() throws (no lineageWarmTestSurface): every case red for that reason.
import { describe, expect, it } from "vitest";
import { ADMIT_MAX } from "./lineage-warm.ts";
import { GROUP_PIN_MAX, verdictStore, type Trace } from "./verdict-store.ts";
import { HIT_ONLY, HOT_DEADLINE as HOT, RECALL_RESERVE, hitOnly, lineageThreadState as state, r14Surface as need, type R14Surface } from "./testing/turnstart-r14-surface.ts";

/** One whole plain turn. */
const turn = (s: R14Surface, t: string, over?: Parameters<R14Surface["dispatch"]>[1]) => { s.send(t); return s.dispatch(t, over); };

describe("T10 confirm outcomes", () => {
  it("T10(o) a confirm unclean every round: exactly CONFIRM_TRIES (3) rounds, then RECOVERING, at most 16 slices, then zero judge statements", () => {
    const s = need();
    try {
      const [t] = s.fixture("endless-unclean"); s.setLimits({ judgeBudget: 1 });
      turn(s, t!); s.advance(600_000);
      const rec = s.record(t!)!;
      expect(rec.confirmRounds).toBe(3);
      expect(rec.outcome).toBe("RECOVERING");
      expect(rec.recoverSlices).toBeLessThanOrEqual(16);
      expect(state(t!)).toMatch(/^checking/);
      const before = s.counters().judgeStatements; s.advance(600_000);
      expect(s.counters().judgeStatements - before, "no work past slice 16 until the next send").toBe(0);
    } finally { s.setLimits(null); }
  });
  it("T10(o2) C-SIZE: a CLEAN confirm whose trace exceeds WARM_SET_MAX is OVERSIZE, decided by the trace count", () => {
    const s = need();
    try {
      s.setLimits({ verdictLimit: 64 }); const [t] = s.fixture("plain", { lines: 40 });
      turn(s, t!); s.advance(HOT);
      const rec = s.record(t!)!;
      expect(rec.lastConfirm!.clean).toBe(true); expect(rec.traceSize).toBeGreaterThan(64 / 8);
      expect(rec.outcome).toBe("OVERSIZE");
    } finally { s.setLimits(null); }
  });
  it("T10(q) a confirm that writes (one lost [t,m] key in the window) is unclean; warm only after a clean one; a clean confirm merges nothing", () => {
    const s = need();
    const [t] = s.fixture("lost-window-key");
    turn(s, t!); s.advance(HOT);
    const rec = s.record(t!)!;
    expect(rec.confirmRounds).toBeGreaterThanOrEqual(2); // the round that remembered the lost key was unclean
    expect(state(t!)).toBe("warm");
    expect(rec.lastConfirm).toMatchObject({ clean: true, remember: 0, merges: 0, holdWrites: 0, handleMisses: 0 });
  });
  it("T10(r) C-EDGES: a window over WARM_EDGES is refused in the confirm pass with no edge-pressure drop or clear (no half drop, no clear, no pinned or proof key lost; capacity eviction of unpinned non-proof keys may run); with C-EDGES off, warmer-caused clears stop within 19 rounds per send, then zero statements", () => {
    const s = need();
    try {
      s.setLimits({ verdictLimit: 64 }); const [t] = s.fixture("edges-over", { deps: 600 });
      // an admitted companion on another thread (Astra 5ab6f57bd M): its pins are what the refusing pass must not take
      const [companion] = s.fixture("plain"); turn(s, companion!); s.advance(HOT);
      expect(state(companion!), "the companion is warm (admitted, pinned)").toBe("warm");
      turn(s, t!);
      // t's own turn walk (not a confirm pass) clears the store and with it the companion's pins (measured); the companion is sent again
      // AFTER t, so in the next step its confirm runs first (most recently sent first: LW dueRecords) and re-pins it before t's pass refuses.
      // Its turn walk clears too (t's edges are still over the bound; measured 2), so the no-clear baseline is taken after it, right before
      // the advance that holds the refusing pass.
      // MUTANT:t10r-no-companion-resend
      turn(s, companion!); const clearsAtSend = s.counters().storeClears;
      // (Astra 5ee42af84 M) step one scheduled step at a time until t's refusing pass has run: the companion's pins must already be held when
      // that step starts (admission came first), and that step must lose none of them
      const pinnedNow = () => new Set([...verdictStore.verdictKeys()].filter(key => verdictStore.pinned(key)));
      let pinnedBeforeRefusal = pinnedNow(); s.storeLog(true);
      for (let guard = 0; s.record(t!)?.outcome == null; guard++) {
        expect(guard, "t's refusing pass ran within 200 scheduled steps").toBeLessThan(200);
        pinnedBeforeRefusal = pinnedNow(); s.storeLog(true);
        if (!s.stepOnce()) break;
      }
      expect(s.record(t!)?.outcome, "t's pass refused (OVERSIZE) in the stepped phase").toBe("OVERSIZE");
      expect(pinnedBeforeRefusal.size, `the companion's pins when t's refusing step starts: ${pinnedBeforeRefusal.size}`).toBeGreaterThan(0);
      const refusingLog = s.storeLog();
      expect(refusingLog.filter(entry => entry.key !== undefined && pinnedBeforeRefusal.has(entry.key)), "the refusing step lost none of the pins held before it (by name)").toEqual([]);
      // (Fable seat 10, 912a1ac78 M) the refusing step itself, not only the hold after it, loses no pinned or proof key and no half drop or clear
      expect(refusingLog.filter(entry => entry.why === "half-drop" || entry.map === "gen"), "the refusing step: no half drop and no clear").toEqual([]);
      expect(refusingLog.filter(entry => entry.map === "verdicts" && /^[SQ]\u001f/.test(entry.key ?? "")), "the refusing step: no proof key (S, Q) lost").toEqual([]);
      s.storeLog(true);
      // MUTANT:t10r-pinned-lost
      s.advance(HOT);
      // the refusing pass's removals (main 11-07, Astra 4023216b1 M2): none by edge pressure, none of a pinned or a proof key
      const removed = s.storeLog();
      const pinnedAfter = new Set([...verdictStore.verdictKeys()].filter(key => verdictStore.pinned(key)));
      expect(pinnedAfter.size, `the companion's pinned keys over the refusing pass: ${pinnedAfter.size}`).toBeGreaterThan(0);
      expect(state(companion!), "the companion is still warm (admitted) after the refusing pass").toBe("warm");
      expect(removed.filter(entry => entry.key !== undefined && pinnedAfter.has(entry.key)), "no key pinned over the pass was lost in it (by name)").toEqual([]);
      expect(removed.filter(entry => entry.why === "half-drop" || entry.map === "gen"), "no half drop and no clear in the refusing pass").toEqual([]);
      expect(removed.filter(entry => entry.key !== undefined && verdictStore.pinned(entry.key)), "no pinned key lost").toEqual([]);
      expect(removed.filter(entry => entry.map === "verdicts" && /^[SQ]\u001f/.test(entry.key ?? "")), "no proof key (S, Q: RL isProofKey) lost").toEqual([]);
      expect(s.record(t!)!.outcome).toBe("OVERSIZE"); expect(s.record(t!)!.reason).toBe("edges"); expect(s.counters().warmerCausedClears).toBe(0);
      expect(s.counters().storeClears - clearsAtSend, "refused with no clear: the warmer cleared nothing for it").toBe(0);
      expect(s.counters().confirmPassClears, "no confirm pass ever clears").toBe(0);
      s.setLimits({ verdictLimit: 64, cEdges: false }); turn(s, t!);
      // measured from the send: the turn's own walk clears the store (not the warmer's doing); forcedClears reads a 32-entry log that the
      // turn's clears fill, so the warmer's share is the delta of the store's clear count from here (L2c)
      const clearsAtSend2 = s.counters().storeClears, warmerAtSend2 = s.counters().warmerCausedClears, confirmAtSend2 = s.counters().confirmPassClears;
      s.advance(60_000);
      const rec = s.record(t!)!;
      expect(rec.confirmRounds + rec.recoverSlices, "r14.1 X4: CONFIRM_TRIES + RECOVER_SLICES_MAX").toBeLessThanOrEqual(19);
      expect(state(t!)).toMatch(/^checking/);
      const before = s.counters().judgeStatements; s.advance(600_000);
      expect(s.counters().judgeStatements - before).toBe(0);
      expect(s.counters().confirmPassClears - confirmAtSend2, "the refusing confirm passes cleared nothing (no edge-pressure clear)").toBe(0);
      expect(s.counters().warmerCausedClears - warmerAtSend2, "every clear after the send is warmer-caused").toBe(s.counters().storeClears - clearsAtSend2);
    } finally { s.setLimits(null); }
  });
});

describe("T14 capacity", () => {
  it("T14(a) two admitted traces under eviction pressure from each other's hot slices: pinned keys survive, the warm thread's next plain send is covered and hit-only", () => {
    const s = need();
    const [a, b] = s.fixture("two-alternating");
    for (let round = 0; round < 10; round++) {
      for (const t of [a!, b!]) {
        turn(s, t); s.advance(HOT);
        const other = t === a ? b! : a!;
        if (state(other) === "warm") {
          const d = turn(s, other, { recallNodes: RECALL_RESERVE });
          expect(d.verdict).toBe("match"); expect(hitOnly(d.counts)).toEqual(HIT_ONLY);
          s.advance(HOT);
        }
      }
    }
    expect(s.counters().pinnedEvictions).toBe(0);
  });
  it("T14(c) seven-foreign: 7 records each naming its own thread and 8 foreign threads of its own (63 threads), every root set kept: here an admitted trace pins at most its own thread's groups (a fact of this fixture), group pins <= admitted <= ADMIT_MAX; no pinned group is FIFO-deleted", () => {
    // Bounded, not dominated: C-GROUP is load-bearing. The own-thread assert below is a fact of THIS fixture (its foreign roots sit in kept
    // root sets, so a clean confirm hits them and reads only its own window's groups), not a bound: a clean confirm CAN name foreign groups (an
    // unkept root set re-judges its foreign roots: merge-foreign, Astra/Fable 4023216b1). The C-GROUP trip at full scale is the next test, the
    // bound itself the direct test after it.
    expect(ADMIT_MAX).toBeLessThan(GROUP_PIN_MAX);
    const s = need();
    const threads = s.fixture("seven-foreign");
    for (const t of threads) { turn(s, t); s.advance(HOT); }
    const admitted = threads.filter(t => s.record(t)?.admitted);
    expect(admitted.length).toBeGreaterThan(0);
    for (const t of admitted) { const groups = s.traceGroups(t); expect(groups.length, t).toBeLessThanOrEqual(1); for (const g of groups) expect(g, t).toBe(t); }
    expect(s.pinnedGroups()).toBeLessThanOrEqual(admitted.length);
    expect(admitted.length).toBeLessThanOrEqual(ADMIT_MAX);
    expect(s.counters().pinnedGroupDeletes).toBe(0);
  });
  it("T14(c) C-GROUP tripped at full scale: 7 records, each an unkept root set (basis over 4000) re-judging 8 foreign threads' KEPT groups (56 distinct entries named, GROUP_PIN_MAX 48): 6 x 8 = 48 fits, C-GROUP answers \"group\" at the 7th (56 > 48), fewer than 7 admitted, pins <= GROUP_PIN_MAX, the over-cap record reads not kept, no pinned group FIFO-deleted", () => {
    const s = need();
    const threads = s.fixture("seven-foreign-unkept");
    expect(threads.length).toBe(7);
    const named = new Set<string>();
    for (const [index, t] of threads.entries()) {
      turn(s, t); s.advance(HOT);
      // every confirm is clean (the unkept set counts no term): its trace names exactly its 8 foreign threads' groups. Its own thread does
      // hold a receipt group, but its own lines take the PAIRS branch (pairs <= pairCap, RL producers ~856-861: listed, no group read)
      // while each foreign thread x takes the groups branch, so it names none of its own (measured)
      expect(s.record(t)!.lastConfirm?.clean, `${t}: ${JSON.stringify(s.record(t))}`).toBe(true);
      const groups = new Set(s.traceGroups(t));
      expect(groups.size, `${t}: 8 foreign group entries ${JSON.stringify([...groups])}`).toBe(8);
      expect(groups.has(t), `${t}: no group entry of its own`).toBe(false);
      for (const group of groups) expect(named.has(group), `${group}: each record's foreign threads are its own`).toBe(false);
      for (const group of groups) named.add(group);
      if (index < 6) expect(threads.some(other => s.record(other)?.reason === "group"), "6 x 8 = 48 fits: no group refusal before the 7th").toBe(false);
      else expect(threads.some(other => s.record(other)?.reason === "group"), "C-GROUP answered at the 7th record (7 x 8 = 56 > 48)").toBe(true);
      expect(s.pinnedGroups(), "pins never pass GROUP_PIN_MAX").toBeLessThanOrEqual(GROUP_PIN_MAX);
    }
    expect(named.size, "56 distinct group entries named").toBe(56);
    const admitted = threads.filter(t => s.record(t)?.admitted);
    expect(admitted.length, "fewer than 7 admitted").toBeLessThan(7);
    expect(admitted.length, "floor(48 / 8)").toBeLessThanOrEqual(Math.floor(GROUP_PIN_MAX / 8));
    const overCap = threads.filter(t => s.record(t)?.reason === "group");
    expect(overCap.length, "the group bound refused or demoted a record").toBeGreaterThan(0);
    for (const t of overCap) expect(state(t), `${t}: the over-cap record is not kept`).toBe("checking: not kept (group)");
    expect(s.counters().pinnedGroupDeletes).toBe(0);
  }, 300_000);
  it("T14(c) C-GROUP bound, direct: a trace naming GROUP_PIN_MAX + 1 group entries (fresh ones on top of pinned ones) is refused with \"group\" and pins nothing", () => {
    const trace = (thread: string, groups: string[]): Trace => ({ thread, keys: { verdicts: new Set([`v-${thread}`]), sessionSound: new Set(), threadGroupStore: new Set(groups), sessionHolds: new Set() }, usedMemos: false, usedHandles: false, holdRead: false, ownLosses: 0 });
    const pinnedSet = Array.from({ length: 10 }, (_, index) => `g${index}`);
    verdictStore.resetForTest();
    try {
      expect(verdictStore.admit("A", trace("A", pinnedSet))).toBe("ok");
      const before = { groups: verdictStore.pinnedCount("threadGroupStore"), verdicts: verdictStore.pinnedCount("verdicts") };
      expect(before.groups).toBe(10);
      const over = [...pinnedSet, ...Array.from({ length: GROUP_PIN_MAX + 1 - pinnedSet.length }, (_, index) => `f${index}`)];
      expect(over.length).toBe(GROUP_PIN_MAX + 1);
      expect(verdictStore.admit("B", trace("B", over))).toBe("group");
      expect(verdictStore.pinnedCount("threadGroupStore")).toBe(before.groups);
      expect(verdictStore.pinnedCount("verdicts")).toBe(before.verdicts);
      expect(verdictStore.edgesPinnedForTest("B")).toBeUndefined();
      // at the bound exactly (48 distinct): admitted
      expect(verdictStore.admit("C", trace("C", over.slice(0, GROUP_PIN_MAX)))).toBe("ok");
      expect(verdictStore.pinnedCount("threadGroupStore")).toBe(GROUP_PIN_MAX);
    } finally { verdictStore.resetForTest(); }
  });
});

describe("T15 footprint and allowance (r15: through dispatch)", () => {
  const warm = (s: R14Surface, kind: Parameters<R14Surface["fixture"]>[0] = "plain", options?: Record<string, number>) => {
    const [t] = s.fixture(kind, options); turn(s, t!); s.advance(HOT); return t!;
  };
  it("T15(a) same messages, another model's contextWindow: fp differs, lineageFootprintMiss moves, no warm claim used", () => {
    const s = need(); const t = warm(s);
    expect(state(t)).toBe("warm");
    const miss = s.counters().footprintMiss;
    expect(turn(s, t, { over: { maxBytes: 50_000 } }).verdict).toBe("miss:changed");
    expect(s.counters().footprintMiss).toBe(miss + 1);
  });
  it("T15(b) an exclusion added: a miss", () => {
    const s = need(); const t = warm(s);
    expect(turn(s, t, { over: { exclude: ["m1"] } }).verdict).toBe("miss:changed");
  });
  it("T15(c) a refreshed access with the same stamp fields hashes equal; a policyRevision move does not; an APPENDED footprint hashes no message id", () => {
    const s = need(); const [t] = s.fixture("plain");
    const f = s.turnFootprint(t!);
    expect(s.footprintHash(f)).toBe(s.footprintHash({ ...f }));
    expect(s.footprintHash({ ...f, accessStamp: `${f.accessStamp}.moved` })).not.toBe(s.footprintHash(f));
    expect(f.userMessageId).toBeUndefined();
    expect(s.footprintHash({ ...f, userMessageId: "any" })).toBe(s.footprintHash(f));
  });
  it("T15(d) a hit-only confirm of 1501 nodes is OVER-ALLOWANCE -> OVERSIZE; at 1500 it is warm", () => {
    const s = need();
    const over = warm(s, "spend", { confirmNodes: 1501 });
    expect(s.record(over)!.outcome).toBe("OVERSIZE");
    const fits = warm(s, "spend", { confirmNodes: 1500 });
    expect(state(fits)).toBe("warm");
  });
  it("T15(e) recall spends exactly the reserve then E1 on a covered send: not hit; the 30k room fixture never reads warm unless both extremes were clean", () => {
    const s = need(); const t = warm(s, "spend", { confirmNodes: 1500 });
    expect(turn(s, t, { recallNodes: RECALL_RESERVE }).counts.hit).toBe(false);
    // the real 30k room reads warm (measured), so the claim is decisive: warm, both extremes confirmed, every pass clean
    const r = warm(s, "room-30k");
    expect(state(r), "the 30k room reads warm").toBe("warm");
    expect(s.record(r)!.lastConfirm!.passes.length, "both extremes (least and most room) were confirmed").toBeGreaterThanOrEqual(2);
    // MUTANT:t15e-pass-unclean
    expect(s.record(r)!.lastConfirm!.passes.every(p => p.clean), "every pass of the warm 30k room was clean").toBe(true);
  });
  it("T15(f) the confirm runs E2 then E1, in the turn's order, with headSlot 1", () => {
    const s = need(); const t = warm(s, "fresh-session");
    turn(s, t); s.advance(HOT);
    expect(s.record(t)!.lastConfirm!.order.slice(0, 2)).toEqual(["E2", "E1"]);
    expect(s.record(t)!.lastConfirm!.headSlot).toBe(1);
  });
});
