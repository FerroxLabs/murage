// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { RoutineHistoryIndex, routineWorkCounters, type RoutineManager } from "../routines.ts";
import { workCollectionLabel } from "../work-collections.ts";
import { historyInside } from "./routine-history-fixture.ts";

export interface HistoryWork {
  retirementChecks: number; indexTraversals: number; indexVisits: number;
  runArrayVisits: number; runSortComparisons: number;
  retainedMapTraversals: number; retainedMapVisits: number; trieEnumerations: number;
  storeTraversals: number; storeVisits: number; runsMaterialized: number; cloneRun: number;
  fullCommits: number; journalFullTraversals: number; serializedRuns: number; serializedBytes: number;
  journalLines: number; compactCopied: number; trieCalls: number;
}
/** Count at collection/serializer boundaries, including replacement stores and async continuations.
 * No method opts in. The only product seam is the WeakMap label on each store allocation.
 * Only installed probes patch builtins; restore before assertions, logging or cleanup.
 */
export function historyWorkProbe(manager: RoutineManager) {
  const restores: Array<() => void> = [];
  let retirementChecks = 0, indexTraversals = 0, indexVisits = 0;
  let runArrayVisits = 0, runSortComparisons = 0;
  let storeVisits = 0, serializedRuns = 0, serializedBytes = 0, retainedMapTraversals = 0, retainedMapVisits = 0;
  function patch(target: object, key: PropertyKey, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    Object.defineProperty(target, key, { ...descriptor, value });
    restores.push(() => Object.defineProperty(target, key, descriptor));
  }
  const isStore = (value: object) => workCollectionLabel(value) === "routines.runStore";
  const isIndex = (value: object) => workCollectionLabel(value)?.startsWith("routines.indexes.") === true;
  function install() {
    if (restores.length) throw new Error("Probe already installed");
    for (const key of Object.keys(routineWorkCounters) as Array<keyof typeof routineWorkCounters>) {
      if (key === "trieCalls") routineWorkCounters.trieCalls = {}; else routineWorkCounters[key] = 0;
    }
    historyInside(manager).journal.resetWork();
    const inside = historyInside(manager);
    const eligible = RoutineHistoryIndex.prototype.oldestEligible;
    patch(RoutineHistoryIndex.prototype, "oldestEligible", function(this: RoutineHistoryIndex<unknown>, ...args: Parameters<typeof eligible>) {
      if (this === inside.indexes.retirementOrder) retirementChecks++;
      return Reflect.apply(eligible, this, args);
    });
    const retained = new WeakSet<object>([inside.liveDispatch, inside.indexes.indexedRuns, inside.indexes.runsById]);
    const maps = new WeakSet<object>(), indexIterators = new WeakSet<object>();
    for (const key of [Symbol.iterator, "values", "entries", "keys"] as const) {
      const original = Reflect.get(Map.prototype, key);
      patch(Map.prototype, key, function(this: Map<unknown, unknown>, ...args: unknown[]) {
        const iterator = Reflect.apply(original, this, args) as object;
        if (retained.has(this) || /routines.indexes.(indexedRuns|runsById)$/.test(workCollectionLabel(this) ?? "")) { retainedMapTraversals++; maps.add(iterator); }
        if (isIndex(this)) { indexTraversals++; indexIterators.add(iterator); }
        return iterator;
      });
    }
    const mapPrototype = Object.getPrototypeOf(new Map().values()), mapNext = mapPrototype.next;
    patch(mapPrototype, "next", function(this: object, ...args: unknown[]) {
      const result = Reflect.apply(mapNext, this, args) as IteratorResult<unknown>;
      if (maps.has(this) && !result.done) retainedMapVisits++;
      if (indexIterators.has(this) && !result.done) indexVisits++;
      return result;
    });
    const mapEach = Map.prototype.forEach;
    patch(Map.prototype, "forEach", function(this: Map<unknown, unknown>, callback: (a: unknown, b: unknown, m: Map<unknown, unknown>) => void, thisArg?: unknown) {
      const tracked = retained.has(this) || /routines.indexes.(indexedRuns|runsById)$/.test(workCollectionLabel(this) ?? "");
      const indexed = isIndex(this);
      if ((!tracked && !indexed) || typeof callback !== "function") return mapEach.call(this, callback, thisArg);
      if (tracked) retainedMapTraversals++;
      if (indexed) indexTraversals++;
      return mapEach.call(this, (a, b, m) => { if (tracked) retainedMapVisits++; if (indexed) indexVisits++; callback.call(thisArg, a, b, m); });
    });
    const owners = new WeakMap<object, Set<unknown>>();
    for (const key of [Symbol.iterator, "values", "entries", "keys"] as const) {
      const original = Reflect.get(Set.prototype, key);
      patch(Set.prototype, key, function(this: Set<unknown>, ...args: unknown[]) {
        const iterator = Reflect.apply(original, this, args) as object;
        if (isStore(this)) { routineWorkCounters.storeTraversals++; owners.set(iterator, this); }
        if (isIndex(this)) { indexTraversals++; indexIterators.add(iterator); }
        return iterator;
      });
    }
    const prototype = Object.getPrototypeOf(new Set().values()), next = prototype.next;
    patch(prototype, "next", function(this: object, ...args: unknown[]) {
      const result = Reflect.apply(next, this, args) as IteratorResult<unknown>;
      if (owners.has(this) && !result.done) storeVisits++;
      if (indexIterators.has(this) && !result.done) indexVisits++;
      return result;
    });
    const each = Set.prototype.forEach;
    patch(Set.prototype, "forEach", function(this: Set<unknown>, callback: (a: unknown, b: unknown, s: Set<unknown>) => void, thisArg?: unknown) {
      const stored = isStore(this), indexed = isIndex(this);
      if ((!stored && !indexed) || typeof callback !== "function") return each.call(this, callback, thisArg);
      if (stored) routineWorkCounters.storeTraversals++;
      if (indexed) indexTraversals++;
      return each.call(this, (a, b, s) => { if (stored) storeVisits++; if (indexed) indexVisits++; callback.call(thisArg, a, b, s); });
    });
    const isRun = (value: unknown): value is { id: string; routineId: string; scheduledFor: number } => !!value && typeof value === "object"
      && typeof Reflect.get(value, "id") === "string" && typeof Reflect.get(value, "routineId") === "string" && typeof Reflect.get(value, "scheduledFor") === "number";
    for (const key of ["map", "filter", "some", "find", "findIndex", "every", "forEach", "flatMap"] as const) {
      const original = Reflect.get(Array.prototype, key);
      patch(Array.prototype, key, function(this: unknown[], callback: (...args: unknown[]) => unknown, thisArg?: unknown) {
        if (typeof callback !== "function") return Reflect.apply(original, this, [callback, thisArg]);
        return Reflect.apply(original, this, [(...args: unknown[]) => {
          if (isRun(args[0])) runArrayVisits++;
          return Reflect.apply(callback, thisArg, args);
        }]);
      });
    }
    const sort = Array.prototype.sort;
    patch(Array.prototype, "sort", function(this: unknown[], compare?: (a: unknown, b: unknown) => number) {
      if (!compare) return sort.call(this);
      return sort.call(this, (a, b) => { if (isRun(a) && isRun(b)) runSortComparisons++; return compare(a, b); });
    });
    const arrayPrototype = Object.getPrototypeOf([][Symbol.iterator]()), arrayNext = arrayPrototype.next;
    patch(arrayPrototype, "next", function(this: object, ...args: unknown[]) {
      const result = Reflect.apply(arrayNext, this, args) as IteratorResult<unknown>;
      if (!result.done && isRun(result.value)) runArrayVisits++;
      return result;
    });
    const stringify = JSON.stringify;
    patch(JSON, "stringify", function(value: unknown, replacer?: ((this: unknown, key: string, value: unknown) => unknown) | (number | string)[] | null, space?: string | number) {
      // Product serializers here use no replacer (or a function). Do not change array allow-list semantics.
      if (Array.isArray(replacer)) throw new Error("Add an array-replacer probe before measuring this serializer");
      let runs = 0;
      const text = stringify(value, function(this: unknown, key, item) {
        const output = typeof replacer === "function" ? replacer.call(this, key, item) : item;
        if (output && typeof output === "object" && typeof output.id === "string" && typeof output.routineId === "string" && typeof output.scheduledFor === "number") runs++;
        return output;
      }, space);
      serializedRuns += runs;
      if (runs) serializedBytes += Buffer.byteLength(text ?? "");
      return text;
    });
  }
  function stop(): HistoryWork {
    while (restores.length) restores.pop()!();
    return { retirementChecks, indexTraversals, indexVisits, runArrayVisits, runSortComparisons, retainedMapTraversals, retainedMapVisits, trieEnumerations: Object.entries(routineWorkCounters.trieCalls).filter(([key]) => /^(entries|audit):/.test(key)).reduce((sum, [, n]) => sum + n, 0), storeTraversals: routineWorkCounters.storeTraversals, storeVisits,
      runsMaterialized: routineWorkCounters.runsMaterialized, cloneRun: routineWorkCounters.cloneRun,
      fullCommits: routineWorkCounters.fullCommits, journalFullTraversals: historyInside(manager).journal.work.fullTraversals,
      serializedRuns, serializedBytes, journalLines: routineWorkCounters.journalLines,
      compactCopied: routineWorkCounters.compactCopied,
      trieCalls: Object.values(routineWorkCounters.trieCalls).reduce((a, b) => a + b, 0) };
  }
  return { install, stop };
}
export const historyMeasurementCardinality = new WeakMap<HistoryWork, { before: number; after: number; delta: number }>();
export const historyMeasurementMs = new WeakMap<HistoryWork, number>();
export async function measureHistoryWork<T>(manager: RoutineManager, operation: () => T | Promise<T>, delta = 0) {
  const before = historyInside(manager).runStore.size;
  const probe = historyWorkProbe(manager); probe.install();
  const start = performance.now();
  let value: T;
  try { value = await operation(); } catch (error) { probe.stop(); throw error; }
  const ms = performance.now() - start, work = probe.stop();
  const after = historyInside(manager).runStore.size;
  assert.equal(after, before + delta, `Exact store cardinality after measured operation (before=${before}, delta=${delta})`);
  historyMeasurementCardinality.set(work, { before, after, delta });
  historyMeasurementMs.set(work, ms);
  return { value, ms, work };
}
