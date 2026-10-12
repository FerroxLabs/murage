// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale): what a turn pays for a root set grows with what the
// turn ADDED to it, never with the session's history.
//
// A stored root set is a chain: a set is its parent plus the members it adds
// (memory_root_set_parents). Reading one used to expand its whole chain, and
// writing the next one sorted and hashed every member, on every turn of a
// session; at tens of thousands of roots that is the turn.
//
// Here a set is read once into a HANDLE: the set's members are a prefix of one
// growing key list (a "family", the append-only path a thread's sets walk), so
//   - a child set costs its added members, not a copy of its parent;
//   - "is this set inside that one" is a comparison of two numbers;
//   - a branch (two different children of one set) shares the parent's prefix.
// A set under construction (`LayeredRoots`) is a handle plus the few members it
// holds beyond it. Handles are immutable data of an immutable set id (the id of a
// chained set is derived from its parent and what it adds), so they are kept
// while the lineage cache is (replay-lineage.ts drops them with the verdicts),
// and every use as a parent first checks the set row still exists (a rolled
// back write leaves no row).
//
// The ceiling, the "unprovable fails closed" rule and every member are exactly
// those of rootSetMembers/storeRootSet: this file only avoids redoing work.
import { assertExact, readExact, type ExactRead } from "./bounded-read.ts";
import type { DatabaseSync } from "node:sqlite";
import { chainStore, loadRootSetForest, provenRootSets, storeRootSet } from "./schema.ts";

const SEP = "\u0000";

/** Work the set paths did, for tests that pin it rather than the time: DB rows
 * read, members iterated, sets looked up (a cached handle counts a set, no rows). */
const work = { rows: 0, members: 0, sets: 0 };
export function rootSetWork(): { rows: number; members: number; sets: number } { return { ...work }; }
export function resetRootSetWork(): void { work.rows = 0; work.members = 0; work.sets = 0; }

type Statement = ReturnType<DatabaseSync["prepare"]>;
const prepared = new WeakMap<object, Map<string, Statement>>();
function q(db: DatabaseSync, sql: string): Statement {
  let known = prepared.get(db);
  if (!known) prepared.set(db, known = new Map());
  let statement = known.get(sql);
  if (!statement) { if (known.size >= 64) known.clear(); statement = db.prepare(sql); known.set(sql, statement); }
  return statement;
}
const chainedTable = new WeakMap<object, boolean>();
function hasChains(db: DatabaseSync): boolean {
  let known = chainedTable.get(db);
  if (known === undefined) {
    known = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_root_set_parents'").get());
    if (known) chainedTable.set(db, known);
  }
  return known;
}
const chainWriters = new WeakMap<object, ReturnType<typeof chainStore>>();

/** The members of a retained huge set, left in the file: membership is a primary-key lookup, the size is the set row's, and iteration pages through the
 * rows in key order. Nothing is ever read whole (a 100,000-member set is not turned into a 100,000-entry map). */
export interface LazyBase { readonly size: number; has(key: string): boolean; read(from: number, to: number, after?: string): Generator<string> }
/** Sets with more members than this are kept in the file by a handle (see LazyBase); smaller ones are read whole, as they always were. Below the set ceiling
 * the replay admits (ROOT_SET_CEILING, replay-lineage.ts: 50,000), so an admitted large set really is held in the file instead of in memory. */
export const LAZY_ROOT_MIN = 20_000;
const LAZY_PAGE = 2_000;
function lazyBase(db: DatabaseSync, id: string, size: number): LazyBase | null {
  // No count(*) here: it would walk every member of the retained set when the handle is first made (and the work counter would report one row). The rows are
  // counted by the first walk of the whole set, which the soundness proof makes anyway; a set whose own rows are not exactly its size is not provable and that
  // walk throws, so it fails closed (the check treats an error as withheld).
  return {
    size,
    has(key) {
      const at = key.indexOf(SEP);
      work.rows++;
      return Boolean(q(db, "SELECT 1 FROM memory_root_set_members WHERE set_id=? AND root_thread_id=? AND root_message_id=?").get(id, key.slice(0, at), key.slice(at + 1)));
    },
    *read(from, to, after) {
      // `after` is the key just before position `from`: the read resumes by key, never by skipping rows
      const at = after === undefined ? -1 : after.indexOf(SEP);
      let skip = from, last: [string, string] | null = at >= 0 ? [after!.slice(0, at), after!.slice(at + 1)] : null;
      // a read that reaches the declared size proves BOTH ends: its last page asks for one row more (readExact), so a set with fewer rows than it
      // declares and a set with more are both refused, by the same statement, and nothing is kept as proven
      const reachesEnd = to >= size, stop = Math.min(to, size);
      const offsetPage = q(db, "SELECT root_thread_id AS t,root_message_id AS m FROM memory_root_set_members WHERE set_id=?1 ORDER BY root_thread_id,root_message_id LIMIT ?3 OFFSET ?2");
      const keysetPage = q(db, "SELECT root_thread_id AS t,root_message_id AS m FROM memory_root_set_members WHERE set_id=?1 AND (root_thread_id,root_message_id)>(?2,?3) ORDER BY root_thread_id,root_message_id LIMIT ?4");
      // the first rows by offset (a rare path: only a set that must skip what another already gave), then by keyset
      while (skip < stop) {
        const want = Math.min(LAZY_PAGE, stop - skip);
        const final = reachesEnd && skip + want >= size;
        const args = last ? [id, last[0], last[1]] : [id, skip];
        const page: ExactRead<Record<string, unknown>> = readExact<Record<string, unknown>>(last ? keysetPage : offsetPage, args, want);
        if (final) { work.rows += page.rows.length + (page.excess ? 1 : 0); assertExact({ missing: Math.max(0, size - skip - page.rows.length), excess: page.excess }); }
        else work.rows += page.rows.length;
        const rows: Array<Record<string, unknown>> = page.rows;
        if (!rows.length) break;
        for (const row of rows) yield `${row.t}${SEP}${row.m}`;
        last = [String(rows[rows.length - 1]!.t), String(rows[rows.length - 1]!.m)];
        skip += rows.length;
      }
      if (reachesEnd && skip !== size) throw new Error("MEMORY_ROOT_SET_UNPROVEN");
    },
  };
}

/** A growing key list; the members of a set are a prefix of it. A family that
 * branched off another shares that one's first `start` keys. A family may rest on a LazyBase: its first `lazy.size` positions are the retained
 * set's members, left in the file, and its own keys follow them. */
class Family {
  readonly parent: Family | null;
  /** Keys before this family's own (the shared prefix length). */
  readonly start: number;
  readonly keys: string[] = [];
  readonly first = new Map<string, number>();
  readonly depth: number;
  readonly lazy: LazyBase | null;
  constructor(parent: Family | null, start: number, lazy: LazyBase | null = null) { this.parent = parent; this.start = start; this.lazy = lazy; this.depth = parent ? parent.depth + 1 : 0; }
  get length(): number { return this.start + (this.lazy?.size ?? 0) + this.keys.length; }
  /** Where this family's own (in-memory) keys begin. */
  get own(): number { return this.start + (this.lazy?.size ?? 0); }
}
const restsOnLazy = (family: Family | null): boolean => { for (let f = family; f; f = f.parent) if (f.lazy) return true; return false; };

/** One stored set: its first `end` (= size) keys of `family`. */
export interface Handle {
  readonly id: string;
  readonly end: number;
  readonly family: Family;
  readonly parent: Handle | null;
  /** Per other family, how many of its keys (from the start) this set is known to hold: a set that took another thread's
   * set in need not read it again. */
  readonly absorbed: ReadonlyMap<Family, number>;
}
export type HandleCache = Map<string, Handle>;

/** The most distinct sets / keys kept before the cache starts over. */
/** Sets up to this size are stored under the digest of their members (the same union is one set). */
const DEDUPE_MAX = 512;
const MAX_HANDLES = 400_000, MAX_KEYS = 4_000_000, MAX_DEPTH = 12;
let keptKeys = 0;
export function forgetRootSetHandles(cache: HandleCache): void { cache.clear(); keptKeys = 0; partialWalks.delete(cache); }

function hasAt(family: Family | null, key: string, end: number): boolean {
  for (let f = family; f; f = f.parent) {
    const at = f.first.get(key);
    if (at !== undefined) return at < end;
    // the retained part lives in the file; a handle always reaches past it (a set built on it holds all of it)
    if (f.lazy && end >= f.start + f.lazy.size && f.lazy.has(key)) return true;
    end = Math.min(end, f.start);
  }
  return false;
}
function* walk(family: Family, from: number, to: number, after?: string): Generator<string> {
  if (family.parent && from < family.start) yield* walk(family.parent, from, Math.min(to, family.start), after);
  const low = Math.max(from, family.start), high = Math.min(to, family.length);
  if (family.lazy && low < family.own) yield* family.lazy.read(low - family.start, Math.min(high, family.own) - family.start, low === from ? after : undefined);
  for (let at = Math.max(low, family.own); at < high; at++) yield family.keys[at - family.own]!;
}
/** The members of `handle` at positions [from, end). `after`, when given, is the member just before position `from`: the retained part of the set is
 * then read from that key (a keyset seek) and not by skipping `from` rows. */
export function* handleKeys(handle: Handle, from = 0, after?: string): Generator<string> {
  for (const key of walk(handle.family, from, handle.end, after)) { work.members++; yield key; }
}
export const handleHas = (handle: Handle, key: string): boolean => hasAt(handle.family, key, handle.end);
/** How much of `family` the handle's members include from the start (-1: it does not rest on that family). */
function prefixIn(handle: Handle, family: Family): number {
  let end = handle.end;
  for (let f: Family | null = handle.family; f; f = f.parent) {
    if (f === family) return end;
    end = Math.min(end, f.start);
  }
  return -1;
}
/** Whether every member of `inner` is a member of `outer`: both walk the same path and `outer` goes at least as far. */
export const covers = (outer: Handle, inner: Handle): boolean => outer === inner || prefixIn(outer, inner.family) >= inner.end;

function mergeAbsorbed(a: ReadonlyMap<Family, number>, b: ReadonlyMap<Family, number>): Map<Family, number> {
  const out = new Map(a);
  for (const [family, upTo] of b) if ((out.get(family) ?? 0) < upTo) out.set(family, upTo);
  return out;
}
/** A full set: its own family. */
function rootHandle(cache: HandleCache, id: string, keys: readonly string[]): Handle | null {
  const family = new Family(null, 0);
  for (const key of keys) {
    if (family.first.has(key)) return null;
    family.first.set(key, family.keys.length); family.keys.push(key);
  }
  return remember(cache, { id, end: keys.length, family, parent: null, absorbed: new Map() });
}
/** `parent` plus `added` (none already in it). Grows the parent's family in place when the parent is its newest set;
 * otherwise a branch that shares the parent's keys. */
function childHandle(cache: HandleCache, id: string, parent: Handle, added: readonly string[]): Handle | null {
  const seen = new Set<string>();
  for (const key of added) if (seen.has(key) || hasAt(parent.family, key, parent.end)) return null; else seen.add(key);
  let family = parent.family;
  if (family.length !== parent.end) {
    if (family.depth >= MAX_DEPTH && !restsOnLazy(family)) {
      // flatten: a branch of branches would make every membership test walk them all
      const flat = new Family(null, 0);
      for (const key of handleKeys(parent)) { flat.first.set(key, flat.keys.length); flat.keys.push(key); }
      keptKeys += flat.keys.length;
      family = flat;
    } else family = new Family(family, parent.end);
  }
  for (const key of added) { family.first.set(key, family.length); family.keys.push(key); }
  keptKeys += added.length;
  return remember(cache, { id, end: parent.end + added.length, family, parent, absorbed: parent.absorbed });
}
function remember(cache: HandleCache, handle: Handle): Handle {
  if (cache.size >= MAX_HANDLES || keptKeys > MAX_KEYS) { cache.clear(); keptKeys = 0; }
  cache.set(handle.id, handle);
  return handle;
}

interface Link { id: string; size: number; parent: string | null; own: string[]; lazy?: LazyBase }
const HOPS = 48;
/** What a metered read may spend (1.0.2 lineage-cold): a turn's lineage allowance. `room` is what is left (Infinity: unmetered), `take` pays for
 * rows already read and throws, as the allowance does, when they cannot be paid for. A read is never started past the room: a page is
 * at most `room` rows, so even a refused read stays within what the allowance could cover. */
export interface ReadMeter { room(): number; take(rows: number): void }
/** Members read per statement of a metered chain read. */
const MEMBER_PAGE = 512;
/** A chain read that ran out of room, kept where it stopped (links read so far, nearest first, and the link being read with the key
 * it got to) so the next call, the warmer's, goes on from there instead of from the set asked for. Immutable data of immutable sets:
 * dropped with the handles. */
interface Walk { path: Link[]; open: Link | null; after: [string, string] | null; cursor: string | null }
const partialWalks = new WeakMap<HandleCache, Map<string, Walk>>();
const PARTIAL_WALKS_MAX = 64;
function walksOf(cache: HandleCache): Map<string, Walk> {
  let known = partialWalks.get(cache);
  if (!known) partialWalks.set(cache, known = new Map());
  return known;
}

/** The handle of a stored set, or null when it is not held or its chain cannot be proven (the same rule as rootSetMembers:
 * each link strictly smaller, the chain's root present, each set's own rows exactly its size minus its parent's, no member
 * twice). A set whose parent is already known costs its own rows; one far from any known set loads its chain once. With a `meter`
 * the chain is read link by link and page by page, every row paid for before the next page is read, and a read that cannot be paid
 * for stops with the meter's error, keeping what it read (a later call resumes): its cost never follows the length of the chain. */
export function handleFor(db: DatabaseSync, cache: HandleCache, setId: string, meter?: ReadMeter): Handle | null {
  if (!setId) return null;
  work.sets++;
  const known = cache.get(setId);
  if (known) return known;
  if (meter) return meteredHandle(db, cache, setId, meter);
  const path: Link[] = [];
  let cursor: string | null = setId, base: Handle | null = null;
  const chained = hasChains(db);
  while (cursor !== null) {
    const held = cache.get(cursor);
    if (held && path.length) { base = held; break; }
    if (path.length >= HOPS) return coldHandle(db, cache, setId);
    const row = (chained
      ? q(db, "SELECT r.size AS size,p.parent_id AS parent FROM memory_root_sets r LEFT JOIN memory_root_set_parents p ON p.set_id=r.set_id WHERE r.set_id=?")
      : q(db, "SELECT size,NULL AS parent FROM memory_root_sets WHERE set_id=?")).get(cursor);
    work.rows++;
    if (!row) return null;
    const parentId = row.parent === null || row.parent === undefined ? null : String(row.parent);
    // the root of a chain that is huge stays in the file: it is counted once and then looked up, never loaded
    if (parentId === null && Number(row.size) > LAZY_ROOT_MIN) {
      const lazy = lazyBase(db, cursor, Number(row.size));
      if (!lazy) return null;
      path.push({ id: cursor, size: Number(row.size), parent: null, own: [], lazy });
      cursor = null;
      continue;
    }
    const own = q(db, "SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=?").all(cursor).map(r => `${r.root_thread_id}${SEP}${r.root_message_id}`);
    work.rows += own.length;
    path.push({ id: cursor, size: Number(row.size), parent: parentId, own });
    cursor = path[path.length - 1]!.parent;
  }
  return build(cache, path, base);
}
function meteredHandle(db: DatabaseSync, cache: HandleCache, setId: string, meter: ReadMeter): Handle | null {
  const walks = walksOf(cache);
  let walk = walks.get(setId);
  if (!walk) {
    if (walks.size >= PARTIAL_WALKS_MAX) walks.delete(walks.keys().next().value!);
    walks.set(setId, walk = { path: [], open: null, after: null, cursor: setId });
  }
  const chained = hasChains(db);
  let base: Handle | null = null;
  while (walk.cursor !== null) {
    const held = cache.get(walk.cursor);
    if (held && walk.path.length) { base = held; break; }
    if (!walk.open) {
      // nothing is read before it can be paid for: with no room left this is where a cold read stops, having read no row
      meter.take(1);
      const row = (chained
        ? q(db, "SELECT r.size AS size,p.parent_id AS parent FROM memory_root_sets r LEFT JOIN memory_root_set_parents p ON p.set_id=r.set_id WHERE r.set_id=?")
        : q(db, "SELECT size,NULL AS parent FROM memory_root_sets WHERE set_id=?")).get(walk.cursor);
      work.rows++;
      if (!row) { walks.delete(setId); return null; }
      walk.open = { id: walk.cursor, size: Number(row.size), parent: row.parent === null || row.parent === undefined ? null : String(row.parent), own: [] };
      walk.after = null;
    }
    const open = walk.open;
    for (;;) {
      // a set holds exactly its size minus its parent's: more rows than its size can never be proven
      if (open.own.length > open.size) { walks.delete(setId); return null; }
      const room = meter.room();
      if (room < 1) meter.take(1);
      const limit = Math.max(1, Math.min(MEMBER_PAGE, room, open.size - open.own.length + 1));
      const rows = (walk.after
        ? q(db, "SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=? AND (root_thread_id,root_message_id)>(?,?) ORDER BY root_thread_id,root_message_id LIMIT ?").all(open.id, walk.after[0], walk.after[1], limit)
        : q(db, "SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=? ORDER BY root_thread_id,root_message_id LIMIT ?").all(open.id, limit));
      work.rows += rows.length;
      if (rows.length) {
        meter.take(rows.length);
        for (const r of rows) open.own.push(`${r.root_thread_id}${SEP}${r.root_message_id}`);
        const last = rows[rows.length - 1]!;
        walk.after = [String(last.root_thread_id), String(last.root_message_id)];
      }
      if (rows.length < limit) break;
    }
    walk.path.push(open);
    walk.cursor = open.parent;
    walk.open = null; walk.after = null;
  }
  walks.delete(setId);
  return build(cache, walk.path, base);
}
/** Links nearest-first (path[0] is the set asked for), resting on `base` (the parent of the last link) or on nothing. */
function build(cache: HandleCache, path: readonly Link[], base: Handle | null): Handle | null {
  let at = base;
  for (let index = path.length - 1; index >= 0; index--) {
    const link = path[index]!;
    if (at === null) {
      if (link.lazy) {
        if (link.parent !== null) return null;
        at = remember(cache, { id: link.id, end: link.size, family: new Family(null, 0, link.lazy), parent: null, absorbed: new Map() });
        continue;
      }
      if (link.parent !== null || link.own.length !== link.size) return null;
      at = rootHandle(cache, link.id, link.own);
    } else {
      if (link.parent !== at.id || link.size <= at.end || link.own.length !== link.size - at.end) return null;
      at = childHandle(cache, link.id, at, link.own);
    }
    if (!at) return null;
  }
  return at;
}
/** A chain too long to walk one set at a time: loaded and proven together (the repair's own reader), once. */
function coldHandle(db: DatabaseSync, cache: HandleCache, setId: string): Handle | null {
  const forest = loadRootSetForest(db, [setId], { lazyAbove: LAZY_ROOT_MIN });
  work.rows += forest.nodes.size;
  for (const rows of forest.own.values()) work.rows += rows.length;
  if (!provenRootSets(forest, [setId]).get(setId)) return null;
  const order: Link[] = [];
  let base: Handle | null = null;
  for (let at: string | null = setId; at !== null;) {
    const held = cache.get(at);
    if (held && order.length) { base = held; break; }
    const node = forest.nodes.get(at);
    if (!node) return null;
    if (forest.lazy?.has(at)) {
      const lazy = lazyBase(db, at, node.size);
      if (!lazy) return null;
      order.push({ id: at, size: node.size, parent: null, own: [], lazy });
    } else order.push({ id: at, size: node.size, parent: node.parent, own: (forest.own.get(at) ?? []).map(([thread, message]) => `${thread}${SEP}${message}`) });
    at = node.parent;
  }
  return build(cache, order, base);
}

/** A set under construction: a stored set (`handle`) and the members it holds beyond it (`extra`, never one the handle
 * has). Quacks like the Set<string> it replaces: size, has, add, iteration. */
export class LayeredRoots {
  handle: Handle | null = null;
  readonly extra = new Set<string>();
  absorbed = new Map<Family, number>();
  get size(): number { return (this.handle?.end ?? 0) + this.extra.size; }
  has(key: string): boolean { return this.extra.has(key) || (this.handle !== null && handleHas(this.handle, key)); }
  add(key: string): this { if (!this.has(key)) this.extra.add(key); return this; }
  forEach(callback: (key: string) => void): void { for (const key of this) callback(key); }
  *[Symbol.iterator](): Generator<string> {
    if (this.handle) yield* handleKeys(this.handle);
    yield* this.extra;
  }
  clone(): LayeredRoots {
    const copy = new LayeredRoots();
    copy.handle = this.handle; copy.absorbed = new Map(this.absorbed);
    for (const key of this.extra) copy.extra.add(key);
    return copy;
  }
  /** Takes in every member of a stored set. */
  absorb(other: Handle): void {
    const mine = this.handle;
    if (!mine) { this.handle = other; this.absorbed = mergeAbsorbed(this.absorbed, other.absorbed); this.prune(); return; }
    if (covers(mine, other)) return;
    if (covers(other, mine) || other.end > mine.end) {
      // the larger set becomes the base: what the old base held beyond it moves to the extras
      const related = covers(other, mine);
      this.handle = other;
      this.absorbed = mergeAbsorbed(this.absorbed, other.absorbed);
      this.prune();
      if (!related) this.take(mine, 0);
      return;
    }
    this.take(other, Math.max(mine.absorbed.get(other.family) ?? 0, this.absorbed.get(other.family) ?? 0));
    if (prefixIn(other, other.family) === other.end) this.absorbed.set(other.family, Math.max(this.absorbed.get(other.family) ?? 0, other.end));
  }
  /** The members of `from` at positions [skip, end) that the set lacks. */
  private take(from: Handle, skip: number): void {
    if (skip >= from.end) return;
    for (const key of handleKeys(from, skip)) if (!this.has(key)) this.extra.add(key);
  }
  /** Extras that the base now holds are not extras. */
  private prune(): void {
    const base = this.handle;
    if (!base || !this.extra.size) return;
    for (const key of [...this.extra]) { work.members++; if (handleHas(base, key)) this.extra.delete(key); }
  }
  /** The union of this and another set under construction. */
  union(other: LayeredRoots): LayeredRoots {
    const out = this.clone();
    if (other.handle) out.absorb(other.handle);
    for (const key of other.extra) out.add(key);
    out.absorbed = mergeAbsorbed(out.absorbed, other.absorbed);
    return out;
  }
}
/** The minimal Set surface a root set offers its callers. */
export interface RootView { readonly size: number; has(key: string): boolean; add(key: string): unknown; forEach(callback: (key: string) => void): void; [Symbol.iterator](): Iterator<string> }
export function layeredOf(roots: RootView): LayeredRoots {
  if (roots instanceof LayeredRoots) return roots;
  const out = new LayeredRoots();
  for (const key of roots as Iterable<string>) out.extra.add(key);
  return out;
}

/** Stores the set and returns its id: a stored set plus what it adds is a chained set whose rows are the additions alone
 * (id derived from the parent and the additions); a set with no stored base is stored whole. A base whose row is gone
 * (a write that rolled back) is not trusted: the set is stored whole. */
export function storeLayered(db: DatabaseSync, cache: HandleCache, set: LayeredRoots): string {
  const base = set.handle;
  if (base && hasChains(db)) {
    const row = q(db, "SELECT size FROM memory_root_sets WHERE set_id=?").get(base.id);
    work.rows++;
    if (row && Number(row.size) === base.end) {
      if (!set.extra.size) return base.id;
      // A small set keeps its content-addressed id, so the same union reached through different replies is one stored set;
      // a large one is a chain, whose id comes from the parent and what it adds (hashing the whole of it is what a turn must not do).
      if (base.end + set.extra.size <= DEDUPE_MAX) {
        const all = [...set];
        work.members += all.length;
        const id = storeRootSet(db, all, base.id);
        const added = [...set.extra];
        if (!cache.has(id)) childHandle(cache, id, base, added);
        return id;
      }
      const added = [...set.extra].sort();
      work.members += added.length;
      let write = chainWriters.get(db);
      if (!write) chainWriters.set(db, write = chainStore(db));
      const id = write(base.id, base.end, added);
      work.rows += added.length;
      const made = cache.get(id) ?? childHandle(cache, id, base, added);
      if (made) {
        const merged = mergeAbsorbed(made.absorbed, set.absorbed);
        if (merged.size !== made.absorbed.size || [...merged].some(([family, upTo]) => made.absorbed.get(family) !== upTo)) cache.set(id, { ...made, absorbed: merged });
      }
      return id;
    }
    cache.delete(base.id);
  }
  const keys = [...set];
  work.members += keys.length;
  const id = storeRootSet(db, keys);
  return id;
}
