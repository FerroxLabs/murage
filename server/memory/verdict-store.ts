// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 sec. 2 (S1'-S6) + r14.1 X3: the VerdictStore. It owns the four maps whose entries are retained lineage answers
// (verdicts, sessionSound, threadGroupStore, sessionHolds) and their bookkeeping (dependents). Every read goes through a recording
// accessor (an open trace notes the key), every removal through one loss rule (lossOf per watched thread, proofLossOf per bucket, gen for
// anything else), and every clear of a memo on the turn path (root-set handles, partial walks, the chains clears that coincide with them,
// threadForgetsCache) moves handleEpoch; memoEpoch is the r14.1 X3 name of the same counter (r15 epoch split, handle half).
// Pins keep the traced keys of admitted records out of eviction; pinning is a cost aid, never a correctness input: an evicted pinned key
// still moves lossOf. The store judges nothing and reads no database: it is the bookkeeping the warmer's confirm stands on.
//
// It changes nothing a turn does: the maps hold exactly what the module-level maps held, evicted and cleared at the same sites.

/** A cached verdict: withheld or not, whether it was reached past a check that could not finish, and what it rests on. */
export interface Verdict { withheld: boolean; unproven: boolean; deps: Set<string> }
/** Per session, the newest receipt up to which its receipts are proven sound, and the kept verdict that says so. */
export interface SessionProof { upTo: number; key: string }
/** A thread's kept receipt groups (replay-lineage.ts threadGroupStore). `G` is replay-lineage's ReceiptGroup. */
export interface StoredGroups<G = unknown> { count: number; top: number; groups: G[]; at: Map<string, number> }
/** The four retained-answer maps (r14 S1'). */
export type MapName = "verdicts" | "sessionSound" | "threadGroupStore" | "sessionHolds";
export const MAP_NAMES: readonly MapName[] = ["verdicts", "sessionSound", "threadGroupStore", "sessionHolds"];
/** What a lost pinned key asks the warmer to do again (r13 S2): judge one message, prove one session, or re-confirm the thread. */
export type RedoKey = { kind: "m"; message: string } | { kind: "s"; driver: string; session: string } | { kind: "confirm" };
/** owner(map, key), total and fail-closed (r13 S2 + r14 S2). */
export type Owner =
  | { kind: "THREAD"; thread: string; redo: RedoKey }
  | { kind: "PROOF"; bucket: number }
  | { kind: "UNKNOWN" };
/** Why a key went (logged with warmer-caused clears; tests read it). */
export type LossWhy = "evict" | "half-drop" | "fifo" | "dirty" | "forget" | "audience" | "scope" | "consumed" | "replace" | "merge" | "restart"
  | "session-clear" | "stale" | "supersede-refused" | "all-pinned" | string;
/** Why a whole-store clear happened (S4: warmerCausedClears logs the cause). */
export type ClearWhy = "edges" | "keys" | "connection" | "stamp" | "holds" | "test" | string;

/** The keys one confirm pass read, per map, plus the flags the record stamps (r14 1B, S6; r14.1 X3 usedMemos). */
export interface Trace {
  readonly thread: string;
  readonly keys: Record<MapName, Set<string>>;
  /** a memo on the turn path was reached (kept for readers of the r14.1 X3 flag; set together with usedHandles) */
  usedMemos: boolean;
  /** a handle-layer memo was reached (storedHandle/handleFor, chains, threadForgetsCache): W1 then compares handleEpoch */
  usedHandles: boolean;
  /** a continuation hold was read (getHold): W1 then compares the authority stamp */
  holdRead: boolean;
  /** losses of the traced thread raised by the pass itself (Fable r13 L2: recorded, no redo; the round is unclean) */
  ownLosses: number;
  /** T10(r) ruling (lead + MurageMain, 11-07, narrowed after Astra/Fable 4023216b1): the pass's walk reached the dependency-edge bound. It
   * refused there, before any edge-pressure drop (the half drop) or clear: a confirm pass never clears the store. Ordinary capacity
   * eviction of unpinned, non-proof keys may still run in the pass. */
  edgesRefused?: boolean;
}
/** The stamps a clean confirm writes into its record (W1). */
export interface TraceStamps {
  gen: number;
  /** equal to handleEpoch (the r14.1 X3 name) */
  memoEpoch: number;
  handleEpoch: number;
  /** lossOf for the traced thread and every foreign THREAD owner the trace names */
  lossSeen: Record<string, number>;
  /** proofLossOf for every PROOF bucket the trace names */
  proofSeen: Record<number, number>;
  /** THREAD owners other than the traced thread (FOREIGN_MAX is the warmer's) */
  foreign: string[];
  /** distinct threadGroupStore entries named (C-GROUP) */
  groups: string[];
  size: number;
}
/** Store-side counters the confirm reads as deltas (r14 C5'(2), r14.1 X2). */
export interface StoreCounters {
  /** setHold calls */
  holdWrites: number;
  /** a handleFor that did not return a kept handle, or a chains miss */
  handleMisses: number;
  /** a threadForgetsCache miss (r14.1 X3) */
  memoMisses: number;
  /** in-place group merges that appended a receipt (added > 0) */
  merges: number;
  /** remember() calls that reached the write */
  remembers: number;
  /** clears raised while a warmer slice ran (R1 must show 0) */
  warmerCausedClears: number;
  /** clears raised while a confirm pass's trace was open (T10(r): a confirm pass refuses before any clear, so always 0) */
  confirmPassClears: number;
  /** every whole-store clear (gen moves) */
  clears: number;
  /** evictions that found only pinned candidates (the all-pinned guard) */
  allPinned: number;
  /** pinned threadGroupStore entries deleted by the FIFO (T14(c) asserts 0) */
  pinnedGroupDeletes: number;
  /** threadForgetsCache FIFO evictions that found only admitted threads' entries (r15 sec. 4) */
  pinnedEvictions: number;
  /** F8 / r14.1 X6 T10(n4): holds of a THREAD owner evicted for room at the DI:193 site (setHold past max) */
  ownerHoldLoss: number;
  /** T11(g): removals whose key owner() answered UNKNOWN for (each moved gen) */
  unknownOwners: number;
}
/** The counters replay-lineage.ts adds for the confirm (lineageConfirmCounters there): judge misses, Pg full listings, deferredLarge and unfinished. */
export interface ConfirmCounters extends StoreCounters {
  misses: number; listings: number; deferred: number; unfinished: number;
  /** of `unfinished`, the checks left unfinished only because they deferred a set to the proof scheduler (RL deferSet counts both) */
  deferredUnfinished: number;
}
/** Per-map pin budgets (r14 S4, sec. 3): keys pinned at most, per map. Infinity: none. */
export type PinBudgets = Record<MapName, number>;

export const PROOF_BUCKETS = 1024;
/** Redo keys per thread before the overflow flag (re-confirm from scratch). */
export const REDO_MAX = 1024;
/** C-GROUP (sec. 3): distinct threadGroupStore entries pinned by all admitted traces, of THREAD_GROUP_STORE_MAX. */
// Bounded, not dominated: C-GROUP is load-bearing. A clean confirm can name foreign threads' groups (an unkept root set re-judges its foreign
// roots, RL badRoots -> producers -> threadGroups), so ADMIT_MAX does not bound the pins; T14(c) trips it at full scale (Astra/Fable 4023216b1).
export const GROUP_PIN_MAX = 48;
export const THREAD_GROUP_STORE_MAX = 64;
const SEP = "\u001f";

/** fnv1a 32-bit, mod PROOF_BUCKETS. */
export function proofBucket(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) { hash ^= id.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash % PROOF_BUCKETS;
}
function parseArray(text: string): unknown[] | null {
  try { const value = JSON.parse(text) as unknown; return Array.isArray(value) ? value : null; } catch { return null; }
}
/** owner(map, key) (r13 S2 + r14 S2). Thread keys name their thread in their first field; S/R/Q proof keys do not, so they are PROOF(bucket of
 * the set id): R/S keys end with the set id, Q keys with the set id and the chunk end. Anything else is UNKNOWN (gen++). */
export function owner(map: MapName, key: string): Owner {
  if (map === "threadGroupStore") return { kind: "THREAD", thread: key, redo: { kind: "confirm" } };
  if (map === "sessionSound" || map === "sessionHolds") {
    const parts = parseArray(key);
    if (!parts || typeof parts[0] !== "string") return { kind: "UNKNOWN" };
    if (map === "sessionSound" && typeof parts[1] === "string" && typeof parts[2] === "string") return { kind: "THREAD", thread: parts[0], redo: { kind: "s", driver: parts[1], session: parts[2] } };
    if (map === "sessionSound") return { kind: "UNKNOWN" };
    return { kind: "THREAD", thread: parts[0], redo: { kind: "confirm" } };
  }
  if (key.startsWith("[")) {
    const parts = parseArray(key);
    if (parts && parts.length === 2 && typeof parts[0] === "string" && typeof parts[1] === "string") return { kind: "THREAD", thread: parts[0], redo: { kind: "m", message: parts[1] } };
    return { kind: "UNKNOWN" };
  }
  const tag = key.slice(0, 2);
  if (tag === `a${SEP}`) {
    const parts = parseArray(key.slice(2));
    if (parts && typeof parts[0] === "string" && typeof parts[1] === "string" && typeof parts[2] === "string") return { kind: "THREAD", thread: parts[0], redo: { kind: "s", driver: parts[1], session: parts[2] } };
    return { kind: "UNKNOWN" };
  }
  if (tag === `g${SEP}`) {
    const parts = parseArray(key.slice(2));
    if (parts && typeof parts[0] === "string") return { kind: "THREAD", thread: parts[0], redo: { kind: "confirm" } };
    return { kind: "UNKNOWN" };
  }
  if (tag === `R${SEP}` || tag === `S${SEP}`) {
    const id = key.slice(key.lastIndexOf(SEP) + 1);
    return id ? { kind: "PROOF", bucket: proofBucket(id) } : { kind: "UNKNOWN" };
  }
  if (tag === `Q${SEP}`) {
    const parts = key.split(SEP);
    const id = parts.length >= 3 ? parts[parts.length - 2]! : "";
    return id ? { kind: "PROOF", bucket: proofBucket(id) } : { kind: "UNKNOWN" };
  }
  return { kind: "UNKNOWN" };
}
const isQKey = (key: string) => key.startsWith(`Q${SEP}`);
const sameDeps = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(d => b.has(d));
const sameVerdict = (a: Verdict, b: Verdict) => a === b || (a.withheld === b.withheld && a.unproven === b.unproven && sameDeps(a.deps, b.deps));
const emptyKeys = (): Record<MapName, Set<string>> => ({ verdicts: new Set(), sessionSound: new Set(), threadGroupStore: new Set(), sessionHolds: new Set() });
const zeroCounters = (): StoreCounters => ({ holdWrites: 0, handleMisses: 0, memoMisses: 0, merges: 0, remembers: 0, warmerCausedClears: 0, confirmPassClears: 0, clears: 0, allPinned: 0, pinnedGroupDeletes: 0, pinnedEvictions: 0, ownerHoldLoss: 0, unknownOwners: 0 });
/** TURNSTART r14 L1 test hook (L2's surface): one entry per removal through the loss rule, and a "gen" entry per whole-store clear. */
export type StoreLogEntry = { map: MapName; key: string; why: LossWhy; owner: Owner } | { map: "gen"; key: ""; why: ClearWhy };
const UNLIMITED: PinBudgets = { verdicts: Infinity, sessionSound: Infinity, threadGroupStore: Infinity, sessionHolds: Infinity };

/** The reads a judge makes of the kept verdicts (get/has only: a write goes through remember). A plain Map satisfies it (scratch caches). */
export interface VerdictReads { get(key: string): Verdict | undefined; has(key: string): boolean }

export class VerdictStore {
  readonly #verdicts = new Map<string, Verdict>();
  /** store bookkeeping (r14.1 X3 RETAINED): per dependency key, the kept verdicts that consulted it */
  readonly #dependents = new Map<string, Set<string>>();
  readonly #sessionSound = new Map<string, SessionProof>();
  readonly #threadGroupStore = new Map<string, StoredGroups>();
  readonly #sessionHolds = new Map<string, unknown>();
  #gen = 0;
  #handleEpoch = 0;
  readonly #lossOf = new Map<string, number>();
  readonly #watched = new Map<string, number>();
  readonly #proofLossOf = new Uint32Array(PROOF_BUCKETS);
  #trace: Trace | null = null;
  /** key -> refcount, per map */
  readonly #pins: Record<MapName, Map<string, number>> = { verdicts: new Map(), sessionSound: new Map(), threadGroupStore: new Map(), sessionHolds: new Map() };
  /** what each pinning record holds */
  readonly #pinnedBy = new Map<string, Record<MapName, Set<string>>>();
  #budgets: PinBudgets = { ...UNLIMITED };
  readonly #redo = new Map<string, RedoKey[]>();
  readonly #redoOverflow = new Set<string>();
  #counters = zeroCounters();
  #warming = false;
  readonly #clearLog: Array<{ why: ClearWhy; warming: boolean; gen: number }> = [];
  #allPinnedHook: ((map: MapName) => boolean) | null = null;
  /** flagfold F5: verdict key -> its deps (the v-edges it rests on), kept at remember() time, for the C-EDGES closure */
  readonly #restsOn = new Map<string, Set<string>>();
  #verdictLimit = 65536;
  #cGroup = true;
  #cEdges = true;
  /** pinned closure edges per admitted record (C-EDGES) */
  readonly #edgesBy = new Map<string, number>();
  #pinnedEdges = 0;
  #backfill = false;
  #backfillStopped = false;
  #lossHook: ((thread: string) => void) | null = null;
  #logHook: ((entry: StoreLogEntry) => void) | null = null;

  /** The recording view of the verdict map a judge reads (verdictCache() hands it out). */
  readonly verdictReads: VerdictReads = { get: key => this.getVerdict(key), has: key => this.hasVerdict(key) };

  // ---- epochs and loss counters (W1) ----
  gen(): number { return this.#gen; }
  /** r15 epoch split (handle half): handleEpoch moves on every handle-layer clear (RH onHandlesForgotten, RL chains :1986/:1987, per-handle
   * drop :2404, threadForgetsCache :264); memoEpoch is the same counter under its r14.1 X3 name. */
  handleEpoch(): number { return this.#handleEpoch; }
  memoEpoch(): number { return this.#handleEpoch; }
  bumpHandleEpoch(_why = ""): void { this.#handleEpoch++; }
  bumpMemoEpoch(why = ""): void { this.bumpHandleEpoch(why); }
  lossOf(thread: string): number { return this.#lossOf.get(thread) ?? 0; }
  proofLossOf(bucket: number): number { return this.#proofLossOf[bucket] ?? 0; }
  /** Losses of x are counted only while x is watched (refcount: a record's own thread and each foreign thread its trace names). */
  watch(thread: string): void { this.#watched.set(thread, (this.#watched.get(thread) ?? 0) + 1); }
  unwatch(thread: string): void {
    const n = (this.#watched.get(thread) ?? 0) - 1;
    if (n > 0) this.#watched.set(thread, n);
    else { this.#watched.delete(thread); this.#lossOf.delete(thread); this.#redo.delete(thread); this.#redoOverflow.delete(thread); }
  }
  watched(thread: string): boolean { return this.#watched.has(thread); }
  /** Called with the owning thread whenever lossOf moves (the warmer marks the record "confirm due", C8). */
  onLoss(hook: ((thread: string) => void) | null): void { this.#lossHook = hook; }
  /** Tests: told every removal through the loss rule (map, key, why, owner) and every whole-store clear (map "gen"). null removes it. */
  onStoreLog(hook: ((entry: StoreLogEntry) => void) | null): void { this.#logHook = hook; }

  /** The one loss rule (r13 S3, over four maps). A loss of the thread whose confirm pass is open is that pass's own (Fable r13 L2): recorded in
   * the trace, no redo. An unpinned key queues no redo (Fable r13 H1). */
  private loss(map: MapName, key: string, _why: LossWhy): void {
    const who = owner(map, key);
    this.#logHook?.({ map, key, why: _why, owner: who });
    if (who.kind === "UNKNOWN") { this.#counters.unknownOwners++; this.#gen++; return; }
    if (who.kind === "PROOF") { this.#proofLossOf[who.bucket] = (this.#proofLossOf[who.bucket]! + 1) >>> 0; return; }
    const thread = who.thread;
    const ownPass = this.#trace !== null && this.#trace.thread === thread;
    if (ownPass) this.#trace!.ownLosses++;
    if (!this.#watched.has(thread)) return;
    this.#lossOf.set(thread, this.lossOf(thread) + 1);
    const pinned = this.pinned(key, map);
    if (!ownPass) {
      // MUTANT:redo-on-unpinned-eviction
      if (pinned) this.redo(thread, who.redo);
    }
    this.#lossHook?.(thread);
  }
  private redo(thread: string, key: RedoKey): void {
    if (this.#redoOverflow.has(thread)) return; // re-confirm from scratch
    let list = this.#redo.get(thread);
    if (!list) this.#redo.set(thread, list = []);
    if (list.length >= REDO_MAX) { this.#redoOverflow.add(thread); this.#redo.delete(thread); }
    else list.push(key);
  }

  // ---- trace (r14 1B) ----
  openTrace(thread: string): Trace {
    if (this.#trace) throw new Error("VerdictStore: a trace is already open");
    this.#trace = { thread, keys: emptyKeys(), usedMemos: false, usedHandles: false, holdRead: false, ownLosses: 0 };
    return this.#trace;
  }
  closeTrace(): Trace | null { const trace = this.#trace; this.#trace = null; return trace; }
  currentTrace(): Trace | null { return this.#trace; }
  #note(map: MapName, key: string): void { if (this.#trace) this.#trace.keys[map].add(key); }
  /** A handle-layer memo was reached (storedHandle/handleFor, chains.get, threadForgetsCache). */
  noteHandleUse(): void { if (this.#trace) { this.#trace.usedHandles = true; this.#trace.usedMemos = true; } }
  /** r14.1 X3 name, kept. */
  noteMemoUse(): void { this.noteHandleUse(); }
  noteHandleMiss(): void { this.#counters.handleMisses++; }
  noteMemoMiss(): void { this.#counters.memoMisses++; }
  memoMiss(): void { this.noteMemoMiss(); }
  noteRemember(): void { this.#counters.remembers++; }
  /** The stamps W1 compares, read for a closed trace. */
  stampsFor(trace: Trace): TraceStamps {
    const lossSeen: Record<string, number> = { [trace.thread]: this.lossOf(trace.thread) };
    const proofSeen: Record<number, number> = {};
    const foreign = new Set<string>();
    let size = 0;
    for (const map of MAP_NAMES) for (const key of trace.keys[map]) {
      size++;
      const who = owner(map, key);
      if (who.kind === "THREAD") { if (who.thread !== trace.thread) foreign.add(who.thread); lossSeen[who.thread] = this.lossOf(who.thread); }
      else if (who.kind === "PROOF") proofSeen[who.bucket] = this.proofLossOf(who.bucket);
    }
    return { gen: this.#gen, memoEpoch: this.#handleEpoch, handleEpoch: this.#handleEpoch, lossSeen, proofSeen, foreign: [...foreign], groups: [...trace.keys.threadGroupStore], size };
  }

  // ---- verdicts (S1) ----
  getVerdict(key: string): Verdict | undefined { this.#note("verdicts", key); return this.#verdicts.get(key); }
  hasVerdict(key: string): boolean { this.#note("verdicts", key); return this.#verdicts.has(key); }
  /** Unrecorded: the store's own bookkeeping (eviction, the dependency test of remember). */
  peekVerdict(key: string): Verdict | undefined { return this.#verdicts.get(key); }
  verdictCount(): number { return this.#verdicts.size; }
  /** Oldest first, unrecorded (eviction scans). */
  verdictKeys(): IterableIterator<string> { return this.#verdicts.keys(); }
  /** remember()'s write: an existing key with a different value is a changing write (a loss of its owner); the same value is an LRU touch. */
  setVerdict(key: string, entry: Verdict): void {
    const held = this.#verdicts.get(key);
    if (held && !sameVerdict(held, entry)) this.loss("verdicts", key, "replace");
    this.#verdicts.delete(key);
    this.#verdicts.set(key, entry);
    this.#restsOn.set(key, entry.deps);
  }
  /** An eviction for room (or the half drop) keeps the key's edges in the graph, and so its place in the reverse index (C-EDGES closure). */
  loseVerdict(key: string, why: LossWhy): boolean {
    if (!this.#verdicts.delete(key)) return false;
    if (why !== "evict" && why !== "half-drop") this.#restsOn.delete(key);
    this.loss("verdicts", key, why);
    return true;
  }
  /** remember()'s eviction (RL:1610-1618): the oldest eighth that is not a proof goes; only a cache of proofs gives a proof up. Pinned keys are
   * skipped (S4); a scan that finds only pinned candidates asks the all-pinned guard, then proceeds without the skip. */
  evictVerdicts(limit: number, isProof: (key: string) => boolean): void {
    const pick = (skipPins: boolean): string[] => {
      const oldest: string[] = [], proofs: string[] = [];
      for (const key of this.#verdicts.keys()) {
        // MUTANT:no-pinning
        if (skipPins) { if (this.pinned(key)) continue; }
        if (isProof(key)) { if (proofs.length < limit / 8) proofs.push(key); continue; }
        oldest.push(key); if (oldest.length >= limit / 8) break;
      }
      return oldest.length ? oldest : proofs;
    };
    let victims = pick(true);
    if (!victims.length && this.#verdicts.size) { this.#allPinned("verdicts"); victims = pick(true); if (!victims.length) victims = pick(false); }
    for (const key of victims) this.loseVerdict(key, "evict");
  }
  /** Drops reverse-index entries no kept verdict needs (collectDependents' `needed`). */
  pruneRestsOn(needed: ReadonlySet<string>): void { for (const key of [...this.#restsOn.keys()]) if (!needed.has(key)) this.#restsOn.delete(key); }
  /** r14.1 X4 + flagfold F5: the dependency entries of the RETAINED CLOSURE of a trace's verdict keys, walked through the reverse index (key ->
   * its deps, v-edges followed, predecessors kept after a Q -> S supersede included), counted up to `cap` (returns at most cap + 1). */
  closureEdges(trace: Trace, cap: number): number {
    const seen = new Set<string>(), queue = [...trace.keys.verdicts];
    let count = 0;
    while (queue.length) {
      const key = queue.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const deps = this.#restsOn.get(key);
      if (!deps) continue;
      count += deps.size;
      if (count > cap) return cap + 1;
      for (const d of deps) if (d.startsWith(`v${SEP}`)) queue.push(d.slice(2));
    }
    return count;
  }
  /** r15.1 Y1/Y5, for lineage-warm.ts's noteTouchesTrace: the traced keys that rest on dependency key `d` (a pending dirty row's key, e.g.
   * `m␟<thread>␟<id>` or `s␟<source id>`, RL:1786-1788, :1847-1848), found the way replay-lineage.ts's dropDependents would drop them: the
   * dependents index by dependency key, then the v-edges upward (an evicted verdict passes a change on as a kept one does). A traced key of any
   * map equal to `d` counts as well. Read-only and unrecorded. Bounded: past `cap` visited keys it stops with `over` true, which the caller
   * must treat as touching (fail closed). One call per pending row. */
  traceKeysDependingOn(trace: Trace, d: string, cap = 4096): { keys: string[]; over: boolean } {
    const keys: string[] = [];
    for (const map of MAP_NAMES) if (trace.keys[map].has(d)) { keys.push(d); break; }
    const seen = new Set<string>(), queue = [d];
    while (queue.length) {
      const held = this.#dependents.get(queue.pop()!);
      if (!held) continue;
      for (const key of held) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > cap) return { keys, over: true };
        if (trace.keys.verdicts.has(key)) keys.push(key);
        queue.push(`v${SEP}${key}`);
      }
    }
    return { keys, over: false };
  }
  /** Whether dependency key `d` touches the trace (any traced key rests on it, or the walk went past `cap`). */
  touchesTrace(trace: Trace, d: string, cap = 4096): boolean {
    const { keys, over } = this.traceKeysDependingOn(trace, d, cap);
    return over || keys.length > 0;
  }
  /** Q -> next (RL:2728): the old partial is carried by the new key; uncounted only when old is Q and new is present (r14 T11(c)). */
  supersede(oldKey: string, newKey: string): void {
    if (!this.#verdicts.has(oldKey)) return;
    if (isQKey(oldKey) && this.#verdicts.has(newKey)) { this.#verdicts.delete(oldKey); return; }
    // refused (T11(c)): the old verdict stays and nothing is counted (no removal happened)
  }

  // ---- dependents (store bookkeeping; C-EDGES reads it) ----
  dependentsOf(d: string): Set<string> | undefined { return this.#dependents.get(d); }
  addDependent(d: string, key: string): void { let held = this.#dependents.get(d); if (!held) this.#dependents.set(d, held = new Set()); held.add(key); }
  deleteDependentsOf(d: string): void { this.#dependents.delete(d); }
  dependentsCount(): number { return this.#dependents.size; }
  dependentEntries(): IterableIterator<[string, Set<string>]> { return this.#dependents.entries(); }

  // ---- sessionSound ----
  getSession(key: string): SessionProof | undefined { this.#note("sessionSound", key); return this.#sessionSound.get(key); }
  setSession(key: string, proof: SessionProof): void {
    const held = this.#sessionSound.get(key);
    if (held && (held.upTo !== proof.upTo || held.key !== proof.key)) this.loss("sessionSound", key, "replace");
    this.#sessionSound.set(key, proof);
  }
  loseSession(key: string, why: LossWhy): void { if (this.#sessionSound.delete(key)) this.loss("sessionSound", key, why); }
  sessionCount(): number { return this.#sessionSound.size; }
  /** RL:717 at 4096: every unpinned entry goes, each a counted loss (the tip cleared the map; pinned entries stay, S4). */
  clearSessions(why: LossWhy): void {
    for (const key of [...this.#sessionSound.keys()]) if (!this.#pins.sessionSound.has(key)) this.loseSession(key, why);
    if (this.#sessionSound.size > 4096 && this.#allPinned("sessionSound")) for (const key of [...this.#sessionSound.keys()]) this.loseSession(key, "all-pinned");
  }

  // ---- threadGroupStore ----
  getGroups<G>(thread: string): StoredGroups<G> | undefined { this.#note("threadGroupStore", thread); return this.#threadGroupStore.get(thread) as StoredGroups<G> | undefined; }
  setGroups<G>(thread: string, groups: StoredGroups<G>): void {
    if (this.#threadGroupStore.has(thread)) this.loss("threadGroupStore", thread, "replace");
    this.#threadGroupStore.set(thread, groups as StoredGroups);
  }
  /** The in-place merge (RL:1724-1735): appending a receipt is a changing write. */
  noteGroupMerge(thread: string, added: number): void {
    if (added <= 0) return;
    this.#counters.merges++;
    this.loss("threadGroupStore", thread, "merge");
  }
  loseGroups(thread: string, why: LossWhy): void { if (this.#threadGroupStore.delete(thread)) this.loss("threadGroupStore", thread, why); }
  groupCount(): number { return this.#threadGroupStore.size; }
  /** RL:1749: the oldest UNPINNED entry goes (S4); only pinned: the all-pinned guard, then the oldest. */
  evictOldestGroup(): void {
    for (const thread of this.#threadGroupStore.keys()) if (!this.#pins.threadGroupStore.has(thread)) { this.loseGroups(thread, "fifo"); return; }
    if (!this.#threadGroupStore.size) return;
    this.#allPinned("threadGroupStore");
    for (const thread of this.#threadGroupStore.keys()) if (!this.#pins.threadGroupStore.has(thread)) { this.loseGroups(thread, "fifo"); return; }
    const oldest = this.#threadGroupStore.keys().next().value!;
    this.#counters.pinnedGroupDeletes++;
    this.loseGroups(oldest, "all-pinned");
  }

  // ---- sessionHolds (r14 S1', moved from disclosures.ts) ----
  getHold<H>(key: string): H | undefined {
    this.#note("sessionHolds", key);
    const hold = this.#sessionHolds.get(key) as H | undefined;
    if (hold !== undefined && this.#trace) this.#trace.holdRead = true;
    return hold;
  }
  /** DI:150 delete+set of the SAME object: an LRU move, counts nothing. */
  touchHold(key: string): void { const hold = this.#sessionHolds.get(key); if (hold === undefined) return; this.#sessionHolds.delete(key); this.#sessionHolds.set(key, hold); }
  loseHold(key: string, why: LossWhy): void { if (this.#sessionHolds.delete(key)) this.loss("sessionHolds", key, why); }
  /** DI:193-195: past `max` the oldest UNPINNED hold goes (a counted loss of its owner); over a present key it is a changing write. */
  setHold<H>(key: string, hold: H, max: number): void {
    this.#counters.holdWrites++;
    if (this.#sessionHolds.has(key)) this.loseHold(key, "replace");
    if (this.#sessionHolds.size >= max) {
      const unpinned = (): string | undefined => { for (const held of this.#sessionHolds.keys()) if (!this.pinned(held, "sessionHolds")) return held; return undefined; };
      let victim = unpinned();
      if (victim === undefined) { this.#allPinned("sessionHolds"); victim = unpinned() ?? this.#sessionHolds.keys().next().value; }
      if (victim !== undefined) {
        this.#sessionHolds.delete(victim);
        if (owner("sessionHolds", victim).kind === "THREAD") this.#counters.ownerHoldLoss++;
        // MUTANT:hold-evict-uncounted
        this.loss("sessionHolds", victim, "evict");
      }
    }
    this.#sessionHolds.set(key, hold);
  }
  holdCount(): number { return this.#sessionHolds.size; }
  /** DI:201 (connection close, test hook): every hold goes at once, gen++. */
  resetSessionHolds(): void { this.#sessionHolds.clear(); this.#clear("holds"); }

  // ---- whole-store clear (forgetVerdicts RL:1688) ----
  /** verdicts, dependents, sessionSound and threadGroupStore go at once (gen++); holds stay (they rest on the connection, DI:201). */
  clearLineage(why: ClearWhy): void {
    this.#verdicts.clear(); this.#dependents.clear(); this.#sessionSound.clear(); this.#threadGroupStore.clear(); this.#restsOn.clear();
    this.#clear(why);
  }
  #clear(why: ClearWhy): void {
    this.#gen++; this.#counters.clears++;
    if (this.#trace) this.#counters.confirmPassClears++;
    this.#logHook?.({ map: "gen", key: "", why });
    if (this.#warming) {
      this.#counters.warmerCausedClears++;
      console.warn(`[memory] lineage store cleared inside a warmer slice (${why})`);
    }
    this.#clearLog.push({ why, warming: this.#warming, gen: this.#gen });
    if (this.#clearLog.length > 32) this.#clearLog.shift();
  }
  clearLog(): ReadonlyArray<{ why: ClearWhy; warming: boolean; gen: number }> { return this.#clearLog; }
  /** The warmer marks its slices (RL:2865 warming): a clear raised inside one is counted as warmer-caused (S4). */
  setWarming(on: boolean): void { this.#warming = on; }
  warming(): boolean { return this.#warming; }

  // ---- pins (S4) ----
  /** Pins a record's traced keys (refcount). Refused (false, nothing pinned) when any map's budget would be crossed. */
  pin(record: string, trace: Trace): boolean {
    this.unpin(record);
    for (const map of MAP_NAMES) {
      let fresh = 0;
      for (const key of trace.keys[map]) if (!this.#pins[map].has(key)) fresh++;
      if (this.#pins[map].size + fresh > this.#budgets[map]) return false;
    }
    const held = emptyKeys();
    for (const map of MAP_NAMES) for (const key of trace.keys[map]) { held[map].add(key); this.#pins[map].set(key, (this.#pins[map].get(key) ?? 0) + 1); }
    this.#pinnedBy.set(record, held);
    return true;
  }
  /** Admission at a clean confirm (sec. 3 C-BUDGET, C-GROUP, C-EDGES; r14.1 X4 closure). Re-admitting a record replaces its pins. Refused: nothing
   * is pinned for it and the reason is returned; the warmer demotes less recently sent records and asks again, or reads "checking: not kept"
   * (or OVERSIZE when the trace alone is over: closureEdges(trace, WARM_EDGES) > WARM_EDGES). */
  admit(record: string, trace: Trace): "ok" | "budget" | "group" | "edges" {
    this.unpin(record);
    const WARM_BUDGET = this.#verdictLimit / 2, WARM_EDGES = this.#verdictLimit * 4;
    let freshKeys = 0;
    for (const key of trace.keys.verdicts) if (!this.#pins.verdicts.has(key)) freshKeys++;
    if (this.#pins.verdicts.size + freshKeys > WARM_BUDGET) return "budget";
    {
      const groupPins = this.#pins.threadGroupStore.size;
      let add = 0;
      for (const thread of trace.keys.threadGroupStore) if (!this.#pins.threadGroupStore.has(thread)) add++;
      // MUTANT:no-c-group
      if (this.#cGroup && groupPins + add > GROUP_PIN_MAX) return "group";
    }
    const edges = this.#pinnedEdges, add = this.closureEdges(trace, WARM_EDGES);
    // MUTANT:no-c-edges
    if (this.#cEdges && edges + add > WARM_EDGES) return "edges";
    if (!this.pin(record, trace)) return "budget";
    this.#edgesBy.set(record, add); this.#pinnedEdges += add;
    return "ok";
  }
  setVerdictLimit(limit: number): void { this.#verdictLimit = limit; }
  verdictLimit(): number { return this.#verdictLimit; }
  /** C-EDGES on (the default; T10(r) turns it off through setAdmissionChecks). */
  cEdgesOn(): boolean { return this.#cEdges; }
  /** Test surface (T10(r), T14(c)): turn the C-GROUP / C-EDGES checks off; null or an undefined field restores it. */
  setAdmissionChecks(checks: { cGroup?: boolean; cEdges?: boolean } | null): void { this.#cGroup = checks?.cGroup ?? true; this.#cEdges = checks?.cEdges ?? true; }
  unpin(record: string): void {
    const edges = this.#edgesBy.get(record);
    if (edges !== undefined) { this.#edgesBy.delete(record); this.#pinnedEdges -= edges; }
    const held = this.#pinnedBy.get(record);
    if (!held) return;
    this.#pinnedBy.delete(record);
    for (const map of MAP_NAMES) for (const key of held[map]) {
      const n = (this.#pins[map].get(key) ?? 0) - 1;
      if (n > 0) this.#pins[map].set(key, n); else this.#pins[map].delete(key);
    }
  }
  isPinned(map: MapName, key: string): boolean { return this.#pins[map].has(key); }
  pinned(key: string, map: MapName = "verdicts"): boolean { return this.#pins[map].has(key); }
  /** Whether an admitted record (keyed by its thread) holds pins. */
  recordPinned(record: string): boolean { return this.#pinnedBy.has(record); }
  notePinnedEviction(): void { this.#counters.pinnedEvictions++; }

  // ---- C7 backfill growth-site guards (r14.1 X4, flagfold F7) ----
  /** The warmer's backfill marks its slices; every growth site then refuses a write that would cross the C7 threshold, and the slice ends. */
  setBackfill(on: boolean): void { this.#backfill = on; if (on) this.#backfillStopped = false; }
  backfillStopped(): boolean { return this.#backfillStopped; }
  /** Whether a write at `site` is refused (only while a backfill slice runs). `used`/`max` are the handle cache's (RH) size and capacity. */
  backfillRefuses(site: MapName | "dependents" | "handles", used = 0, max = Infinity): boolean {
    if (!this.#backfill) return false;
    const limit = this.#verdictLimit;
    const over =
      site === "verdicts" ? this.#verdicts.size + 1 >= limit / 2 :
      site === "dependents" ? this.#dependents.size >= limit * 6 :
      site === "sessionSound" ? this.#sessionSound.size + 1 >= 2048 :
      site === "threadGroupStore" ? this.#threadGroupStore.size + 1 >= THREAD_GROUP_STORE_MAX - GROUP_PIN_MAX :
      site === "sessionHolds" ? true :
      used + 1 >= max / 2;
    if (over) this.#backfillStopped = true;
    return over;
  }
  pinnedCount(map: MapName): number { return this.#pins[map].size; }
  /** Tests (T14(c) direct admit): the closure edges an admitted record holds pinned; undefined when it holds none. */
  edgesPinnedForTest(record: string): number | undefined { return this.#edgesBy.get(record); }
  pinnedRecords(map?: MapName): string[] { return [...this.#pinnedBy].filter(([, held]) => !map || held[map].size > 0).map(([record]) => record); }
  setPinBudgets(budgets: Partial<PinBudgets> | null): void { this.#budgets = budgets ? { ...this.#budgets, ...budgets } : { ...UNLIMITED }; }
  pinBudgets(): Readonly<PinBudgets> { return this.#budgets; }
  /** The all-pinned guard: the warmer demotes the least recently sent record pinning in `map` and returns true; no hook: false. */
  onAllPinned(hook: ((map: MapName) => boolean) | null): void { this.#allPinnedHook = hook; }
  #allPinned(map: MapName): boolean { this.#counters.allPinned++; return this.#allPinnedHook?.(map) ?? false; }
  /** For remember()'s eviction (RL:1610-1618) and the half drop (RL:1628): call when a scan found only pinned candidates. */
  allPinned(map: MapName): boolean { return this.#allPinned(map); }

  // ---- redo ----
  redoOf(thread: string): readonly RedoKey[] { return this.#redo.get(thread) ?? []; }
  takeRedo(thread: string): RedoKey[] { const list = this.#redo.get(thread) ?? []; this.#redo.delete(thread); return list; }
  redoOverflow(thread: string): boolean { return this.#redoOverflow.has(thread); }
  clearRedoOverflow(thread: string): void { this.#redoOverflow.delete(thread); }

  // ---- counters ----
  counters(): StoreCounters { return { ...this.#counters }; }

  /** Tests: the store as at process start (pins, watches, counters and epochs included). */
  resetForTest(): void {
    this.#verdicts.clear(); this.#dependents.clear(); this.#sessionSound.clear(); this.#threadGroupStore.clear(); this.#sessionHolds.clear();
    this.#lossOf.clear(); this.#watched.clear(); this.#proofLossOf.fill(0); this.#trace = null;
    for (const map of MAP_NAMES) this.#pins[map].clear();
    this.#pinnedBy.clear(); this.#budgets = { ...UNLIMITED }; this.#redo.clear(); this.#redoOverflow.clear();
    this.#counters = zeroCounters(); this.#warming = false; this.#clearLog.length = 0; this.#gen++;
    this.#restsOn.clear(); this.#edgesBy.clear(); this.#pinnedEdges = 0; this.#cGroup = true; this.#cEdges = true; this.#backfill = false; this.#backfillStopped = false;
  }
}

/** The process's one store. */
export const verdictStore = new VerdictStore();
/** r14 S6 / r15 epoch split: every handle-layer clear site calls this (RL:264, :1986, :1987, :2404; RH:139/:211/:498 via onHandlesForgotten). */
export function bumpHandleEpoch(why = ""): void { verdictStore.bumpHandleEpoch(why); }
export const bumpMemoEpoch = bumpHandleEpoch;
export function memoEpoch(): number { return verdictStore.memoEpoch(); }
export function handleEpoch(): number { return verdictStore.handleEpoch(); }
