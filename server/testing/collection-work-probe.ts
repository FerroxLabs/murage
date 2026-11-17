// SPDX-License-Identifier: AGPL-3.0-or-later
import { untracked } from "../tracked-state.ts";
import { labelWorkCollection, workCollectionLabel } from "../work-collections.ts";

export type CollectionWork = Record<string, Record<string, number>>;
/** A synchronous measurement window, isolated per test worker. No timers or verifier work inside. */
export function collectionWorkProbe() {
  const counts: CollectionWork = Object.create(null);
  const restores: Array<() => void> = [];
  const owners = new WeakMap<object, object>();
  let discovered = new WeakSet<object>();
  const knownArrays = new WeakSet<object>(), allocations = new WeakSet<object>();
  const arraySizes = new WeakMap<object, number>();
  const triePrototypes = new Set<object>();
  const scalarSerialization = labelWorkCollection("serialization.scalar", {});
  let auditing = false;
  const proxied = new WeakMap<object, object>();
  let measuring = false;
  let activeTrieWork: string | undefined;
  function charge(value: object, operation: string, n = 1) {
    if (!measuring) return;
    const label = workCollectionLabel(value) ?? workCollectionLabel(owners.get(value) ?? value) ?? activeTrieWork ?? "other";
    const row = counts[label] ?? (counts[label] = Object.create(null));
    // S1 gives the canonical store a creation-time label. Preserve the older
    // discovery-path key as the same counter row, so existing guards still
    // observe its real work rather than silently reading an absent bucket.
    if (label === "routines.runStore") counts["manager.runStore"] = row;
    if (label === "routines.indexes.runsById" || label === "routines.indexes.indexedRuns") counts[`manager.indexes.${label.slice("routines.indexes.".length)}`] = row;
    row[operation] = (row[operation] ?? 0) + n;
  }
  function patch(target: object, key: PropertyKey, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    Object.defineProperty(target, key, { ...descriptor, value });
    restores.push(() => Object.defineProperty(target, key, descriptor));
  }
  function labelPayload(value: object): boolean {
    const id = Object.getOwnPropertyDescriptor(value, "id")?.value;
    const routineId = Object.getOwnPropertyDescriptor(value, "routineId")?.value;
    const schedule = Object.getOwnPropertyDescriptor(value, "schedule")?.value;
    if (typeof id !== "string" || (typeof routineId !== "string" && schedule === undefined)) return false;
    labelWorkCollection(workCollectionLabel(value) ?? "routine.payload", value);
    const raw = untracked(value);
    labelWorkCollection(workCollectionLabel(raw) ?? "routine.payload", raw);
    return true;
  }
  /** Discovery never reads run/routine payload graphs. No depth cutoff can hide holders. */
  function discover(value: unknown, path = "root"): unknown {
    // Complete traversal, one aggregate label per owning trie instead of an N-sized label namespace.
    const children = path.indexOf(".children");
    if (children >= 0) path = path.slice(0, children) + ".children";
    if (!value || typeof value !== "object") return value;
    if (proxied.has(value)) {
      const proxy = proxied.get(value);
      if (proxy !== value || discovered.has(value)) return proxy;
      discovered.add(value);
      if (Array.isArray(value)) for (let i = 0; i < value.length; i++) {
        const original = value[i], child = discover(original, `${path}[]`);
        if (child !== original) value[i] = child;
      }
      return proxy;
    }
    if (discovered.has(value)) return value;
    discovered.add(value);
    if (labelPayload(value)) return value;
    labelWorkCollection(workCollectionLabel(value) ?? path, value);
    const root = Object.getOwnPropertyDescriptor(value, "root")?.value;
    const prototype = Object.getPrototypeOf(value);
    if (root && typeof root === "object" && Object.getOwnPropertyDescriptor(root, "children")?.value instanceof Map
        && typeof prototype?.entries === "function" && typeof prototype?.audit === "function") triePrototypes.add(prototype);
    if (Array.isArray(value)) {
      if (auditing && value.length >= 64 && (!knownArrays.has(value) || (arraySizes.get(value) ?? 0) < 64) && !allocations.has(value)) throw new Error(`Uncounted history array replacement: ${path}`);
      knownArrays.add(value); arraySizes.set(value, value.length);
      for (let i = 0; i < value.length; i++) {
        const original = value[i], child = discover(original, `${path}[]`);
        if (child !== original) value[i] = child;
      }
      if (value.length < 64) return value;
      const proxy = new Proxy(value, {
        get(target, key, receiver) { if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) charge(target, "numericRead"); return Reflect.get(target, key, receiver); },
        set(target, key, item, receiver) { if (key === "length" && typeof item === "number" && item < target.length) charge(target, "truncated", target.length - item); return Reflect.set(target, key, item, receiver); },
      });
      labelWorkCollection(workCollectionLabel(value)!, proxy); knownArrays.add(proxy); proxied.set(value, proxy); proxied.set(proxy, proxy); return proxy;
    }
    if (value instanceof Map) {
      for (const [key, child] of value) {
        const next = discover(child, `${path}.value`);
        if (next !== child) value.set(key, next);
      }
    } else if (value instanceof Set) {
      for (const child of value) discover(child, `${path}.member`);
    } else {
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) continue;
        const child = discover(descriptor.value, `${path}.${String(key)}`);
        if (child !== descriptor.value && !Reflect.set(value, key, child)) throw new Error(`Cannot instrument array ${path}.${String(key)}`);
      }
    }
    return value;
  }
  function labelReturned(parent: object, value: unknown) {
    if (!value || typeof value !== "object") return;
    const prefix = workCollectionLabel(parent);
    if (!prefix) return;
    if (labelPayload(value)) return;
    if (value instanceof Map || value instanceof Set) {
      if (!workCollectionLabel(value)) labelWorkCollection(`${prefix}.value`, value);
    } else {
      // New trie nodes/holders are registered on insertion, before their first child operation.
      // These fixed fields do not enumerate either payload records or existing membership.
      const root = Object.getOwnPropertyDescriptor(value, "root")?.value;
      const children = Object.getOwnPropertyDescriptor(value, "children")?.value
        ?? (root && typeof root === "object" ? Object.getOwnPropertyDescriptor(root, "children")?.value : undefined);
      if (root && children instanceof Map && !workCollectionLabel(value)) labelWorkCollection(`${prefix}.value`, value);
      const start = prefix.indexOf(".children");
      const childLabel = start < 0 ? `${prefix}.children` : prefix.slice(0, start) + ".children";
      if (children instanceof Map && !workCollectionLabel(children)) labelWorkCollection(childLabel, children);
    }
  }
  function install() {
    if (measuring || restores.length) throw new Error("Collection probe already installed");
    for (const prototype of [Map.prototype, Set.prototype]) {
      for (const key of ["get", "has", "set", "add", "delete", "clear"]) {
        const original = Object.getOwnPropertyDescriptor(prototype, key)?.value;
        if (!original) continue;
        patch(prototype, key, function(this: Map<unknown, unknown> | Set<unknown>, ...args: unknown[]) {
          charge(this, key, key === "clear" ? this.size : 1);
          if (key === "set") labelReturned(this, args[1]);
          const result = Reflect.apply(original, this, args);
          if (key === "get") labelReturned(this, result);
          return result;
        });
      }
      const forEach = prototype.forEach;
      patch(prototype, "forEach", function(this: Map<unknown, unknown> | Set<unknown>, callback: (...args: unknown[]) => unknown, thisArg?: unknown) {
        if (typeof callback !== "function") return Reflect.apply(forEach, this, [callback, thisArg]);
        const collection = this;
        return Reflect.apply(forEach, this, [function(...args: unknown[]) { charge(collection, "forEachVisit"); return Reflect.apply(callback, thisArg, args); }]);
      });
    }
    for (const prototype of triePrototypes) for (const key of ["entries", "audit", "set", "delete", "latest", "countAfter", "oldestEligible"] as const) {
      const original = Object.getOwnPropertyDescriptor(prototype, key)?.value;
      if (typeof original !== "function") continue;
      patch(prototype, key, function(this: object, ...args: unknown[]) {
        const previous = activeTrieWork;
        activeTrieWork = `${workCollectionLabel(this) ?? "trie"}.work`;
        try {
          if (key === "entries" || key === "audit") charge(this, key === "entries" ? "trieEntries" : "trieAudit");
          return Reflect.apply(original, this, args);
        } finally { activeTrieWork = previous; }
      });
    }
    const iteratorSamples = [new Map().entries(), new Set().values(), [][Symbol.iterator]()];
    for (const iterator of iteratorSamples) {
      const prototype = Object.getPrototypeOf(iterator), original = prototype.next;
      patch(prototype, "next", function(this: object, ...args: unknown[]) {
        charge(this, "next");
        const result = Reflect.apply(original, this, args) as IteratorResult<unknown>;
        if (!result.done && result.value && typeof result.value === "object" && (result.value instanceof Map || result.value instanceof Set)) {
          // A yielded nested holder receives the parent classification, even if it was not reflective.
          if (!workCollectionLabel(result.value)) labelWorkCollection(workCollectionLabel(owners.get(this) ?? this) ?? "other", result.value);
        }
        return result;
      });
    }
    for (const prototype of [Map.prototype, Set.prototype, Array.prototype]) {
      for (const key of ["entries", "values", "keys", Symbol.iterator]) {
        const original = Object.getOwnPropertyDescriptor(prototype, key)?.value;
        if (!original) continue;
        patch(prototype, key, function(this: object, ...args: unknown[]) {
          const iterator = Reflect.apply(original, this, args) as object; owners.set(iterator, this); return iterator;
        });
      }
    }
    for (const key of ["map", "filter", "find", "findIndex", "some", "every", "forEach", "flatMap"]) {
      const original = Array.prototype[key as keyof unknown[]] as (...args: unknown[]) => unknown;
      patch(Array.prototype, key, function(this: unknown[], callback: (...args: unknown[]) => unknown, thisArg?: unknown) {
        const array = this;
        if (typeof callback !== "function") return Reflect.apply(original, this, [callback, thisArg]);
        const result = Reflect.apply(original, this, [function(...args: unknown[]) { charge(array, "arrayVisit"); return Reflect.apply(callback, thisArg, args); }]);
        if (result && typeof result === "object" && Array.isArray(result)) allocations.add(result);
        return result;
      });
    }
    for (const key of ["indexOf", "includes", "lastIndexOf", "slice", "concat"]) {
      const original = Array.prototype[key as keyof unknown[]] as (...args: unknown[]) => unknown;
      patch(Array.prototype, key, function(this: unknown[], ...args: unknown[]) { charge(this, key, this.length); const result = Reflect.apply(original, this, args); if (Array.isArray(result)) allocations.add(result); return result; });
    }
    for (const key of ["push", "unshift"] as const) {
      const original = Array.prototype[key];
      patch(Array.prototype, key, function(this: unknown[], ...args: unknown[]) { allocations.add(this); charge(this, key, args.length); return Reflect.apply(original, this, args); });
    }
    const sort = Array.prototype.sort;
    patch(Array.prototype, "sort", function(this: unknown[], compare?: (a: unknown, b: unknown) => number) {
      const array = this;
      return Reflect.apply(sort, this, [(a: unknown, b: unknown) => { charge(array, "sortCompare"); return compare ? compare(a, b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; }]);
    });
    const splice = Array.prototype.splice;
    patch(Array.prototype, "splice", function(this: unknown[], ...args: unknown[]) {
      const at = Math.min(this.length, Math.max(0, Number(args[0]) < 0 ? this.length + Number(args[0]) : Number(args[0])));
      const removed = args.length < 2 ? this.length - at : Math.min(this.length - at, Math.max(0, Number(args[1])));
      if (args.length - 2 !== removed) charge(this, "shifted", this.length - at - removed);
      return Reflect.apply(splice, this, args);
    });
    for (const key of ["keys", "values", "entries"] as const) {
      const original = Object[key];
      patch(Object, key, function(value: object) {
        if (value && typeof value === "object") labelPayload(value);
        const result = original(value), label = value && typeof value === "object" ? workCollectionLabel(value) : undefined;
        if (label) labelWorkCollection(label, result);
        charge(value, `object${key}`, result.length); return result;
      });
    }
    const from = Array.from;
    patch(Array, "from", function(this: object, ...args: unknown[]) { const result = Reflect.apply(from, this, args); charge(args[0] as object, "arrayFrom", result.length); allocations.add(result); return result; });
    const stringify = JSON.stringify;
    patch(JSON, "stringify", function(...args: unknown[]) {
      const subject = args[0] && typeof args[0] === "object" ? args[0] as object : scalarSerialization;
      if (subject !== scalarSerialization) labelPayload(subject);
      charge(subject, "stringify");
      const result = Reflect.apply(stringify, JSON, args);
      charge(subject, "stringifyBytes", Buffer.byteLength(result ?? ""));
      return result;
    });
    const clone = globalThis.structuredClone;
    patch(globalThis, "structuredClone", function(value: object, ...args: unknown[]) { charge(value, "structuredClone"); return Reflect.apply(clone, globalThis, [value, ...args]); });
    measuring = true;
  }
  function uninstall() { measuring = false; while (restores.length) restores.pop()!(); }
  return { counts, discover, pause() { measuring = false; }, resume() { if (!restores.length) throw new Error("Collection probe is not installed"); measuring = true; }, rediscover(value: object, path = "root") { discovered = new WeakSet(); auditing = true; try { return discover(value, path); } finally { auditing = false; } }, install, uninstall, measure<T>(operation: () => T): T { install(); try { return operation(); } finally { uninstall(); } } };
}
