// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { labelWorkCollection, workCollectionLabel } from "../work-collections.ts";
import { RoutineHistoryIndex, historyKey, routineWorkCounters } from "../routines.ts";
import { PendingTurnCancellations, RetiredTurnRegistry } from "../turn-dispatch-guard.ts";
import { collectionWorkProbe } from "./collection-work-probe.ts";

it("P32 registers real private collections before installation and charges by manifest label", () => {
  const retired = new RetiredTurnRegistry(2), pending = new PendingTurnCancellations();
  retired.retire("old");
  const probe = collectionWorkProbe();
  probe.measure(() => { retired.has("old"); retired.retire("new"); retired.retire("overflow"); pending.mark("t", "owner"); pending.has("t"); pending.clear("t", "owner"); });
  expect(probe.counts["RetiredTurnRegistry.turnIds"], "private registration label").toBeDefined();
  expect(probe.counts["RetiredTurnRegistry.turnIds"].has).toBe(1);
  expect(probe.counts["RetiredTurnRegistry.turnIds"].add).toBe(2);
  expect(probe.counts["RetiredTurnRegistry.turnIds"].next).toBe(1);
  expect(probe.counts["PendingTurnCancellations.ownersByThread"].has).toBe(1);
  expect(probe.counts["PendingTurnCancellations.owners"].set).toBe(1);
});

for (const kind of ["Map", "Set"] as const) it(`P32 ${kind} forEach counts callbacks, thisArg, argument identity, mutations and thrown prefix`, () => {
  const collection = labelWorkCollection(`probe.${kind}`, kind === "Map" ? new Map([[1, 10], [2, 20], [3, 30]]) : new Set([10, 20, 30]));
  const probe = collectionWorkProbe(), context = {}, observed: unknown[][] = [];
  probe.measure(() => {
    (collection.forEach as Function)(function(this: object, value: number, key: number, original: object) {
      observed.push([this, value, key, original]);
      if (value === 10) { if (collection instanceof Map) { collection.delete(2); collection.set(4, 40); } else { collection.delete(20); collection.add(40); } }
    }, context);
  });
  expect(probe.counts[`probe.${kind}`]?.forEachVisit, "exact callback visits").toBe(3);
  expect(probe.counts[`probe.${kind}`].next ?? 0).toBe(0);
  expect(observed.map(row => row[1])).toEqual([10, 30, 40]);
  expect(observed.every(row => row[0] === context && row[3] === collection)).toBe(true);
  expect(observed.map(row => row[2])).toEqual(kind === "Map" ? [1, 3, 4] : [10, 30, 40]);
  const thrown = collectionWorkProbe();
  expect(() => thrown.measure(() => collection.forEach(() => { throw new Error("stop"); }))).toThrow("stop");
  expect(thrown.counts[`probe.${kind}`].forEachVisit).toBe(1);
});

it("P32 private forEach is labelled without reflection or discovery", () => {
  class PrivateProbe {
    #map = labelWorkCollection("PrivateProbe.map", new Map([["a", 1], ["b", 2]]));
    #set = labelWorkCollection("PrivateProbe.set", new Set([1, 2, 3]));
    walk() { this.#map.forEach(() => {}); this.#set.forEach(() => {}); }
  }
  const object = new PrivateProbe(), probe = collectionWorkProbe();
  probe.measure(() => object.walk());
  expect(probe.counts["PrivateProbe.map"].forEachVisit).toBe(2);
  expect(probe.counts["PrivateProbe.set"].forEachVisit).toBe(3);
});

it("P32 iterator made before install and nested yielded holders are counted", () => {
  const nested = new Set([1, 2]), map = labelWorkCollection("preexisting", new Map([["nested", nested]]));
  const iterator = labelWorkCollection("preexisting", map.values());
  const probe = collectionWorkProbe();
  probe.measure(() => { const child = iterator.next().value!; for (const value of child) void value; });
  expect(probe.counts.preexisting?.next).toBe(4); // parent + child two yields + done
  expect(workCollectionLabel(nested)).toBe("preexisting");
});

it("P32 recursive nested holder discovery, arrays, clears and unclassified work", () => {
  const root = { holder: { map: new Map([["a", new Set([1, 2, 3])]]) }, array: Array.from({ length: 100 }, (_, i) => i) };
  const probe = collectionWorkProbe(); probe.discover(root);
  probe.measure(() => {
    root.holder.map.forEach(set => { for (const item of set) void item; set.clear(); });
    root.holder.map.clear();
    void root.array[80]; root.array.length = 0;
    new Set([1]).has(1);
  });
  expect(probe.counts["root.holder.map.value"]?.next).toBe(4);
  expect(probe.counts["root.holder.map.value"]?.clear).toBe(3);
  expect(probe.counts["root.holder.map"].clear).toBe(1);
  expect(probe.counts["root.array"].numericRead).toBe(1);
  expect(probe.counts["root.array"].truncated).toBe(100);
  expect(probe.counts.other.has).toBe(1);
});

it("P32 restores exact prototype descriptors and native exceptions after each window", () => {
  const before = Object.getOwnPropertyDescriptor(Map.prototype, "forEach");
  const probe = collectionWorkProbe(); expect(() => probe.measure(() => { throw new Error("failed"); })).toThrow("failed");
  expect(Object.getOwnPropertyDescriptor(Map.prototype, "forEach")).toEqual(before);
});

it("P32 replacement arrays need a counted allocation and are wrapped on rediscovery", () => {
  const root = { rows: [] as number[] }, probe = collectionWorkProbe(); probe.discover(root);
  probe.measure(() => { root.rows = Array.from({ length: 100 }, (_, i) => i); });
  expect(() => probe.rediscover(root)).not.toThrow();
  probe.measure(() => { void root.rows[80]; });
  expect(probe.counts["root.rows"].numericRead).toBe(1);
  const uncounted = { rows: [] as number[] }, second = collectionWorkProbe(); second.discover(uncounted);
  uncounted.rows = new Array(100);
  expect(() => second.rediscover(uncounted)).toThrow("Uncounted history array replacement: root.rows");
});

it("P32 collections inserted during the window inherit holder labels before their first visit", () => {
  const map = labelWorkCollection("new-holder", new Map<string, unknown>()), probe = collectionWorkProbe();
  probe.measure(() => {
    const node = { children: new Map<string, unknown>() }; map.set("node", node);
    node.children.set("leaf", new Set([1, 2]));
    const set = node.children.get("leaf") as Set<number>; set.forEach(() => {});
  });
  expect(probe.counts["new-holder.children"].set).toBe(1);
  expect(probe.counts["new-holder.children.value"].forEachVisit).toBe(2);
});

it("P32 discovery and repeated rediscovery never reassign unchanged owner-list entries or stack proxies", () => {
  let writes = 0;
  const rows = new Proxy(Array.from({ length: 100 }, (_, n) => ({ id: String(n), routineId: "r" })), { set(target, key, value, receiver) { writes++; return Reflect.set(target, key, value, receiver); } });
  const root = { rows }, probe = collectionWorkProbe(); probe.discover(root);
  const first = root.rows;
  for (let n = 0; n < 3; n++) probe.rediscover(root);
  expect(root.rows).toBe(first); expect(writes, "discovery must not trigger owner mutations").toBe(0);
  probe.measure(() => { void root.rows[90]; });
  expect(probe.counts["root.rows"].numericRead, "one proxy read per actual access").toBe(1);
});

it("P32 growth across the history threshold requires an observed allocation", () => {
  const root = { rows: [] as number[] }, probe = collectionWorkProbe(); probe.discover(root);
  root.rows.length = 100;
  expect(() => probe.rediscover(root)).toThrow("Uncounted history array replacement: root.rows");
});

it("P32 scalar and failed JSON serialization calls are counted independently of collection work", () => {
  const probe = collectionWorkProbe(), cyclic = labelWorkCollection("cyclic", {} as { self?: object }); cyclic.self = cyclic;
  probe.measure(() => {
    JSON.stringify(1); JSON.stringify(undefined);
    try { JSON.stringify(cyclic); } catch { /* native cycle failure remains native */ }
  });
  expect(probe.counts["serialization.scalar"].stringify).toBe(2);
  expect(probe.counts["serialization.scalar"].stringifyBytes).toBe(1);
  expect(probe.counts.cyclic.stringify).toBe(1);
});

it("P32 trie traversal/audit probes charge the owning index before any iterator is consumed", () => {
  class TrieProbe {
    root = { children: new Map() };
    *entries() { yield 1; }
    audit() { return []; }
  }
  const root = { trie: new TrieProbe() }, probe = collectionWorkProbe(); probe.discover(root);
  probe.measure(() => { root.trie.entries(); root.trie.audit(); });
  expect(probe.counts["root.trie"].trieEntries).toBe(1);
  expect(probe.counts["root.trie"].trieAudit).toBe(1);
});


it("P32 real fixed-width trie paths stay classified and record one public call", () => {
  const index = new RoutineHistoryIndex<number>(16); index.set(historyKey(1), 1);
  const root = { index }, probe = collectionWorkProbe(); probe.discover(root, "probe");
  const before = routineWorkCounters.trieCalls["set:16"] ?? 0;
  probe.measure(() => index.set(historyKey(2), 2));
  expect(routineWorkCounters.trieCalls["set:16"]).toBe(before + 1);
  expect(probe.counts["probe.index.work"].push, "one path insertion per fixed digit").toBe(16);
  expect(probe.counts.other?.push ?? 0).toBe(0);
  expect(index.audit()).toEqual([]);
});
