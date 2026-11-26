// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import type { StoreChange } from "./store.ts";
import type { RoutineRun } from "./routines.ts";
import { IncrementalRoutineRollup, routineNumberKey, ROUTINE_ROW_LIMIT, ROUTINE_WINDOW_MS, type OrderedRoutineFact } from "./inbox-routine-aggregate.ts";
import { inboxAccessFor, inboxThreads, type InboxRosterStore } from "./inbox-access.ts";
import { inboxProjectionReady, routineRollupInputs, routineRollupCardForSource, type InboxAccess, type InboxRoutineRun } from "./inbox.ts";

interface RunSource { listRuns(): RoutineRun[]; inboxRunOrder?(id: string): number | undefined; inboxLatestRunId?(routineId: string): string | undefined; inboxRunAfter?(id?: string): RoutineRun | undefined }
interface LifecycleStore extends InboxRosterStore {
  firstMessageSince?(threadId: string, at: number): { id: string } | undefined;
  onChange(listener: (change: StoreChange) => void): () => void;
}
const lifecycles = new WeakMap<RunSource, InboxRoutineLifecycle>();

/** Fixed-width ordered membership. Insertion and eviction follow at most 33
 * hexadecimal digits; neither operation sorts or walks the retained runs. */
class RunOrder {
  private root: { children: Map<string, RunOrder["root"]>; id?: string } = { children: new Map() };
  private keys = new Map<string, string>();
  get size() { return this.keys.size; }
  set(id: string, key: string): void {
    this.delete(id);
    this.keys.set(id, key);
    let node = this.root;
    for (const digit of key) {
      let child = node.children.get(digit);
      if (!child) node.children.set(digit, child = { children: new Map() });
      node = child;
    }
    node.id = id;
  }
  delete(id: string): void {
    const key = this.keys.get(id);
    if (!key) return;
    const path = [this.root]; let node = this.root;
    for (const digit of key) { node = node.children.get(digit)!; path.push(node); }
    delete node.id;
    for (let i = key.length - 1; i >= 0; i--) {
      if (path[i + 1]!.children.size || path[i + 1]!.id) break;
      path[i]!.children.delete(key[i]!);
    }
    this.keys.delete(id);
  }
  *entries(): IterableIterator<string> {
    function* walk(node: RunOrder["root"]): IterableIterator<string> {
      if (node.id) yield node.id;
      for (const digit of "0123456789abcdef") { const child = node.children.get(digit); if (child) yield* walk(child); }
    }
    yield* walk(this.root);
  }
  first(): string | undefined {
    if (!this.keys.size) return;
    let node = this.root;
    while (!node.id) for (const digit of "0123456789abcdef") {
      const child = node.children.get(digit); if (child) { node = child; break; }
    }
    return node.id;
  }
  last(): string | undefined {
    if (!this.keys.size) return;
    let node = this.root;
    while (!node.id) for (const digit of "fedcba9876543210") {
      const child = node.children.get(digit);
      if (child) { node = child; break; }
    }
    return node.id;
  }
}

/** The subscription is attached to the manager identity, so independent fake
 * fixtures, restores and a replacement manager cannot share derived state. */
export class InboxRoutineLifecycle {
  readonly aggregate = new IncrementalRoutineRollup();
  ready = false;
  private started = false;
  private readonly records = new Map<string, { run: InboxRoutineRun; position: string; order: string }>();
  private readonly order = new RunOrder();
  private readonly recordsByThread = new Map<string, Set<string>>();
  private readonly startsByRoutine = new Map<string, RunOrder>();
  private readonly latestByRoutine = new Map<string, string>();
  private readonly linkSubscribers = new Map<string, Set<string>>();
  private sequence = 0;
  private access: InboxAccess;
  private readonly cardOrder = new RunOrder();
  private readonly expiryOrder = new RunOrder();
  private expiryScheduled = false;
  private readonly expiredCardOrder = new RunOrder();
  private readonly pendingLinks = new Map<string, SetIterator<string>>();
  private linksScheduled = false;
  private readonly cards = new Map<string, OrderedRoutineFact & { runId?: string }>();
  private readonly cardsByRun = new Map<string, Set<string>>();
  private scopeKey: string;
  private knownThreads: Set<string>;
  /** thread -> anchor time -> first stored message id (q1022). The anchor is
   * a function of the thread's (id, at, storage order) rows only, so it is
   * read once and kept until that thread's rows change. Absence is never
   * kept: an empty thread can be filled without a change event (a legacy
   * transcript is imported on first read). */
  private readonly anchors = new Map<string, Map<number, string>>();
  private anchorCount = 0;
  private readonly db: DatabaseSync;
  private readonly store: LifecycleStore;
  private readonly source: RunSource;
  constructor(db: DatabaseSync, store: LifecycleStore, source: RunSource) {
    this.db = db; this.store = store; this.source = source;
    this.access = inboxAccessFor(store, "companion");
    this.scopeKey = JSON.stringify(this.access.threads);
    this.knownThreads = new Set(inboxThreads(store).map(thread => thread.threadId));
    const weak = new WeakRef(this);
    store.onChange(change => weak.deref()?.onStoreChange(change));
  }
  /** Startup is explicit and idempotent. The caller keeps the legacy answer
   * until this scheduled reconstruction has observed a complete projection. */
  start(): void {
    if (this.started) return;
    this.started = true;
    setImmediate(() => {
      try {
      if (!inboxProjectionReady(this.db)) { this.started = false; return; }
      const runs = this.source.listRuns().slice(0, ROUTINE_ROW_LIMIT);
      for (const run of runs) this.remember(run);
      const inputs = routineRollupInputs(this.db, this.access, [...this.records.values()].map(record => record.run));
      for (const entry of inputs.entries) if (entry.id.startsWith("card:")) this.rememberCard(entry);
      this.aggregate.rebuild(inputs.entries.map(entry => entry.id.startsWith("record:")
        ? { ...entry, position: "1" + this.records.get(entry.id.slice(7))!.order } : entry), Date.now());
      this.ready = true;
      for (const id of this.latestByRoutine.values()) this.refreshRecord(id);
      } catch (error) {
        this.ready = false; this.started = false;
        this.clear();
        console.error("inbox: routine rollup rebuild failed", error);
      }
    });
  }
  private remember(run: RoutineRun): { evicted?: string; id: string } {
    const old = this.records.get(run.id);
    if (old?.run.threadId !== run.threadId && old?.run.threadId) this.linkSubscribers.get(old.run.threadId)?.delete(run.id);
    if (old) this.startsByRoutine.get(old.run.routineId)?.delete(run.id);
    const position = old?.position ?? routineNumberKey(this.source.inboxRunOrder?.(run.id) ?? this.sequence++);
// Match scheduler ordering: numeric coercion, NaN at the oldest end,
    // signed infinities retained as order sentinels. Fact times must be finite.
    const scheduled = +run.scheduledFor, descending = Number.isNaN(scheduled) ? Infinity : -scheduled;
    const order = (descending === Infinity ? "ffffffffffffffff" : descending === -Infinity ? "0000000000000000" : routineNumberKey(descending)) + position;
    if (old?.run.threadId !== run.threadId && old?.run.threadId) this.recordsByThread.get(old.run.threadId)?.delete(run.id);
    if (run.threadId) {
      let ids = this.recordsByThread.get(run.threadId);
      if (!ids) this.recordsByThread.set(run.threadId, ids = new Set());
      ids.add(run.id);
    }
    this.records.set(run.id, { position, order, run: {
      runId: run.id, routineId: run.routineId, routineName: run.routineName, status: run.status,
      at: run.startedAt ?? run.scheduledFor, threadId: run.threadId, error: run.error, attention: run.attention,
    } });
    this.order.set(run.id, order);
    let starts = this.startsByRoutine.get(run.routineId);
    if (!starts) this.startsByRoutine.set(run.routineId, starts = new RunOrder());
    const at = run.startedAt ?? run.scheduledFor;
    if (Number.isFinite(at)) starts.set(run.id, routineNumberKey(-at) + order);
    if (old && old.run.routineId !== run.routineId) this.refreshLatest(old.run.routineId);
    this.refreshLatest(run.routineId);
    if (this.order.size <= ROUTINE_ROW_LIMIT) return { id: run.id };
    const evicted = this.order.last()!;
    this.order.delete(evicted);
    const removed = this.records.get(evicted)!;
    if (removed.run.threadId) this.recordsByThread.get(removed.run.threadId)?.delete(evicted);
    this.records.delete(evicted);
    this.startsByRoutine.get(removed.run.routineId)?.delete(evicted);
    this.refreshLatest(removed.run.routineId);
    return { id: run.id, evicted };
  }
  onRunTerminal(run: RoutineRun): void {
    if (!this.ready) return; // startup reads the manager's authoritative state
    const { evicted } = this.remember(run);
    if (evicted) this.drop(`record:${evicted}`);
    const record = this.records.get(run.id);
    if (record) this.refreshRecord(run.id);
  }
  private forgetAnchors(threadId?: string): void {
    if (threadId === undefined) { this.anchors.clear(); this.anchorCount = 0; return; }
    const kept = this.anchors.get(threadId); if (!kept) return;
    this.anchorCount -= kept.size; this.anchors.delete(threadId);
  }
  /** A run's anchor in its thread: one index walk per (thread, at) until a
   * message of that thread is added, moved or removed (see onStoreChange).
   * Inside an open transaction the store's announcement is still pending
   * while the write is already visible, so nothing is reused or kept there. */
  private anchor(threadId: string, at: number): { id: string } | undefined {
    if (!this.store.firstMessageSince) return undefined;
    if (this.db.isTransaction) return this.store.firstMessageSince(threadId, at);
    const known = this.anchors.get(threadId)?.get(at);
    if (known !== undefined) return { id: known };
    const first = this.store.firstMessageSince(threadId, at);
    if (!first) return undefined;
    // Only a row at or after the time is kept. The fallback (no such row yet: the thread's newest row) moves with every append, and
    // an append the store does not announce (a card it withholds from listeners) would leave it stale; it costs two reads, not sixteen.
    const rowAt = (first as { at?: unknown }).at;
    if (!(typeof rowAt === "number" && rowAt >= at)) return first;
    if (this.anchorCount >= 4096) this.forgetAnchors();
    let kept = this.anchors.get(threadId);
    if (!kept) this.anchors.set(threadId, kept = new Map());
    kept.set(at, first.id); this.anchorCount++;
    return first;
  }
  private clear(): void {
    this.forgetAnchors();
    for (const id of this.records.keys()) this.order.delete(id);
    for (const id of this.cards.keys()) { this.cardOrder.delete(id); this.expiryOrder.delete(id); this.expiredCardOrder.delete(id); }
    this.records.clear(); this.recordsByThread.clear(); this.cards.clear(); this.cardsByRun.clear();
    this.startsByRoutine.clear(); this.latestByRoutine.clear(); this.linkSubscribers.clear();
    this.sequence = 0; this.pendingLinks.clear(); this.aggregate.rebuild([], Date.now(), false);
  }
  onRemove(id: string, routineId?: string): void {
    const record = this.records.get(id); if (!record) { if (routineId) this.refreshLatest(routineId); return; }
    if (record.run.threadId) { this.recordsByThread.get(record.run.threadId)?.delete(id); this.linkSubscribers.get(record.run.threadId)?.delete(id); }
    this.order.delete(id); this.records.delete(id); this.drop(`record:${id}`);
    this.startsByRoutine.get(record.run.routineId)?.delete(id); this.refreshLatest(record.run.routineId);
    const last = this.order.last();
    const replacement = this.source.inboxRunAfter?.(last);
    if (replacement && replacement.id !== id && !this.records.has(replacement.id)) this.onRunTerminal(replacement);
  }
  onReplace(runs: RoutineRun[]): void {
    if (!this.ready) return;
    // Replacement/rollback is an explicit owner/lifecycle boundary.
    this.clear();
    for (const run of runs.slice(0, ROUTINE_ROW_LIMIT)) this.remember(run);
    for (const card of routineRollupInputs(this.db, this.access, []).entries) this.rememberCard(card);
    for (const card of this.cards.values()) this.publish(card);
    for (const id of this.records.keys()) this.refreshRecord(id);
  }
  private expiryPending(): boolean {
    const cutoff = Date.now() - ROUTINE_WINDOW_MS, first = this.expiryOrder.first(), last = this.expiredCardOrder.last();
    return Boolean(first && this.cards.get(first)!.fact.at < cutoff || last && this.cards.get(last)!.fact.at >= cutoff);
  }
  private serviceExpiry(): void {
    const cutoff = Date.now() - ROUTINE_WINDOW_MS;
    for (let count = 0; count < 64; count++) {
      const last = this.expiredCardOrder.last();
      if (last && this.cards.get(last)!.fact.at >= cutoff) {
        const card = this.cards.get(last)!;
        this.expiredCardOrder.delete(last); this.expiryOrder.set(last, routineNumberKey(card.fact.at) + card.position);
        if (card.runId) this.refreshRecord(card.runId);
        continue;
      }
      const id = this.expiryOrder.first(); if (!id) return;
      const card = this.cards.get(id)!; if (card.fact.at >= cutoff) return;
      this.expiryOrder.delete(id); this.expiredCardOrder.set(id, routineNumberKey(card.fact.at) + card.position);
      if (card.runId) this.refreshRecord(card.runId);
    }
    if (this.expiryPending() && !this.expiryScheduled) {
      this.expiryScheduled = true;
      setImmediate(() => {
        this.expiryScheduled = false;
        try { this.serviceExpiry(); } catch (error) { this.ready = false; this.started = false; console.error("inbox: routine expiry update failed", error); }
      });
    }
  }
  private refreshThreadLinks(threadId: string): void {
    this.pendingLinks.set(threadId, (this.linkSubscribers.get(threadId) ?? new Set<string>()).values());
    this.serviceLinks();
  }
  private serviceLinks(): void {
    let remaining = 64;
    for (const [threadId, ids] of this.pendingLinks) {
      while (remaining > 0) {
        const next = ids.next(); if (next.done) { this.pendingLinks.delete(threadId); break; }
        remaining--; if (this.records.has(next.value)) this.refreshRecord(next.value);
      }
      if (!remaining) break;
    }
    if (this.pendingLinks.size && !this.linksScheduled) {
      this.linksScheduled = true;
      setImmediate(() => {
        this.linksScheduled = false;
        try { this.serviceLinks(); } catch (error) { this.ready = false; this.started = false; console.error("inbox: routine link update failed", error); }
      });
    }
  }
  private refreshLatest(routineId: string): void {
    const old = this.latestByRoutine.get(routineId);
    const latest = this.source.inboxLatestRunId ? this.source.inboxLatestRunId(routineId) : this.startsByRoutine.get(routineId)?.first();
    if (old === latest) {
      const thread = latest && this.records.get(latest)?.run.threadId;
      if (thread && latest) { let ids = this.linkSubscribers.get(thread); if (!ids) this.linkSubscribers.set(thread, ids = new Set()); ids.add(latest); }
      return;
    }
    if (old) {
      const thread = this.records.get(old)?.run.threadId;
      if (thread) this.linkSubscribers.get(thread)?.delete(old);
    }
    if (latest) this.latestByRoutine.set(routineId, latest); else this.latestByRoutine.delete(routineId);
    const thread = latest && this.records.get(latest)?.run.threadId;
    if (thread && latest) {
      let ids = this.linkSubscribers.get(thread); if (!ids) this.linkSubscribers.set(thread, ids = new Set()); ids.add(latest);
    }
    if (this.ready) { if (old) this.refreshRecord(old); if (latest) this.refreshRecord(latest); }
  }
  /** View materialisation uses maintained records. Only current-routine
   * anchors are queried; notifications never reconstruct the history. */
  snapshot(): InboxRoutineRun[] {
    this.serviceExpiry();
    return [...this.order.entries()].map(id => {
      const record = this.records.get(id)!.run;
      const first = this.latestByRoutine.get(record.routineId) === id && record.threadId && this.anchor(record.threadId, record.at - 5_000);
      return { ...record, ...(first && record.threadId ? { link: { threadId: record.threadId, messageId: first.id } } : {}) };
    });
  }
  private publish(entry: OrderedRoutineFact): void { this.aggregate.upsert(entry); }
  private drop(id: string): void { this.aggregate.remove(id); }
  private rememberCard(card: OrderedRoutineFact & { runId?: string }): void {
    const previous = this.cards.get(card.id);
    if (previous?.runId && previous.runId !== card.runId) this.cardsByRun.get(previous.runId)?.delete(card.id);
    this.cards.set(card.id, card); this.cardOrder.set(card.id, card.position);
    this.expiredCardOrder.delete(card.id);
    this.expiryOrder.set(card.id, routineNumberKey(card.fact.at) + card.position);
    if (card.runId) {
      let ids = this.cardsByRun.get(card.runId);
      if (!ids) this.cardsByRun.set(card.runId, ids = new Set());
      ids.add(card.id);
    }
  }
  private forgetCard(id: string): void {
    const card = this.cards.get(id); if (!card) return;
    this.cards.delete(id); this.cardOrder.delete(id); this.expiryOrder.delete(id); this.expiredCardOrder.delete(id); this.drop(id);
    if (card.runId) {
      const ids = this.cardsByRun.get(card.runId)!; ids.delete(id);
      if (!ids.size) this.cardsByRun.delete(card.runId);
      this.refreshRecord(card.runId);
    }
  }
  private applyCard(card: OrderedRoutineFact & { runId?: string }): void {
    this.rememberCard(card);
    if (this.cardOrder.size > ROUTINE_ROW_LIMIT) this.forgetCard(this.cardOrder.last()!);
    if (!this.cards.has(card.id)) return;
    this.publish(card);
    if (card.runId) this.refreshRecord(card.runId);
  }
  private refreshRecord(id: string): void {
    this.drop(`record:${id}`);
    const record = this.records.get(id);
    if (!record) return;
    const cutoff = Date.now() - ROUTINE_WINDOW_MS;
    for (const cardId of this.cardsByRun.get(id) ?? []) if (this.cards.get(cardId)!.fact.at >= cutoff) return;
    const first = this.latestByRoutine.get(record.run.routineId) === id && record.run.threadId && this.anchor(record.run.threadId, record.run.at - 5_000);
    const run = { ...record.run, ...(first && record.run.threadId ? { link: { threadId: record.run.threadId, messageId: first.id } } : {}) };
    const inputs = routineRollupInputs(this.db, this.access, [run], false);
    if (inputs.entries[0]) this.publish({ ...inputs.entries[0], position: "1" + record.order });
  }
  private onStoreChange(change: StoreChange): void {
    // Kept anchors follow the store whether or not the rollup is ready.
    if (change.type === "message" || change.type === "thread" || change.type === "thread.deleted") this.forgetAnchors(change.threadId);
    else if (change.type === "message.patch") {
      // A patch rewrites its row in place (same storage position). With the
      // id and the time unchanged the link index is unchanged, so the anchor
      // is too: a streamed edit of a run's own thread costs no index walk.
      const before = change.before, message = change.message;
      if (!before || before === message || before.id !== message.id || !Object.is(before.at, message.at)) this.forgetAnchors(change.threadId);
    } else if (change.type !== "bot" && change.type !== "group" && change.type !== "workroot") this.forgetAnchors();
    if (!this.ready) return;
    if (change.type === "message" || change.type === "message.patch") {
      this.refreshThreadLinks(change.threadId);
      for (const message of [change.message, change.type === "message.patch" ? change.before : undefined]) {
        if (!message || (message.kind !== "routine.run" && message.kind !== "goal.run")) continue;
        const key = JSON.stringify([change.threadId, message.kind, message.routineRun?.runId ?? message.goalRun?.runId ?? message.id]);
        const card = routineRollupCardForSource(this.db, this.access, key);
        if (card) this.applyCard(card);
        else this.forgetCard(`card:${change.threadId}:${message.id}`);
      }
      return;
    }
    if (change.type === "thread") return;
    const access = inboxAccessFor(this.store, "companion"), key = JSON.stringify(access.threads);
    const known = this.knownThreads;
    this.knownThreads = new Set(inboxThreads(this.store).map(thread => thread.threadId));
    if (key === this.scopeKey) return;
    const previous = new Set(this.access.threads.map(thread => thread.threadId));
    const next = new Set(access.threads.map(thread => thread.threadId));
    this.access = access; this.scopeKey = key;
    let removed = false;
    // A newly made task has no historical members. Visibility changes to an
    // existing task touch only that task's sources, never all run records.
    for (const id of previous) if (!next.has(id)) {
      removed = true;
      for (const runId of this.recordsByThread.get(id) ?? []) this.refreshRecord(runId);
    }
    for (const thread of access.threads) if (!previous.has(thread.threadId)) {
      for (const runId of this.recordsByThread.get(thread.threadId) ?? []) this.refreshRecord(runId);
      // A brand-new task is populated by its message deltas. Only revealing
      // a previously existing task needs the owner-operation history input.
      if (known.has(thread.threadId)) for (const card of routineRollupInputs(this.db, { ...access, threads: [thread] }, []).entries) this.applyCard(card);
    }
    // Removing an existing conversation is an explicit owner operation. It
    // may expose older card rows at the cap; refresh the capped card input.
    if (removed) {
      const inputs = routineRollupInputs(this.db, access, []);
      const keep = new Set(inputs.entries.map(entry => entry.id));
      for (const id of this.cards.keys()) if (!keep.has(id)) this.forgetCard(id);
      for (const card of inputs.entries) this.applyCard(card);
    }
  }

  badgeAccess(legacy: () => InboxRoutineRun[]): InboxAccess {
    this.start();
    if (this.ready) this.serviceExpiry();
    return this.ready ? { ...inboxAccessFor(this.store, "companion"), routineRollup: this.aggregate, routinePreparing: this.expiryPending() }
      : { ...inboxAccessFor(this.store, "companion"), routineRuns: legacy() };
  }
}

/** Single scheduler call site. All emitted states are accepted: a waiting
 * result can resume and recover, and must not leave a stale failure behind. */
export function onRunTerminal(run: RoutineRun, source: RunSource): void {
  lifecycles.get(source)?.onRunTerminal(run);
}

export function inboxRollupBadgeAccess(db: DatabaseSync, store: LifecycleStore, source: RunSource | null, legacy: () => InboxRoutineRun[]): InboxAccess {
  if (!source) return { ...inboxAccessFor(store, "companion"), routineRuns: legacy() };
  let lifecycle = lifecycles.get(source);
  if (!lifecycle) lifecycles.set(source, lifecycle = new InboxRoutineLifecycle(db, store, source));
  return lifecycle.badgeAccess(legacy);
}

export function inboxRoutineLifecycle(source: RunSource): InboxRoutineLifecycle | undefined { return lifecycles.get(source); }

export function onRunRemoved(id: string, source: RunSource, routineId?: string): void { lifecycles.get(source)?.onRemove(id, routineId); }
export function onRunsReplaced(runs: RoutineRun[], source: RunSource): void { lifecycles.get(source)?.onReplace(runs); }

export function inboxRoutineRecords(db: DatabaseSync, store: LifecycleStore, source: RunSource | null, legacy: () => InboxRoutineRun[]): InboxRoutineRun[] {
  if (!source) return legacy();
  let lifecycle = lifecycles.get(source);
  if (!lifecycle) lifecycles.set(source, lifecycle = new InboxRoutineLifecycle(db, store, source));
  lifecycle.start();
  return lifecycle.ready ? lifecycle.snapshot() : legacy();
}
