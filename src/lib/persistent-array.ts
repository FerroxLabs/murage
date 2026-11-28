// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Immutable Array-compatible storage. Seven radix-32 levels cover every legal
// array index: an append/replace copies at most 224 slots, regardless of history.
export type PositionTree<T> = Array<PositionTree<T> | T | undefined> & { last?: T };
type Node<T> = PositionTree<T>;
interface Storage<T> { root: Node<T>; change?: { previous: WeakRef<T[]>; index: number; value: T } }
const storage = new WeakMap<unknown[], Storage<unknown>>();
// Consumers publish indexes at creation time when they already indexed the
// parent snapshot. This also covers intermediate pixel-stripping replacements
// and multiple live events arriving between paints, without retaining parents.
const derived = new Set<(before: unknown[], after: unknown[]) => void>();
export function onArrayChange<T>(update: (before: T[], after: T[]) => void): void {
  derived.add(update as (before: unknown[], after: unknown[]) => void);
}
const DEPTH = 6;
const slot = (index: number, depth: number) => Math.floor(index / 32 ** depth) % 32;
export function putPosition<T>(root: Node<T>, index: number, value: T | undefined, depth = DEPTH): Node<T> {
  const next: Node<T> = root.slice(), at = slot(index, depth);
  next[at] = depth ? putPosition((root[at] as Node<T>) ?? [], index, value, depth - 1) : value;
  next.last = depth ? (next.findLast(child => (child as Node<T> | undefined)?.last !== undefined) as Node<T> | undefined)?.last : next.findLast(child => child !== undefined) as T | undefined;
  return next;
}
function read<T>(root: Node<T>, index: number): T {
  let node = root;
  for (let depth = DEPTH; depth > 0; depth--) node = node[slot(index, depth)] as Node<T>;
  return node[slot(index, 0)] as T;
}
const numeric = (key: PropertyKey): number | undefined => typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : undefined;
function arrayView<T>(length: number, itemAt: (index: number) => T): T[] {
  // An empty target keeps the allocation independent of history; length is served by the traps.
  const target: T[] = [];
  return new Proxy(target, {
    get: (array, key, receiver) => { if (key === "length") return length; const i = numeric(key); return i !== undefined ? i < length ? itemAt(i) : undefined : Reflect.get(array, key, receiver); },
    has: (array, key) => { if (key === "length") return true; const i = numeric(key); return i !== undefined ? i < length : Reflect.has(array, key); },
    ownKeys: () => [...Array.from({ length }, (_, i) => String(i)), "length"],
    getOwnPropertyDescriptor: (array, key) => { if (key === "length") return { value: length, enumerable: false, configurable: false, writable: true }; const i = numeric(key); return i !== undefined && i < length ? { value: itemAt(i), enumerable: true, configurable: true, writable: false } : Reflect.getOwnPropertyDescriptor(array, key); },
    set: () => { throw new TypeError("Transcript arrays are immutable"); },
  });
}

function view<T>(data: Storage<T>, length: number): T[] {
  const result = arrayView(length, i => read(data.root, i));
  storage.set(result, data as Storage<unknown>);
  return result;
}

/** Read a small prefix and the existing tail without copying the tail. */
export function prependArrayItems<T>(prefix: readonly T[], tail: T[]): T[] {
  return prefix.length ? arrayView(prefix.length + tail.length, i => i < prefix.length ? prefix[i]! : tail[i - prefix.length]!) : tail;
}
export function replaceArrayItem<T>(previous: T[], index: number, value: T): T[] {
  if (index < 0 || index > previous.length) throw new RangeError("Invalid transcript position");
  const data = prepareArray(previous);
  const next = view({ root: putPosition(data.root, index, value), change: { previous: new WeakRef(previous), index, value } }, Math.max(previous.length, index + 1));
  for (const update of derived) update(previous, next);
  return next;
}
export function prepareArray<T>(previous: readonly T[]): Storage<T> {
  let data = storage.get(previous as T[]) as Storage<T> | undefined;
  if (!data) {
    let root: Node<T> = [];
    for (let i = 0; i < previous.length; i++) root = putPosition(root, i, previous[i]!);
    data = { root };
    storage.set(previous as T[], data as Storage<unknown>);
  }
  return data;
}
export const appendArrayItem = <T>(previous: T[], value: T): T[] => replaceArrayItem(previous, previous.length, value);
export function arrayChange<T>(array: readonly T[]) {
  const change = (storage.get(array as T[]) as Storage<T> | undefined)?.change;
  const previous = change?.previous.deref();
  return change && previous ? { ...change, previous } : undefined;
}

// Persistent string-key lookup: path copying is proportional to key length,
// never to the number of transcript rows. No shared mutable snapshot indexes.
interface Trie<T> { value?: T; children: Map<string, Trie<T>> }
export class TranscriptMap<T> {
  constructor(private readonly root: Trie<T> = { children: new Map() }) {}
  get(key: string): T | undefined {
    let node: Trie<T> | undefined = this.root;
    for (const char of key) { node = node.children.get(char); if (!node) return undefined; }
    return node.value;
  }
  set(key: string, value: T): TranscriptMap<T> {
    const chars = [...key];
    const update = (node: Trie<T>, at: number): Trie<T> => {
      if (at === chars.length) return { ...node, value };
      const char = chars[at]!, children = new Map(node.children);
      children.set(char, update(children.get(char) ?? { children: new Map() }, at + 1));
      return { ...node, children };
    };
    return new TranscriptMap(update(this.root, 0));
  }
}
