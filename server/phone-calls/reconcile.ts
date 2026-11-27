// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Owners: F2 provides reconciliation; F3 calls it from the service.
import type { CallRow, CallStore, CallWriteOptions, OnLastReconcileMiss, ShippedCallStore } from "./contracts.ts";
import { needsReconcile } from "./store.ts";
import type { PhoneAdapter, ProjectedCall } from "./vapi-adapter.ts";

interface ShippedReconcileDeps {
  rows: Pick<ShippedCallStore, "abandoned" | "get" | "put">;
  adapter: Pick<PhoneAdapter, "reconcile" | "cancel">;
}

/** The adapter need not support cancellation. Stop waiting at the owner deadline and
 * discard its late answer before any caller can change rows or revision bookkeeping. */
export async function ownerRequest<T>(request: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request();
  signal.throwIfAborted();
  let abort!: () => void;
  const expired = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const value = await Promise.race([request(), expired]);
    signal.throwIfAborted();
    return value;
  } finally { signal.removeEventListener("abort", abort); }
}

/** Retry discovery on owner refresh and tool access, including after reopening durable storage.
 * Claim the DELETE durably before awaiting it: a lost DELETE response must never cause a second send.
 * Only reconcile(operation id) may identify an abandoned call; a late create response is not enough.
 */
export async function reconcileAbandonedLegacy(deps: ShippedReconcileDeps, signal?: AbortSignal,
  candidates = deps.rows.abandoned()): Promise<void> {
  for (const previous of candidates) {
    if (signal?.aborted) return;
    if (previous.abandonCancel) continue;
    try {
      const found = previous.vendorId ? { vendorId: previous.vendorId } : await ownerRequest(() => deps.adapter.reconcile?.(previous.id), signal);
      const row = deps.rows.get(previous.id);
      if (!found?.vendorId || !row || row.status !== "abandoned" || row.abandonCancel) continue;
      row.vendorId = found.vendorId;
      row.abandonCancel = "attempted";
      deps.rows.put(row);
      try { await ownerRequest(() => deps.adapter.cancel(found.vendorId), signal); row.abandonCancel = "confirmed"; }
      catch { if (signal?.aborted) return; row.abandonCancel = "failed"; }
      deps.rows.put(row);
    } catch { /* Discovery remains pending; a persisted attempt is never repeated. */ }
  }
}

export interface ReconcileDeps {
  rows: Pick<CallStore, "get" | "update" | "duePending" | "markReconcileMiss" | "analysisDue">;
  adapter: Pick<PhoneAdapter, "reconcilePage" | "cancel">;
  now?: () => number;
  onLastMiss?: OnLastReconcileMiss;
  adoptUncertain?: (row: CallRow, call: ProjectedCall) => void;
  refreshAnalysis?: (row: CallRow, signal?: AbortSignal) => Promise<void>;
  write?: (row: CallRow, options?: CallWriteOptions) => boolean;
}

const READ_BUDGET = 8;
const RETRY_STEP_MS = 60_000;
const activePasses = new WeakSet<ReconcileDeps["rows"]>();
const activeCalls = new WeakMap<ReconcileDeps["rows"], Set<string>>();

export async function reconcilePending(deps: ReconcileDeps, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || activePasses.has(deps.rows)) return;
  activePasses.add(deps.rows);
  try {
    const now = (deps.now ?? Date.now)();
    const pending = deps.rows.duePending(now, READ_BUDGET);
    for (const row of pending) {
      if (signal?.aborted) return;
      await reconcileOne(deps, row.id, signal);
    }
    const remaining = READ_BUDGET - pending.length;
    if (remaining > 0 && deps.refreshAnalysis) {
      for (const row of deps.rows.analysisDue(now, remaining)) {
        if (signal?.aborted) return;
        try { await deps.refreshAnalysis(row, signal); } catch { /* Still due on the next pass. */ }
      }
    }
  } finally {
    activePasses.delete(deps.rows);
  }
}

/** Shared by the due queue and the service's single uncertain-call check. */
export async function reconcileOne(deps: ReconcileDeps, id: string, signal?: AbortSignal): Promise<void> {
  const { rows, adapter } = deps;
  const row = rows.get(id);
  if (signal?.aborted || !row || !needsReconcile(row)) return;
  const active = activeCalls.get(rows) ?? new Set<string>();
  if (active.has(id)) return;
  active.add(id);
  activeCalls.set(rows, active);
  const now = deps.now ?? Date.now;
  const write = deps.write ?? ((next, options) => rows.update(next, options));
  const sameAttempt = () => {
    const current = rows.get(id);
    if (current && needsReconcile(current) && current.status === row.status && current.vendorId === row.vendorId
      && JSON.stringify(current.reconcileScan) === JSON.stringify(row.reconcileScan)) return current;
  };

  try {
    const stack = typeof row.reconcileScan === "object" ? [...row.reconcileScan.ranges]
      : [[row.createdAt - 300_000, row.createdAt + 900_000] satisfies [number, number]];
    const range = stack.pop();
    if (!range) return;
    const page = row.vendorId && row.status === "abandoned" ? { kind: "found" as const, call: { vendorId: row.vendorId } }
      : await ownerRequest(() => adapter.reconcilePage?.(row.id, range), signal);
    const current = sameAttempt();
    if (!current || !page) return;
    if (page.kind === "found") {
      if (current.status === "uncertain") {
        deps.adoptUncertain?.(current, page.call);
        return;
      }
      await cancelDiscovered(deps, current, page.call.vendorId, write, signal);
      return;
    }

    if (page.kind === "full") {
      const [from, to] = range;
      if (from === to) {
        write({ ...current, reconcileScan: "unpageable" }, { reconcileDue: null });
        return;
      }
      const middle = Math.floor((from + to) / 2);
      stack.push([middle + 1, to], [from, middle]);
    }
    if (stack.length === 0) rows.markReconcileMiss(id, now(), deps.onLastMiss);
    else write({ ...current, reconcileScan: { ranges: stack } }, { reconcileDue: now() + RETRY_STEP_MS });
  } catch {
    // A transport or database failure is not a complete vendor miss.
    if (!signal?.aborted) {
      const current = sameAttempt();
      if (current) {
        try { write(current, { reconcileDue: now() + RETRY_STEP_MS }); } catch { /* Still due on the next pass. */ }
      }
    }
  } finally {
    active.delete(id);
  }
}

async function cancelDiscovered(deps: ReconcileDeps, row: CallRow, vendorId: string,
  write: (row: CallRow, options?: CallWriteOptions) => boolean, signal?: AbortSignal): Promise<void> {
  if (!write({ ...row, vendorId, abandonCancel: "attempted", reconcileScan: undefined })) return;
  let outcome: "confirmed" | "failed" = "confirmed";
  try { await ownerRequest(() => deps.adapter.cancel(vendorId), signal); }
  catch { if (signal?.aborted) return; outcome = "failed"; }
  const current = deps.rows.get(row.id);
  if (current?.status === "abandoned" && current.vendorId === vendorId && current.abandonCancel === "attempted") {
    write({ ...current, abandonCancel: outcome });
  }
}
