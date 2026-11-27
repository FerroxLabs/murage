// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Owners: F2 provides the in-memory store; F3 consumes it in lifecycle tests.
import { PHONE_BOT_DEFAULT, type CallRow, type CallScope, type CallStore, type CallWriteOptions, type OnLastReconcileMiss } from "./contracts.ts";
import { callIsLive, callLimit, needsReconcile, nextReconcileMiss, transcriptAt } from "./store.ts";

export class MemoryCallStore implements CallStore {
  private readonly rows = new Map<string, CallRow>();
  private readonly reconcile = new Map<string, { due: number; misses: number }>();
  private readonly bots = new Map<string, boolean>();
  private readonly metadata = new Map([["migrated", "done"]]);
  private readonly now: () => number;
  constructor(now = Date.now) { this.now = now; }

  get(id: string): CallRow | undefined {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  private write(row: CallRow, options?: CallWriteOptions): void {
    const previous = this.reconcile.get(row.id);
    const previousDue = this.rows.get(row.id)?.status === row.status ? previous?.due : undefined;
    const due = !needsReconcile(row) ? null : options?.reconcileDue === undefined ? previousDue ?? this.now() : options.reconcileDue;
    this.rows.set(row.id, row);
    if (due === null) this.reconcile.delete(row.id);
    else this.reconcile.set(row.id, { due, misses: previous?.misses ?? 0 });
  }

  put(row: CallRow): void { this.write(structuredClone(row)); }

  insert(row: CallRow, options?: CallWriteOptions): void {
    if (options?.within) throw new Error("CallStore within requires SQLite");
    if (this.rows.has(row.id)) throw new Error("Call already exists");
    this.write(structuredClone(row), options);
  }

  private copyForUpdate(row: CallRow, previous: CallRow): CallRow {
    return structuredClone({ ...row, revision: previous.revision, assistantId: previous.assistantId,
      createdAt: previous.createdAt, intent: previous.intent, identity: previous.identity });
  }

  update(row: CallRow, options?: CallWriteOptions): boolean {
    const previous = this.rows.get(row.id);
    if (!previous) return false;
    if (options?.within) throw new Error("CallStore within requires SQLite");
    this.write(this.copyForUpdate(row, previous), options);
    return true;
  }

  settle(cancel: CallRow, booking: CallRow, options?: CallWriteOptions): boolean {
    const previousCancel = this.rows.get(cancel.id), previousBooking = this.rows.get(booking.id);
    if (cancel.id === booking.id || !previousCancel || !previousBooking) return false;
    if (options?.within) throw new Error("CallStore within requires SQLite");
    const nextCancel = this.copyForUpdate(cancel, previousCancel), nextBooking = this.copyForUpdate(booking, previousBooking);
    this.write(nextCancel, options);
    this.write(nextBooking);
    return true;
  }

  delete(id: string, options?: CallWriteOptions): boolean {
    if (options?.within && this.rows.has(id)) throw new Error("CallStore within requires SQLite");
    this.reconcile.delete(id);
    return this.rows.delete(id);
  }

  *live(): Iterable<CallRow> {
    for (const row of this.rows.values()) if (callIsLive(row)) yield structuredClone(row);
  }

  *abandoned(scope?: CallScope): Iterable<CallRow> {
    for (const row of this.rows.values()) {
      if ((!scope || (row.botId || undefined) === scope.botId) && row.status === "abandoned" && !row.abandonCancel) yield structuredClone(row);
    }
  }

  *unstopped(scope?: CallScope): Iterable<CallRow> {
    for (const row of this.rows.values()) {
      if ((!scope || (row.botId || undefined) === scope.botId) && row.status === "abandoned"
        && row.abandonCancel !== "confirmed" && row.abandonCancel !== "not_found") yield structuredClone(row);
    }
  }

  private select(predicate: (row: CallRow) => boolean, order: (a: CallRow, b: CallRow) => number, limit: number): CallRow[] {
    return [...this.rows.values()].filter(predicate).sort(order).slice(0, limit).map(row => structuredClone(row));
  }

  recent(limit = 50): CallRow[] {
    return this.select(() => true, (a, b) => b.createdAt - a.createdAt, callLimit(limit, 200));
  }

  private find(predicate: (row: CallRow) => boolean): CallRow | undefined {
    for (const row of this.rows.values()) if (predicate(row)) return structuredClone(row);
  }

  firstUncertain(): CallRow | undefined { return this.find(row => row.status === "uncertain"); }

  duePending(now: number, limit = 8): CallRow[] {
    const due = (row: CallRow) => this.reconcile.get(row.id)?.due ?? Infinity;
    return this.select(row => due(row) <= now, (a, b) => due(a) - due(b), callLimit(limit, 8));
  }

  markReconcileMiss(id: string, now: number, onLastMiss?: OnLastReconcileMiss): void {
    const row = this.get(id);
    if (!row || !needsReconcile(row)) return;
    const misses = (this.reconcile.get(id)?.misses ?? 0) + 1;
    const due = nextReconcileMiss(misses, now);
    delete row.reconcileScan;
    if (due === null) row.abandonCancel = "not_found";
    const terminal = due === null ? onLastMiss?.(row) : undefined;
    if (terminal?.booking) {
      this.settle(row, terminal.booking, terminal);
      return;
    }
    this.update(row, { reconcileDue: due, within: terminal?.within });
    if (due !== null) this.reconcile.set(id, { due, misses });
  }

  revisionLive(revision: number): boolean {
    if (this.meta("migrated") !== "done") throw new Error("migration_incomplete");
    return !!this.find(row => row.revision === revision && callIsLive(row));
  }

  liveByIdentity(botId: string, identity: string): CallRow | undefined {
    return this.find(row => row.botId === botId && row.identity === identity && callIsLive(row));
  }

  byIntent(botId: string, intent: string, identity: string): CallRow | undefined {
    return this.find(row => row.botId === botId && row.intent === intent && row.identity === identity);
  }

  analysisDue(now: number, limit = 8): CallRow[] {
    const due = (row: CallRow) => row.analysisDue ?? Infinity;
    return this.select(row => due(row) <= now, (a, b) => due(a) - due(b), callLimit(limit, 8));
  }

  scheduledOlderThan(revision: number, limit = 50): CallRow[] {
    return this.select(row => row.status === "scheduled" && row.revision < revision,
      (a, b) => a.revision - b.revision, callLimit(limit, 50));
  }

  countScheduledOlderThan(revision: number, cap = 500): number {
    const stop = callLimit(cap, 500) + 1;
    let total = 0;
    for (const row of this.rows.values()) if (row.status === "scheduled" && row.revision < revision && ++total === stop) break;
    return total;
  }

  liveForBot(botId: string, limit = 50, after = ""): CallRow[] { return this.livePage(botId, limit, after); }
  liveLegacy(limit = 50, after = ""): CallRow[] { return this.livePage(undefined, limit, after); }

  private livePage(botId: string | undefined, limit: number, after: string): CallRow[] {
    const compare = (a: CallRow, b: CallRow) => a.id < b.id ? -1 : Number(a.id > b.id);
    return this.select(row => row.botId === botId && row.id > after && callIsLive(row), compare, callLimit(limit, 50));
  }

  transcriptsOlderThan(cutoff: number, limit = 200): CallRow[] {
    const at = (row: CallRow) => transcriptAt(row) ?? Infinity;
    return this.select(row => at(row) < cutoff, (a, b) => at(a) - at(b), callLimit(limit, 200));
  }

  botMayPhone(botId: string): boolean { return this.bots.get(botId) ?? PHONE_BOT_DEFAULT; }
  setBotMayPhone(botId: string, on: boolean): void { this.bots.set(botId, on); }

  meta(key: string): string | undefined { return this.metadata.get(key); }
  setMeta(key: string, value: string): void { this.metadata.set(key, value); }
}
