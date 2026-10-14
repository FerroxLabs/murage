// SPDX-License-Identifier: AGPL-3.0-or-later
// Write tracking for persisted in-memory state (1.0.2 bgwork).
//
// RoutineManager saves incrementally: it appends only the runs and routines
// that changed. "Changed" cannot rest on each call site naming what it
// touched: a path that forgets (or changes a nested field such as
// run.watch.outcome) would stay unsaved until the next full rewrite, and a
// crash before then loses it. Instead every persisted run, routine and the
// receipt list is held behind a tracking proxy: any write to it, at any
// depth, goes through one set/delete/define trap that calls the owner's
// onWrite. A path cannot change persisted state without being marked.
//
// Invariants:
// - The raw target under a proxy never holds a proxy: every value stored
//   through a trap is stripped back to raw first, so the target can be
//   serialized, structuredCloned or compared without side effects.
// - Reading never marks: only a write does.
// - Nested objects read through a proxy come back as proxies of the same
//   root (cached per root), so `run.watch.outcome = x` marks the run.

const targets = new WeakMap<object, object>();

function plainContainer(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The raw object under a tracking proxy (or the value itself). Reading it never marks anything. */
export function untracked<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const target = targets.get(value as object);
    if (target) return target as T;
  }
  return value;
}

/** True when `value` is a tracking proxy. */
export function isTracked(value: unknown): boolean {
  return value !== null && typeof value === "object" && targets.has(value as object);
}

/** Replace every tracking proxy inside a plain value with its raw target, in place. */
function strip(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const target = targets.get(value);
  if (target) return target;
  if (!plainContainer(value) || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const child = value[key];
    const next = strip(child, seen);
    if (next !== child) value[key] = next;
  }
  return value;
}

/** A deep copy with no proxies in it: structuredClone for values that may be (or hold) tracking proxies. */
export function plainCopy<T>(value: T): T {
  const raw = untracked(value);
  if (raw === null || typeof raw !== "object") return raw;
  if (Array.isArray(raw)) return raw.map(item => plainCopy(item)) as T;
  if (!plainContainer(raw)) return structuredClone(raw);
  const copy: Record<PropertyKey, unknown> = Object.getPrototypeOf(raw) === null ? Object.create(null) : {};
  for (const key of Object.keys(raw)) copy[key] = plainCopy(raw[key]);
  return copy as T;
}

/** Hold `root` behind a proxy that calls `onWrite` on any write at any depth. A tracked value is returned as is. */
export function track<T extends object>(root: T, onWrite: () => void): T {
  if (targets.has(root)) return root;
  strip(root);
  const cache = new WeakMap<object, object>();
  const wrap = (target: object): object => {
    let proxy = cache.get(target);
    if (!proxy) {
      proxy = new Proxy(target, handler);
      cache.set(target, proxy);
      targets.set(proxy, target);
    }
    return proxy;
  };
  const handler: ProxyHandler<Record<PropertyKey, unknown>> = {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (!plainContainer(value)) return value;
      // a frozen slot must report its own value (Proxy invariant)
      const slot = Reflect.getOwnPropertyDescriptor(target, key);
      if (slot && !slot.configurable && !slot.writable) return value;
      return wrap(value);
    },
    set(target, key, value) {
      const next = strip(value);
      if (Object.prototype.hasOwnProperty.call(target, key) && Object.is(target[key as string], next)) return true;
      const done = Reflect.set(target, key, next);
      if (done) onWrite();
      return done;
    },
    deleteProperty(target, key) {
      const had = Object.prototype.hasOwnProperty.call(target, key);
      const done = Reflect.deleteProperty(target, key);
      if (done && had) onWrite();
      return done;
    },
    defineProperty(target, key, descriptor) {
      const next = "value" in descriptor ? { ...descriptor, value: strip(descriptor.value) } : descriptor;
      const done = Reflect.defineProperty(target, key, next);
      if (done) onWrite();
      return done;
    },
    setPrototypeOf() { return false; },
  };
  return wrap(root) as T;
}
