// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r15 (no prediction) + flagfold F2/F6/F8 + r13 T11(b)(c)(g), on the shared surface (testing/turnstart-r14-surface.ts).
// T15(g) usefulness: a plain send after a settled confirm MATCHES and is hit-only (mutant appended-id-hashed: never a match).
// T15(h) the sec. 1 window equality with headSlot 1 (mutant no-head-slot: a judge miss at the boundary).
// T15(g3) the IX:12707 catch-up's notes do not break the match; T15(i) W2': a pending note on a traced key is a miss (mutant w2-any-note: "match").
// Order in every case: send + dispatch (the turn), THEN advance(HOT) (the warmer confirms the new head after the turn), then the next send.
// F2 both room extremes; F6 the proof-activation budget (mutant no-activation-budget); F8 T10(n4) owner-loss counter and T14(c) recency.
// T11(b) per-key removals; T11(c) supersede; T11(g) owner() over the builder table.
// RB: on b13e r14Surface() throws (no lineageWarmTestSurface): every case red for that reason.
import { afterEach, describe, expect, it } from "vitest";
import { HIT_ONLY, HOT_DEADLINE, RECALL_RESERVE, hitOnly, lineageThreadState, r14Surface } from "./testing/turnstart-r14-surface.ts";

const settle = (s: ReturnType<typeof r14Surface>) => s.advance(HOT_DEADLINE);
afterEach(() => { try { r14Surface().setLimits(null); } catch { /* RB: no surface */ } });

describe("T15(g)-(i) r15: the confirm proves the NEXT plain send", () => {
  it("T15(g) usefulness: send + dispatch, settle, send + dispatch: match, hit-only, equal to legacy, no warm step between send and dispatch", () => {
    const s = r14Surface(); const [t] = s.fixture("plain");
    s.send(t!); s.dispatch(t!); settle(s);
    expect(lineageThreadState(t!)).toBe("warm");
    const before = s.counters().footprintMatch;
    s.send(t!);
    const d = s.dispatch(t!, { recallNodes: RECALL_RESERVE });
    expect(d.verdict).toBe("match");
    expect(s.counters().footprintMatch).toBe(before + 1);
    expect(hitOnly(d.counts)).toEqual(HIT_ONLY);
    expect({ revoked: d.counts.revoked, withheld: [...d.counts.withheld].sort() }).toEqual({ revoked: d.legacy.revoked, withheld: [...d.legacy.withheld].sort() });
    expect(s.counters().warmStepsBetweenSendAndDispatch).toBe(0);
    expect(s.record(t!)!.lastConfirm!.headSlot).toBe(1);
  });
  it("T15(g2) a non-APPENDED kind and a changed field are misses of their kind, and claim nothing", () => {
    const s = r14Surface(); const [t] = s.fixture("plain");
    s.send(t!); s.dispatch(t!); settle(s);
    s.send(t!, "EDIT"); expect(s.dispatch(t!, { over: { userKind: "EDIT" } }).verdict).toBe("miss:kind");
    settle(s);
    s.send(t!); expect(s.dispatch(t!, { over: { maxBytes: 50_000 } }).verdict).toBe("miss:changed");
  });
  for (const [kind, label] of [["window-boundary", "count_h = REPLAY_LINES_START exactly"], ["byte-bound", "a byte-bound window of k = W - 1 lines"],
    ["reply-withheld", "U replies to a withheld bot line older than the window"]] as const) {
    it(`T15(h) window equality, ${label}: match and hit-only (the turn judges nothing the confirm did not)`, () => {
      const s = r14Surface(); const [t, target] = s.fixture(kind);
      s.send(t!); s.dispatch(t!); settle(s);
      expect(lineageThreadState(t!)).toBe("warm");
      s.send(t!, "APPENDED", kind === "reply-withheld" ? { replyTo: target! } : undefined);
      const d = s.dispatch(t!, { recallNodes: RECALL_RESERVE });
      expect(d.verdict).toBe("match");
      expect(hitOnly(d.counts), JSON.stringify(d.counts)).toEqual(HIT_ONLY);
      expect([...d.counts.withheld].sort()).toEqual([...d.legacy.withheld].sort());
    });
  }
  it("T15(g3) Fable r15 M1: the worker is behind, so the IX:12707 catch-up captures the previous reply before the compare: still a match (its notes touch no traced key)", () => {
    const s = r14Surface(); const [t] = s.fixture("plain");
    s.send(t!); s.dispatch(t!); settle(s);
    s.send(t!);
    const d = s.dispatch(t!, { workerBehind: true, recallNodes: RECALL_RESERVE });
    expect(d.verdict).toBe("match");
    expect(hitOnly(d.counts)).toEqual(HIT_ONLY);
  });
  it("T15(i) W2': a pending note on a key in the record's trace: miss:not-covered, and the turn checks as today", () => {
    const s = r14Surface(); const [t] = s.fixture("plain");
    s.send(t!); s.dispatch(t!); settle(s);
    s.send(t!);
    const d = s.dispatch(t!, { tracedNote: true });
    expect(d.verdict).toBe("miss:not-covered");
    expect({ revoked: d.counts.revoked, withheld: [...d.counts.withheld].sort() }).toEqual({ revoked: d.legacy.revoked, withheld: [...d.legacy.withheld].sort() });
  });
});

describe("r15.1 Y4 (Astra ts15 tests; work units asserted)", () => {
  const covered = (s: ReturnType<typeof r14Surface>, t: string) => { s.send(t); s.dispatch(t); settle(s); expect(lineageThreadState(t)).toBe("warm"); };
  it("T15(h4) kills no-head-slot: a retained tail line replies to a target only in the correctly widened window; per-window loaded ids, hasMore, stop W, skip/held and asked ids equal", () => {
    // the fixture pins the boundary: the reply target sits exactly one text line past window W - 1 of the confirm, so no-head-slot changes
    // the loaded ids of the stopping window (asserted below), not only a later round
    const s = r14Surface(); const [t] = s.fixture("tail-reply-widened"); covered(s, t!);
    s.send(t!);
    const d = s.dispatch(t!, { recallNodes: RECALL_RESERVE });
    expect(d.verdict).toBe("match");
    expect(d.confirmWindows, "the covering confirm's pass").not.toBeNull();
    expect(d.turnWindows.map(w => ({ ...w, window: undefined }))).toEqual(d.confirmWindows!.map(w => ({ ...w, window: undefined })));
    expect(d.turnWindows.at(-1)!.window, "the stopping window").toBe(d.confirmWindows!.at(-1)!.window);
    expect(hitOnly(d.counts)).toEqual(HIT_ONLY);
  });
  it("T15(j) a real append with capture on: the source-version s row still pending at the compare: match, hit-only (Y1 relaxation)", () => {
    const s = r14Surface(); const [t] = s.fixture("plain"); covered(s, t!);
    s.send(t!);
    const d = s.dispatch(t!, { workerBehind: false });
    expect(d.verdict).toBe("match"); expect(hitOnly(d.counts)).toEqual(HIT_ONLY);
  });
  it("T15(i2) kills w2-epochs-dropped: an epoch-only change (unrelated messages DELETE, no dirty row) before the compare: miss, checked as today", () => {
    const s = r14Surface(); const [t] = s.fixture("plain", { cursorless: 1 }); covered(s, t!);
    s.send(t!);
    const d = s.dispatch(t!, { epochOnlyWrite: true }); // written after the early E2, still unapplied at the compare
    expect(d.verdict).toBe("miss:not-covered");
    expect([...d.counts.withheld].sort()).toEqual([...d.legacy.withheld].sort());
  });
  it("T15(k) kills anchor-is-seq: other threads' log writes between the confirm and the send still match; a second row of t before U misses", () => {
    const s = r14Surface(); const [t] = s.fixture("plain"); covered(s, t!);
    s.send(t!); expect(s.dispatch(t!, { otherThreadWrites: 5 }).verdict).toBe("match");
    settle(s);
    s.send(t!); expect(s.dispatch(t!, { secondRow: true }).verdict).toBe("miss:not-covered");
    expect(s.record(t!)?.anchor ?? null).not.toBeNull();
  });
  it("T15(l) turn N creates the session, N+1 resumes it: match against the live-cursor confirm; a changed resume eligibility misses", () => {
    const s = r14Surface(); const [t] = s.fixture("fresh-session");
    s.send(t!); s.dispatch(t!); settle(s);
    s.send(t!); expect(s.dispatch(t!).verdict).toBe("match");
    settle(s);
    s.send(t!); expect(s.dispatch(t!, { resumeFlip: true }).verdict).toMatch(/^miss/);
  });
  it("T15(m) an incomplete bounded walk or unknown branch membership in the confirm: checking: branch; the next send is ineligible", () => {
    const s = r14Surface(); const [t] = s.fixture("uncertain-branch");
    s.send(t!); s.dispatch(t!); settle(s);
    expect(lineageThreadState(t!)).toMatch(/^checking/);
    s.send(t!); expect(s.dispatch(t!).verdict).toMatch(/^miss/);
  });
});

describe("flagfold F2: the confirm runs E1 at both room extremes", () => {
  for (const recall of [0, 500, 1500]) {
    it(`room-switch fixture, recall ${recall}: less room takes the listing branch, more room the groups branch; warm only if both passes are clean`, () => {
      const s = r14Surface(); const [t] = s.fixture("room-switch");
      s.send(t!); s.dispatch(t!); settle(s);
      const passes = s.record(t!)!.lastConfirm!.passes;
      expect(passes.map(p => p.room)).toEqual(["least", "most"]);
      const switched = Object.keys(passes[0]!.branches).filter(k => passes[0]!.branches[k] !== passes[1]!.branches[k]);
      expect(switched.length, "the fixture must switch a producers branch between the extremes").toBeGreaterThan(0);
      if (lineageThreadState(t!) === "warm") {
        expect(passes.every(p => p.clean)).toBe(true);
        s.send(t!);
        const d = s.dispatch(t!, { recallNodes: recall });
        expect(d.verdict).toBe("match");
        expect(hitOnly(d.counts), `recall ${recall}`).toEqual(HIT_ONLY);
      } else expect(passes.some(p => !p.clean)).toBe(true);
    });
  }
});

describe("flagfold F6: proof-scheduler activations are enforced", () => {
  it("a record whose proof restarts every step stops at its activation budget: RECOVERING-exhausted, no further activations this send", () => {
    const s = r14Surface(); const [t] = s.fixture("proof-restarts");
    s.send(t!); s.dispatch(t!);
    for (let step = 0; step < 40; step++) settle(s);
    const rec = s.record(t!)!;
    expect(rec.activations).toBe(0);
    expect(rec.outcome).toBe("RECOVERING");
    expect(rec.reason ?? "").toMatch(/exhausted/);
    expect(lineageThreadState(t!)).toMatch(/^checking/);
    const rounds = rec.confirmRounds + rec.recoverSlices;
    expect(rounds).toBeLessThanOrEqual(19);
  });
});

describe("flagfold F8", () => {
  it("T10(n4) demoted record: 512 other holds evict its hold; the owner-loss counter moves (asserted directly)", () => {
    const s = r14Surface(); const [a] = s.fixture("plain", { demoted: 1 });
    s.send(a!); s.dispatch(a!); settle(s);
    expect(s.record(a!)!.admitted).toBe(false);
    const lost = s.counters().ownerHoldLoss;
    s.setLimits({ sessionHoldsMax: 1 }); s.send(a!); s.dispatch(a!, { over: { cursor: { instanceId: "engine", nativeSession: "other", incarnation: 1 } } }); s.setLimits(null);
    expect(s.counters().ownerHoldLoss).toBeGreaterThan(lost);
  });
  it("T14(c) recency: every admitted record was sent more recently than the candidate; total pins <= 48 and demotion takes the candidate", () => {
    const s = r14Surface(); const threads = s.fixture("recency-admitted");
    const candidate = threads[0]!;
    s.send(candidate); s.dispatch(candidate);
    for (const t of threads.slice(1)) { s.send(t); s.dispatch(t); }
    settle(s);
    const pins = threads.reduce((n, t) => n + (s.record(t)?.admitted ? s.record(t)!.traceSize : 0), 0);
    expect(pins).toBeLessThanOrEqual(48);
    expect(s.demotions()[0]).toBe(candidate);
    expect(s.counters().pinnedGroupDeletes).toBe(0);
  });
});

describe("T11(b)(c)(g) store structure (r13 D:232-241)", () => {
  it("T11(b) a lost key removes exactly that key; a session-wide clear is a gen move, not a per-key sweep", () => {
    const s = r14Surface(); const [t] = s.fixture("plain");
    s.send(t!); s.dispatch(t!); settle(s);
    s.storeLog(true);
    s.fixture("lost-window-key", { thread: 0 });
    const log = s.storeLog();
    expect(log.filter(e => e.map !== "gen").length).toBe(1);
    s.storeLog(true);
    s.fixture("gate", { op: -1 }); // -1: clearLineage (session-wide)
    const cleared = s.storeLog();
    expect(cleared.some(e => e.map === "gen")).toBe(true);
    expect(cleared.filter(e => e.map === "sessionSound").length).toBe(0);
  });
  it("T11(c) supersede refuses when new is absent or not Q, and leaves proofLossOf unchanged", () => {
    const s = r14Surface(); const st = s.store(); const keys = st.builderKeys();
    const q = keys.find(k => k.expect === "PROOF" && k.site.includes("Q"))!, sKey = keys.find(k => k.expect === "PROOF" && k.site.includes("S"))!;
    const bucket = st.proofBucket(q.key), loss = st.proofLossOf(bucket);
    expect(st.supersede(q.key, "absent-key")).toBe(false);
    expect(st.supersede(sKey.key, q.key)).toBe(false); // old must be Q
    expect(st.supersede(q.key, sKey.key)).toBe(true);
    expect(st.proofLossOf(bucket)).toBe(loss);
  });
  it("T11(g) owner(): every builder site's real key has its expected owner; the awaited key RL:2615 is not a store key; no UNKNOWN anywhere", () => {
    const s = r14Surface(); const st = s.store(); const keys = st.builderKeys();
    for (const site of ["RL:585 g", "RL:653 sessionSound", "RL:715 a", "RL:1290 R", "RL:2097 [t,m]", "RL:2128 [t,m]", "RL:2611 Q", "RL:2613 S"])
      expect(keys.map(k => k.site), site).toContain(site);
    for (const k of keys) expect(st.owner(k.map, k.key), k.site).toBe(k.expect);
    expect(st.owner("verdicts", st.awaitedKey())).toBe("UNKNOWN");
    const before = s.counters().unknownOwners;
    const [t] = s.fixture("gate", { seed: 7 }); s.send(t!); s.dispatch(t!); settle(s);
    expect(s.counters().unknownOwners).toBe(before);
  });
});
