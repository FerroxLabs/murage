// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 L1 test hooks for L2's surface: builder keys with their owners, the store log tap, ownerHoldLoss and unknownOwners.
import { describe, expect, it } from "vitest";
import { lineageBuilderKeysForTest } from "./replay-lineage.ts";
import { owner, VerdictStore, type StoreLogEntry } from "./verdict-store.ts";

const verdict = () => ({ withheld: false, unproven: false, deps: new Set<string>() });

describe("lineageBuilderKeysForTest", () => {
  for (const reader of ["", "aud1"]) {
    it(`every builder site's key has the owner the design assigns (reader "${reader}")`, () => {
      const { keys, awaitedKey } = lineageBuilderKeysForTest("t1", "m1", "set1", reader);
      expect(keys.length).toBe(8);
      for (const { site, map, key, expected } of keys) expect(owner(map, key), site).toEqual(expected);
      expect(owner("verdicts", awaitedKey).kind).toBe("UNKNOWN");
    });
  }
});

describe("store log tap and counters", () => {
  it("logs each removal with its owner and a gen entry per clear", () => {
    const store = new VerdictStore();
    const log: StoreLogEntry[] = [];
    store.onStoreLog(entry => log.push(entry));
    const key = JSON.stringify(["t1", "m1"]);
    store.setVerdict(key, verdict());
    store.loseVerdict(key, "forget");
    store.clearLineage("test");
    store.onStoreLog(null);
    store.clearLineage("test");
    expect(log).toEqual([
      { map: "verdicts", key, why: "forget", owner: { kind: "THREAD", thread: "t1", redo: { kind: "m", message: "m1" } } },
      { map: "gen", key: "", why: "test" },
    ]);
  });
  it("unknownOwners counts a removal owner() cannot place", () => {
    const store = new VerdictStore();
    store.setVerdict("zzz", verdict());
    store.loseVerdict("zzz", "forget");
    expect(store.counters().unknownOwners).toBe(1);
  });
  it("ownerHoldLoss counts a THREAD owner's hold evicted for room", () => {
    const store = new VerdictStore();
    store.setHold(JSON.stringify(["t1", "h1"]), { n: 1 }, 1);
    store.setHold(JSON.stringify(["t2", "h2"]), { n: 2 }, 1);
    expect(store.counters().ownerHoldLoss).toBe(1);
  });
});
