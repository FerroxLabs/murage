// SPDX-License-Identifier: AGPL-3.0-or-later
// Incremental walk producer and receipt/session consumers owner: new3-g5.
import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { MessageCopy, ReplayCopyRoots, SendReplayProof } from "./replay-lineage.ts";
import { replayStatement as stmt } from "./replay-lineage.ts";

// Fixed-depth persistent hash trie. A child shares its parent's immutable root;
// a mutation copies at most eight 16-way branches, independent of history and
// of the number of prior receipts. In particular there is no overlay chain to
// traverse, periodic whole-map compaction, or history-sized rollback snapshot.
type Tree<V> = { children?: (Tree<V> | undefined)[]; entries?: readonly (readonly [string, V])[] };
function hash(key: string): number { let h = 2166136261; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619); return h >>> 0; }
class WalkMap<V> implements Iterable<[string, V]> {
  root: Tree<V> = {}; size = 0;
  fork(): WalkMap<V> { const m = new WalkMap<V>(); m.root = this.root; m.size = this.size; return m; }
  get(key: string): V | undefined {
    const h = hash(key); let node: Tree<V> | undefined = this.root;
    for (let depth = 0; depth < 8 && node; depth++) node = node.children?.[(h >>> (depth * 4)) & 15];
    return node?.entries?.find(([k]) => k === key)?.[1];
  }
  has(key: string): boolean { return this.get(key) !== undefined; }
  set(key: string, value: V): this { this.replace(key, value); return this; }
  delete(key: string): boolean { const present = this.has(key); if (present) this.replace(key, undefined); return present; }
  private replace(key: string, value: V | undefined): void {
    const prior = this.get(key); if (prior === value) return;
    if (prior === undefined) this.size++; if (value === undefined) this.size--;
    const h = hash(key);
    const update = (node: Tree<V> | undefined, depth: number): Tree<V> => {
      if (depth === 8) return { entries: [...(node?.entries ?? []).filter(([k]) => k !== key), ...(value === undefined ? [] : [[key, value] as const])] };
      const children = node?.children?.slice() ?? []; const index = (h >>> (depth * 4)) & 15;
      children[index] = update(children[index], depth + 1); return { children };
    };
    this.root = update(this.root, 0);
  }
  *[Symbol.iterator](): IterableIterator<[string, V]> {
    function* visit<V>(node: Tree<V>): IterableIterator<[string, V]> {
      for (const [key, value] of node.entries ?? []) yield [key, value];
      for (const child of node.children ?? []) if (child) yield* visit(child);
    }
    yield* visit(this.root);
  }
}
class WalkSet implements Iterable<string> {
  map = new WalkMap<true>();
  get size(): number { return this.map.size; }
  has(key: string): boolean { return this.map.has(key); }
  add(key: string): this { this.map.set(key, true); return this; }
  delete(key: string): boolean { return this.map.delete(key); }
  fork(): WalkSet { const set = new WalkSet(); set.map = this.map.fork(); return set; }
  *[Symbol.iterator](): IterableIterator<string> { for (const [key] of this.map) yield key; }
}
type Roots = readonly { threadId: string; messageId: string }[];
class WalkRoots implements ReadonlyMap<string, Roots> {
  private added = new WalkMap<Roots>(); private additions = 0;
  readonly [Symbol.toStringTag] = "Map";
  private readonly base: ReplayCopyRoots;
  constructor(base: ReplayCopyRoots) { this.base = base; }
  get size(): number { return this.base.size + this.additions; }
  get(id: string): Roots | undefined { return this.added.get(id) ?? this.base.get(id); }
  has(id: string): boolean { return this.added.has(id) || this.base.has(id); }
  set(id: string, roots: Roots): void { if (!this.has(id)) this.additions++; this.added.set(id, roots); }
  fork(): WalkRoots { const child = new WalkRoots(this.base); child.added = this.added.fork(); child.additions = this.additions; return child; }
  sameContents(other: WalkRoots): boolean { return this.base === other.base && this.added.root === other.added.root; }
  *entries(): MapIterator<[string, Roots]> { for (const [id, roots] of this.base) yield [id, this.added.get(id) ?? roots]; for (const [id, roots] of this.added) if (!this.base.has(id)) yield [id, roots]; }
  [Symbol.iterator](): MapIterator<[string, Roots]> { return this.entries(); }
  *keys(): MapIterator<string> { for (const [id] of this) yield id; }
  *values(): MapIterator<Roots> { for (const [, roots] of this) yield roots; }
  forEach(fn: (value: Roots, key: string, map: ReadonlyMap<string, Roots>) => void, self?: unknown): void { for (const [id, roots] of this) fn.call(self, roots, id, this); }
  toJSON() { return {}; } // native Map's JSON shape
}
type Candidate = { id: string; previous?: Candidate };
export interface WalkJournal { undo(): void }
const walks = new WeakMap<SendReplayProof, ReplayWalk>();
export function walkOf(proof: SendReplayProof): ReplayWalk | undefined { return walks.get(proof); }
export function adoptReplayProof(target: SendReplayProof, source: SendReplayProof): void {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
  const walk = walks.get(source); if (walk) walks.set(target, walk);
}
const work = { nodeReads: 0, epochReads: 0, missingProbes: 0, fallbacks: 0 };
export function replayWalkWorkForTest() { return { ...work }; }
export function countReplayFallback(): void { work.fallbacks++; }
let shadow: boolean | undefined;
export function setReplayShadowForTest(on: boolean): void { if (process.env.VITEST) shadow = on; }
export function replayShadowEnabled(): boolean { return Boolean(process.env.VITEST && (shadow ?? process.env.MURAGE_REPLAY_SHADOW === "1")); }
export const replayNodeKey = (thread: string, id: string) => JSON.stringify([thread, id]);
export const REPLAY_EPOCH_SQL = "SELECT revision FROM send_replay_epochs WHERE thread_id=?";
const SOURCE_SQL = "SELECT CASE WHEN json_valid(json) THEN json_extract(json,'$.copyOf') ELSE 'invalid' END AS copy, EXISTS(SELECT 1 FROM send_replay_exclusions WHERE thread_id=?1 AND message_id=?2) AS excluded, (SELECT revision FROM send_replay_epochs WHERE thread_id=?1) AS epoch FROM messages WHERE thread_id=?1 AND id=?2";

type SourcePoints = ReadonlyMap<string, Record<string, SQLOutputValue>>;

export class ReplayWalk {
  epochs = new WalkMap<number>(); checked = new WalkMap<boolean>();
  ancestry = new WalkSet(); touched = new WalkSet(); missing = new WalkSet();
  reachedBy = new WalkMap<number>(); candidateSet = new WalkSet(); excluded = new WalkSet(); impure = new WalkSet();
  // A memo hit is a dependency too. Shared memo owners cannot be independently
  // rewalked, including a transitive hit that skipped the changed descendant.
  private checkedOwner = new WalkMap<string>(); private shared = new WalkSet();
  private candidateNodes = new WalkMap<readonly string[]>(); private candidateAncestry = new WalkMap<readonly string[]>();
  lastRewalkAncestryChanged = false;
  private tail?: Candidate; candidateCount = 0;
  private candidateOrdinals = new WalkMap<number>();
  private idsCache?: readonly string[]; private ancestryCache?: string; private excludedCache?: ReadonlySet<string>;
  readonly copyRoots: WalkRoots;
  readonly threadId: string;
  constructor(threadId: string, copyRoots: ReplayCopyRoots) {
    this.threadId = threadId;
    this.copyRoots = new WalkRoots(copyRoots instanceof WalkRoots ? new Map(copyRoots) : copyRoots);
  }
  /** Exact immutable-root witness, excluding only the separately checked epochs. */
  sameReplayContents(other: ReplayWalk): boolean {
    return this.threadId === other.threadId && this.tail === other.tail
      && this.ancestry.map.root === other.ancestry.map.root
      && this.excluded.map.root === other.excluded.map.root
      && this.candidateSet.map.root === other.candidateSet.map.root
      && this.copyRoots.sameContents(other.copyRoots);
  }
  private touch(thread: string, db: DatabaseSync): void {
    if (!this.epochs.has(thread)) this.epochs.set(thread, this.readEpoch(thread, db));
  }
  readEpoch(thread: string, db: DatabaseSync): number { work.epochReads++; return Number(stmt(db, REPLAY_EPOCH_SQL).get(thread)?.revision ?? 0); }
  get candidates(): readonly string[] {
    if (!this.idsCache) { const ids: string[] = []; for (let node = this.tail; node; node = node.previous) ids.push(node.id); this.idsCache = ids.reverse(); }
    return this.idsCache;
  }
  fork(): ReplayWalk {
    const child = Object.create(ReplayWalk.prototype) as ReplayWalk;
    Object.assign(child, this);
    Object.defineProperty(child, "copyRoots", { value: this.copyRoots.fork(), enumerable: true, writable: true, configurable: true });
    for (const key of ["epochs", "checked", "ancestry", "touched", "missing", "reachedBy", "candidateSet", "excluded", "impure", "checkedOwner", "shared", "candidateNodes", "candidateAncestry", "candidateOrdinals"] as const) (child as any)[key] = this[key].fork();
    return child;
  }
  begin(): WalkJournal {
    const snapshot = this.fork();
    return { undo: () => { Object.assign(this, snapshot); } };
  }
  /** The caller already bounds the prompt window. Read its keyed source and
   * exclusion points together; copied ancestors outside it still use seeks.
   * These rows live only for this synchronous snapshot, never on a retained walk. */
  addAll(messageIds: readonly string[], db: DatabaseSync): void {
    const ids = [...new Set(messageIds)];
    const points: SourcePoints | undefined = ids.length <= 64 ? undefined : new Map(stmt(db, `SELECT c.value AS id,m.id AS present,
      CASE WHEN json_valid(m.json) THEN json_extract(m.json,'$.copyOf') ELSE 'invalid' END AS copy,
      (SELECT revision FROM send_replay_epochs WHERE thread_id=?1) AS epoch,
      EXISTS(SELECT 1 FROM send_replay_exclusions e WHERE e.thread_id=?1 AND e.message_id=c.value) AS excluded
      FROM json_each(?2) c LEFT JOIN messages m ON m.thread_id=?1 AND m.id=c.value`)
      .all(this.threadId, JSON.stringify(ids)).map(row => [String(row.id), row]));
    for (const id of ids) this.addCandidate(id, db, points);
    this.touch(this.threadId, db);
  }
  add(id: string, db: DatabaseSync, _journal?: WalkJournal): boolean {
    return this.addCandidate(id, db);
  }
  private addCandidate(id: string, db: DatabaseSync, points?: SourcePoints): boolean {
    if (this.candidateSet.has(id)) return this.excluded.has(id);
    this.candidateOrdinals.set(id, this.candidateCount);
    this.candidateSet.add(id); this.tail = { id, previous: this.tail }; this.candidateCount++;
    this.idsCache = undefined;
    return this.walk(id, db, points);
  }
  canRewalk(id: string): boolean {
    return this.candidateSet.has(id) && !this.impure.has(id) && !this.shared.has(id)
      && this.reachedBy.get(replayNodeKey(this.threadId, id)) === 1;
  }
  rewalk(id: string, db: DatabaseSync, _journal: WalkJournal): boolean {
    const ancestry = this.candidateAncestry.get(id) ?? [];
    for (const key of this.candidateNodes.get(id) ?? []) {
      this.checked.delete(key); this.checkedOwner.delete(key); this.touched.delete(key); this.missing.delete(key); this.reachedBy.delete(key);
    }
    for (const key of ancestry) this.ancestry.delete(key);
    const excluded = this.walk(id, db);
    const after = this.candidateAncestry.get(id) ?? [];
    this.lastRewalkAncestryChanged = ancestry.length !== after.length || ancestry.some(key => !after.includes(key));
    return excluded;
  }
  private walk(candidate: string, db: DatabaseSync, points?: SourcePoints): boolean {
    const source = stmt(db, SOURCE_SQL), lookup = stmt(db, "SELECT 1 FROM send_replay_exclusions WHERE thread_id=? AND message_id=?");
    const path = new Set<string>(), read = new Set<string>(), ancestry = new Set<string>();
    const addAncestry = (key: string) => { ancestry.add(key); this.ancestry.add(key); };
    this.ancestryCache = undefined; this.excludedCache = undefined;
    const visit = (thread: string, id: string, depth: number, original: boolean, budget: { left: number }): boolean => {
      if (depth > 16 || --budget.left < 0) { this.impure.add(candidate); return true; }
      const key = JSON.stringify([thread, id]);
      if (path.has(key)) { this.impure.add(candidate); return true; }
      const known = this.checked.get(key);
      if (known !== undefined) {
        const owner = this.checkedOwner.get(key);
        if (owner && owner !== candidate) { this.shared.add(owner); this.shared.add(candidate); }
        return known;
      }
      this.touched.add(key); work.nodeReads++;
      if (!read.has(key)) { read.add(key); this.reachedBy.set(key, (this.reachedBy.get(key) ?? 0) + 1); }
      const point = thread === this.threadId ? points?.get(id) : undefined;
      const row = point ? point.present === null ? undefined : point : source.get(thread, id);
      const epochPoint = point ?? row;
      if (epochPoint) {
        if (!this.epochs.has(thread)) this.epochs.set(thread, Number(epochPoint.epoch ?? 0));
      } else this.touch(thread, db);
      if (!row) this.missing.add(key);
      this.checkedOwner.set(key, candidate);
      if (point?.excluded || row?.excluded || !point && !row && lookup?.get(thread, id)) { this.checked.set(key, true); return true; }
      if (!row) return original;
      if (row.copy === null) { this.checked.set(key, false); return false; }
      let copy: MessageCopy;
      try { copy = JSON.parse(String(row.copy)) as MessageCopy; } catch { this.impure.add(candidate); return original; }
      if (!copy || typeof copy.threadId !== "string" || !copy.threadId || !Array.isArray(copy.messageIds) || !copy.messageIds.length || copy.messageIds.length > 256 || copy.messageIds.some(id => typeof id !== "string" || !id)) return true;
      addAncestry(JSON.stringify([thread, id, copy.threadId, copy.messageIds]));
      path.add(key);
      const bad = copy.messageIds.some(root => visit(copy.threadId, root, depth + 1, true, budget));
      path.delete(key); this.checked.set(key, bad); return bad;
    };
    const budget = { left: 256 };
    let bad = visit(this.threadId, candidate, 0, false, budget);
    const roots = this.copyRoots.get(candidate) ?? [];
    if (roots.length > 256) bad = true;
    for (const root of roots.slice(0, 256)) {
      addAncestry(JSON.stringify([this.threadId, candidate, root.threadId, root.messageId]));
      if (visit(root.threadId, root.messageId, 1, true, budget)) bad = true;
    }
    this.candidateNodes.set(candidate, [...read]); this.candidateAncestry.set(candidate, [...ancestry]);
    if (bad) this.excluded.add(candidate); else this.excluded.delete(candidate);
    return bad;
  }
  candidateOrdinal(id: string): number | undefined { return this.candidateOrdinals.get(id); }
  ancestryForCandidate(id: string): readonly string[] { return this.candidateAncestry.get(id) ?? []; }
  orderedEpochs(): [string, number][] { return [...this.epochs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); }
  revision(): number {
    const ordered = this.orderedEpochs();
    return ordered.length === 1 ? ordered[0]![1] : Number.parseInt(createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 12), 16);
  }
  toProof(): SendReplayProof {
    const walk = this;
    const proof: SendReplayProof = { threadId: this.threadId, get messageIds() { return walk.candidates; }, copyRoots: this.copyRoots,
      get revision() { return walk.revision(); }, get epochs() { return walk.orderedEpochs(); },
      get ancestry() { return walk.ancestryCache ??= JSON.stringify([...walk.ancestry].sort()); },
      get excludedIds() { return walk.excludedCache ??= new Set(walk.candidates.filter(id => walk.excluded.has(id))); } };
    walks.set(proof, this); return proof;
  }
  witnessCurrent(db: DatabaseSync): "current" | "changed" {
    // Oversized unretained turn proofs use the exact full comparison instead.
    if (!this.withinCaps()) return "changed";
    for (const [thread, epoch] of this.epochs) if (this.readEpoch(thread, db) !== epoch) return "changed";
    for (const key of this.missing) {
      const [thread, id] = JSON.parse(key); work.missingProbes++;
      if (stmt(db, "SELECT 1 FROM messages WHERE thread_id=? AND id=?").get(thread, id)) return "changed";
    }
    return "current";
  }
  withinCaps(): boolean { return this.epochs.size <= 64 && this.missing.size <= 16 && this.touched.size <= 65_536; }
}
