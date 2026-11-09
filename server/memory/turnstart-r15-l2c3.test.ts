// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r15.1 L2c-3 (11-07): one direct test per guard whose mutant (ts14-l4/mutants.tsv) survived the lane at ac20c3d37.
// Each test asserts the guard's OWN effect (the clause, reason, outcome or loss it decides), on a fixture where no other clause can give the
// same answer. Each is red under its mutant and green without it. No guard is changed.
import { afterEach, describe, expect, it } from "vitest";
import { database } from "../database.ts";
import { HOT_DEADLINE, lineageThreadState, r14Surface } from "./testing/turnstart-r14-surface.ts";
import * as LW from "./lineage-warm.ts";
import { verdictStore as store, type Trace, type Verdict } from "./verdict-store.ts";

const settle = (s: ReturnType<typeof r14Surface>) => s.advance(HOT_DEADLINE);
const covered = (s: ReturnType<typeof r14Surface>, t: string) => { s.send(t); s.dispatch(t); settle(s); expect(lineageThreadState(t), "precondition: warm").toBe("warm"); };
afterEach(() => { try { r14Surface().setLimits(null); } catch { /* no surface */ } });

describe("L2c-3 verdict-store guards, direct", () => {
  const trace = (thread: string, verdicts: string[]): Trace => ({ thread, keys: { verdicts: new Set(verdicts), sessionSound: new Set(), threadGroupStore: new Set(), sessionHolds: new Set() }, usedMemos: false, usedHandles: false, holdRead: false, ownLosses: 0 });
  const verdict = (): Verdict => ({ withheld: false, unproven: false, deps: new Set() });
  it("no-pinning: evictVerdicts skips a pinned oldest key; the oldest unpinned one goes instead (S4)", () => {
    store.resetForTest();
    try {
      store.watch("A");
      const keys = Array.from({ length: 16 }, (_, index) => JSON.stringify(["A", `m-${index}`]));
      for (const key of keys) store.setVerdict(key, verdict());
      expect(store.pin("A", trace("A", [keys[0]!]))).toBe(true);
      expect(store.pinned(keys[0]!), "precondition: the oldest key is pinned").toBe(true);
      store.evictVerdicts(8, () => false); // limit / 8 = 1 victim
      expect(store.peekVerdict(keys[0]!), "the pinned oldest key is kept").toBeDefined();
      expect(store.peekVerdict(keys[1]!), "the oldest unpinned key is the victim").toBeUndefined();
      expect(store.verdictCount()).toBe(15);
    } finally { store.resetForTest(); }
  });
});

describe("L2c-3 replay-lineage remember(): the half drop", () => {
  it("half-drop-takes-pinned: past the edge bound outside a confirm, the half drop never takes a pinned key of an admitted record", () => {
    const s = r14Surface();
    try {
      const [a] = s.fixture("plain", { lines: 12 });
      const [b] = s.fixture("plain", { lines: 40 });
      covered(s, a!);
      const pinned = LW.lineageTraceKeysForTest(a!).filter(key => store.pinned(key) && store.peekVerdict(key) !== undefined);
      expect(pinned.length, "precondition: a's admitted trace pins kept verdicts").toBeGreaterThan(0);
      // the unpinned kept verdicts go first (an eviction for room), so the pinned ones are the OLDEST kept: the half drop walks oldest first
      // and, at floor(count / 2), would reach a pinned key before any other
      for (const key of [...store.verdictKeys()]) if (!store.pinned(key)) store.loseVerdict(key, "evict");
      expect([...store.verdictKeys()].every(key => store.pinned(key)), "precondition: only pinned verdicts are kept").toBe(true);
      expect(store.verdictCount(), "precondition: floor(count / 2) >= 1").toBeGreaterThanOrEqual(2);
      s.storeLog(true);
      s.setLimits({ edgeBound: 1 });
      s.send(b!); s.dispatch(b!);
      const log = s.storeLog();
      expect(log.some(entry => entry.map === "gen" && entry.why === "edges"), `precondition: b's turn crossed the edge bound outside a confirm (${JSON.stringify(log.slice(0, 8))})`).toBe(true);
      expect(log.filter(entry => entry.why === "half-drop" && pinned.includes(entry.key ?? "")).map(entry => entry.key), "no pinned key is half-dropped (S4)").toEqual([]);
    } finally { s.setLimits(null); }
  });
});

describe("L2c-3 lineage-warm guards, direct", () => {
  it("no-reserve-charge: the least-room E1 pass runs after the RECALL_RESERVE charge, so it takes a different producers branch than the most-room pass", () => {
    const s = r14Surface();
    try {
      const [t] = s.fixture("room-switch");
      s.send(t!); s.dispatch(t!); settle(s);
      const passes = s.record(t!)!.lastConfirm!.passes;
      expect(passes.map(p => p.room)).toEqual(["least", "most"]);
      const least = passes[0]!.branches, most = passes[1]!.branches;
      expect(Object.keys(least).length, "precondition: room-dependent decisions were recorded").toBeGreaterThan(0);
      expect(Object.keys(least).filter(k => least[k] !== most[k]).length, `least ${JSON.stringify(least)} most ${JSON.stringify(most)}`).toBeGreaterThan(0);
      expect(Object.values(least), "less room (the reserve charged) takes the listing branch").toContain("listing");
    } finally { s.setLimits(null); }
  });
  it("confirm-writes-allowed: a confirm whose ONLY work is a kept verdict (remember > 0, every other C5'(2) counter 0, no hit, in the node bound) is unclean", () => {
    const s = r14Surface();
    try {
      const [t] = s.fixture("room-switch");
      s.send(t!); s.dispatch(t!);
      LW.lineageWarmStep(50);
      const c = s.record(t!)!.lastConfirm!;
      expect(c, "precondition: the first confirm ran").not.toBeNull();
      const others = { misses: c.misses, listings: c.listings, holdWrites: c.holdWrites, handleMisses: c.handleMisses, memoMisses: c.memoMisses, merges: c.merges,
        deferred: c.deferred, unfinished: c.unfinished, ownLosses: (c as unknown as { ownLosses: number }).ownLosses, hit: c.hit };
      expect(c.remember, "precondition: the confirm kept a verdict").toBeGreaterThan(0);
      expect(others, "precondition: remember is the only non-zero term").toEqual({ misses: 0, listings: 0, holdWrites: 0, handleMisses: 0, memoMisses: 0, merges: 0, deferred: 0, unfinished: 0, ownLosses: 0, hit: false });
      expect(c.nodes, "precondition: within CONFIRM_NODES_MAX").toBeLessThanOrEqual(1500);
      expect(c.clean, "a confirm that writes is no proof").toBe(false);
    } finally { s.setLimits(null); }
  });
  it("merges-allowed: a confirm whose ONLY work is a merge into a foreign thread's kept receipt groups (merges > 0, ownLosses 0, every other term 0) is unclean", () => {
    const s = r14Surface();
    try {
      // merge-foreign: t's newest reply rests on a root set too large in basis to keep (RL:1383, noteUnkept only, no counted term), which
      // reads the foreign thread x's KEPT receipt groups every time it is judged. A merge into x's groups is a loss of x, not of t: the
      // confirm of t counts it in merges alone (VS noteGroupMerge; the loss rule's ownLosses moves only for t's own keys).
      const [t, x] = s.fixture("merge-foreign");
      covered(s, t!);
      expect(store.groupCount(), "precondition: x's receipt groups are kept").toBeGreaterThan(0);
      expect(s.traceGroups(t!), "a clean confirm's trace names the FOREIGN thread x's group entry").toContain(x!);
      database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]',?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',9)")
        .run(`l2c3-${x!}`, x!, "engine", `S-${x!}`, JSON.stringify([`${x!}x0`, `${x!}x1`]));
      s.send(t!);
      const confirms = LW.lineageWarmCounters().confirms;
      LW.lineageWarmStep(50);
      expect(LW.lineageWarmCounters().confirms - confirms, "precondition: t confirmed once").toBe(1);
      const c = s.record(t!)!.lastConfirm!;
      const others = { misses: c.misses, listings: c.listings, remember: c.remember, holdWrites: c.holdWrites, handleMisses: c.handleMisses, memoMisses: c.memoMisses,
        deferred: c.deferred, unfinished: c.unfinished, ownLosses: (c as unknown as { ownLosses: number }).ownLosses, hit: c.hit };
      expect(c.merges, "precondition: the confirm merged x's fresh receipt into its kept groups").toBeGreaterThan(0);
      expect(others, "precondition: merges is the only non-zero term").toEqual({ misses: 0, listings: 0, remember: 0, holdWrites: 0, handleMisses: 0, memoMisses: 0, deferred: 0, unfinished: 0, ownLosses: 0, hit: false });
      expect(c.nodes, "precondition: within CONFIRM_NODES_MAX").toBeLessThanOrEqual(1500);
      expect(c.clean, "a confirm that merged is no proof").toBe(false);
    } finally { s.setLimits(null); }
  }, 120_000);
  it("no-recover-bound: a confirm that meets its record RECOVERING-exhausted (recoverSlices = RECOVER_SLICES_MAX) runs no recover slice for it", () => {
    const s = r14Surface();
    try {
      // dueRecords() chooses both records at the start of a step (needsWork, LW:314). b's proof is spent by EVERY proof slice in a step (RL
      // advanceRootSetProofs walks all of `proving`). a is sent again, so a goes first in every later step (most recently sent first): a's
      // slice spends b's last activation, LW onProofActivationsExhausted makes b RECOVERING with recoverSlices = RECOVER_SLICES_MAX, and b's
      // own confirm in that SAME step meets the guard (LW:740). That step must run a's slice only.
      const [a] = s.fixture("proof-restarts");
      const [b] = s.fixture("proof-restarts");
      s.send(a!); s.dispatch(a!); s.send(b!); s.dispatch(b!);
      for (let step = 0; step < 3; step++) LW.lineageWarmStep(50);
      s.send(a!); s.dispatch(a!);
      const trail: string[] = [];
      let at = -1, slicesAt = -1, aSlicesAt = -1, bConfirmedAt = false;
      for (let step = 0; step < 24 && at < 0; step++) {
        const before = { slices: LW.lineageWarmCounters().judgeSlices, a: s.record(a!)!.recoverSlices, b: s.record(b!)!.recoverSlices, bc: s.record(b!)!.lastConfirm };
        LW.lineageWarmStep(50);
        const ra = s.record(a!)!, rb = s.record(b!)!, slices = LW.lineageWarmCounters().judgeSlices - before.slices;
        trail.push(`${step}:${ra.recoverSlices}/${rb.recoverSlices} sl${slices} ${rb.reason ?? "-"}`);
        if (rb.recoverSlices === LW.RECOVER_SLICES_MAX && before.b < LW.RECOVER_SLICES_MAX - 1) {
          at = step; slicesAt = slices; aSlicesAt = ra.recoverSlices - before.a; bConfirmedAt = rb.lastConfirm !== before.bc;
        }
      }
      expect(at, `precondition: b's activations ran out (${trail.join(" ")})`).toBeGreaterThanOrEqual(0);
      expect(bConfirmedAt, `precondition: b's confirm ran in that step (${trail.join(" ")})`).toBe(true);
      expect(aSlicesAt, `precondition: a ran its own recover slice in that step (${trail.join(" ")})`).toBe(1);
      expect(slicesAt, `the step ran a's slice only: b's confirm stopped at the bound (${trail.join(" ")})`).toBe(1);
      expect(s.record(b!)!.recoverSlices).toBe(LW.RECOVER_SLICES_MAX);
    } finally { s.setLimits(null); }
  }, 120_000);
  it("shared-by-misses: a non-owner audience's record is SHARED from F (reason shared) before any pass", () => {
    const s = r14Surface();
    try {
      const [, other] = s.fixture("gate");
      const confirms = LW.lineageWarmCounters().confirms;
      s.send(other!); s.dispatch(other!); settle(s);
      const rec = s.record(other!)!;
      expect(rec.outcome, JSON.stringify(rec)).toBe("SHARED");
      expect(rec.reason).toBe("shared");
      expect(lineageThreadState(other!)).toBe("checking: shared");
      expect(LW.lineageWarmCounters().confirms - confirms, "SHARED is decided before any confirm pass runs").toBe(0);
    } finally { s.setLimits(null); }
  });
  it("c5-skips-w2: inside an open transaction nothing can be applied: a warm record reads exactly \"pending: unapplied\"", () => {
    const s = r14Surface();
    try {
      const [t] = s.fixture("plain");
      covered(s, t!);
      const db = database();
      db.exec("BEGIN");
      let state: string;
      try { expect(db.isTransaction).toBe(true); state = lineageThreadState(t!); }
      finally { db.exec("ROLLBACK"); }
      expect(state).toBe("pending: unapplied");
      expect(lineageThreadState(t!), "after the transaction: warm again").toBe("warm");
    } finally { s.setLimits(null); }
  });
  it("w2-epochs-dropped: an epoch-only change misses on the epochs clause itself (coveredMissByClause.epochs), not on another clause", () => {
    const s = r14Surface();
    try {
      const [t] = s.fixture("plain", { cursorless: 1 }); covered(s, t!);
      s.send(t!);
      const before = LW.lineageWarmCounters().coveredMissByClause;
      const d = s.dispatch(t!, { epochOnlyWrite: true });
      const after = LW.lineageWarmCounters().coveredMissByClause;
      expect(d.verdict).toBe("miss:not-covered");
      expect(after.epochs - before.epochs, JSON.stringify({ before, after })).toBe(1);
      expect(after.dirty - before.dirty).toBe(0);
    } finally { s.setLimits(null); }
  });
  it("anchor-is-seq: U right after the confirmed head but NOT replying to the anchor misses on adjacency (the seq test alone would pass it)", () => {
    const s = r14Surface();
    try {
      const [t] = s.fixture("plain"); covered(s, t!);
      const anchor = s.record(t!)!.anchor;
      expect(anchor, "precondition: the clean confirm wrote an anchor").not.toBeNull();
      const u = s.send(t!);
      const db = database();
      const row = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(t!, u) as { json: string };
      const json = JSON.parse(String(row.json)) as Record<string, unknown>;
      expect(json.parentId, "precondition: send() parents U on the anchor").toBe(anchor!.id);
      // U stays the next row of t after the confirmed head (seqAdjacent holds); only (b), its parent, is not the anchor
      db.prepare("UPDATE messages SET json=? WHERE thread_id=? AND id=?").run(JSON.stringify({ ...json, parentId: `${t!}-not-the-anchor` }), t!, u);
      const before = LW.lineageWarmCounters().coveredMissByClause;
      const d = s.dispatch(t!);
      const after = LW.lineageWarmCounters().coveredMissByClause;
      expect(d.verdict).toBe("miss:not-covered");
      expect(after.adjacency - before.adjacency, JSON.stringify({ before, after })).toBe(1);
    } finally { s.setLimits(null); }
  });
});
