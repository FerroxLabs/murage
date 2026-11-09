// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r15 L1: the epoch split (handleEpoch / forgetsEpoch, memoEpoch = their sum; trace usedHandles / usedForgets) and the
// r15.1 Y5 lookup from a dependency key to the traced keys that rest on it (store.traceKeysDependingOn / touchesTrace).
import { describe, expect, it } from "vitest";
import { proofBucket, VerdictStore } from "./verdict-store.ts";

const SEP = "\u001f"; // verdict-store.ts / replay-lineage.ts key separator
const v = (key: string) => `v${SEP}${key}`;
const verdict = (...deps: string[]) => ({ withheld: false, unproven: false, deps: new Set(deps) });

describe("r15 epoch split (handle half)", () => {
  it("handle bumps move handleEpoch; memoEpoch is the same counter; stamps carry both", () => {
    const store = new VerdictStore();
    store.bumpHandleEpoch("t"); store.bumpMemoEpoch("legacy");
    expect([store.handleEpoch(), store.memoEpoch()]).toEqual([2, 2]);
    const trace = store.openTrace("t1");
    store.noteMemoUse();
    store.closeTrace();
    expect([trace.usedHandles, trace.usedMemos]).toEqual([true, true]);
    const stamps = store.stampsFor(trace);
    expect([stamps.handleEpoch, stamps.memoEpoch]).toEqual([2, 2]);
  });
  it("a trace with no memo use has neither flag", () => {
    const store = new VerdictStore();
    const trace = store.openTrace("t1");
    store.closeTrace();
    expect([trace.usedHandles, trace.usedMemos]).toEqual([false, false]);
  });
});

describe("T11(c) supersede", () => {
  const Q = (id: string, at: number) => `Q${SEP}${id}${SEP}${at}`, S = (id: string) => `S${SEP}${id}`;
  it("Q -> a present new key: old goes, uncounted; a refusal keeps old and moves nothing", () => {
    const store = new VerdictStore();
    const counts = () => [store.gen(), store.counters().unknownOwners, store.verdictCount()];
    store.setVerdict(Q("set1", 10), verdict()); store.setVerdict(S("set1"), verdict());
    const bucketLoss = () => store.proofLossOf(proofBucket("set1"));
    const before = bucketLoss();
    store.supersede(S("set1"), Q("set1", 20)); // old not Q: refused
    store.supersede(Q("set1", 10), Q("set1", 99)); // new absent: refused
    expect(store.peekVerdict(S("set1"))).toBeDefined();
    expect(store.peekVerdict(Q("set1", 10))).toBeDefined();
    expect(bucketLoss()).toBe(before);
    const mid = counts();
    store.supersede(Q("set1", 10), S("set1"));
    expect(store.peekVerdict(Q("set1", 10))).toBeUndefined();
    expect(bucketLoss()).toBe(before);
    expect(counts()).toEqual([mid[0], mid[1], mid[2]! - 1]);
  });
});

describe("r15.1 Y5 traceKeysDependingOn", () => {
  const m = `m${SEP}t1${SEP}u1`, s = `s${SEP}src9`, other = `m${SEP}t2${SEP}x`;
  function seeded() {
    const store = new VerdictStore();
    // A rests on m directly; B rests on A (a v-edge); C rests on s; D is untraced and rests on other
    for (const [key, deps] of [["A", [m]], ["B", [v("A")]], ["C", [s]], ["D", [other]]] as const) {
      store.setVerdict(key, verdict(...deps));
      for (const d of deps) store.addDependent(d, key);
    }
    const trace = store.openTrace("t1");
    store.getVerdict("B"); store.getVerdict("C");
    store.closeTrace();
    return { store, trace };
  }
  it("walks the dependents index and v-edges upward to traced keys", () => {
    const { store, trace } = seeded();
    expect(store.traceKeysDependingOn(trace, m)).toEqual({ keys: ["B"], over: false });
    expect(store.traceKeysDependingOn(trace, s)).toEqual({ keys: ["C"], over: false });
    expect(store.touchesTrace(trace, m)).toBe(true);
  });
  it("a key nothing traced rests on touches nothing; an unknown key touches nothing", () => {
    const { store, trace } = seeded();
    expect(store.touchesTrace(trace, other)).toBe(false);
    expect(store.touchesTrace(trace, `s${SEP}nope`)).toBe(false);
  });
  it("an evicted verdict still passes the change on (its edges stay)", () => {
    const { store, trace } = seeded();
    store.loseVerdict("A", "evict");
    expect(store.traceKeysDependingOn(trace, m).keys).toEqual(["B"]);
  });
  it("fails closed past the cap", () => {
    const { store, trace } = seeded();
    expect(store.traceKeysDependingOn(trace, m, 1)).toEqual({ keys: [], over: true });
    expect(store.touchesTrace(trace, m, 1)).toBe(true);
  });
  it("does not record into an open trace", () => {
    const { store, trace } = seeded();
    const probe = store.openTrace("t9");
    store.traceKeysDependingOn(trace, m);
    store.closeTrace();
    expect(probe.keys.verdicts.size).toBe(0);
  });
});
