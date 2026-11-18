// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b, pending verdict recovery producer and dispatch consumer.
import type { DatabaseSync } from "node:sqlite";
import { fenceRefusalDiagnosis, pendingFenceCheck } from "./send-fence.ts";
import { drainRevokeMarkerBounded, settleRevokesForTurn, wakeMemoryRevocation } from "./memory-revocation.ts";
import { REVOKE_WRITE_WINDOW_MS } from "./revoke-budget.ts";

// A spent writer minute must age out before a retry spends another rebuild.
// Five seconds of margin allow the runnable checker to commit and be observed.
export const PENDING_FENCE_WAIT_MS = REVOKE_WRITE_WINDOW_MS + 5_000;
const POLL_MS = 25;

/** Preserve direct recovery's preparation pause for other refusal kinds. Its
 * global marker result says nothing about that input's verdict; the rebuilt
 * prompt must still be fenced. Pending input always takes the exact wait below,
 * whose failure prevents another rebuild. Rooms never had this legacy pause. */
export async function settleDirectRefusal(db: DatabaseSync, error: unknown, cancelled: () => boolean, wake?: () => void): Promise<boolean> {
  if (fenceRefusalDiagnosis(error).refused === "checking:pending") return settleRefusedFence(db, error, cancelled, undefined, wake);
  await settleRevokesForTurn(db).catch(() => false);
  return !cancelled();
}

/** Wait for this refusal, not global queue emptiness. Only the rebuilt prompt's
 * final fence can authorize a write. A timeout/Stop/read error never authorizes
 * another attempt with the same unchecked input. Durable jobs stay intact. */
export async function settleRefusedFence(db: DatabaseSync, error: unknown, cancelled: () => boolean = () => false,
  maxMs = PENDING_FENCE_WAIT_MS, wake: () => void = () => wakeMemoryRevocation(() => db)): Promise<boolean> {
  if (fenceRefusalDiagnosis(error).refused !== "checking:pending") return true;
  const check = pendingFenceCheck(error);
  const started = performance.now(), deadline = started + maxMs;
  let outcome = "deadline", probes = 0;
  // Resume durable work, including bookkeeping holds; an inline marker drain
  // alone cannot finish those. Keep the runner's existing admission and pace.
  try {
    if (cancelled()) { outcome = "stopped"; return false; }
    wake();
    for (;;) {
      if (cancelled()) { outcome = "stopped"; return false; }
      if (!db.isTransaction) {
        const verdict = check?.(db);
        probes++;
        if (verdict && (verdict.state === "shown" || verdict.state === "withheld")) {
          outcome = verdict.state; return true;
        }
        if (verdict && verdict.reason !== "pending") { outcome = "unresolved"; return false; }
      }
      const left = deadline - performance.now();
      if (left <= 0) return false;
      // The bounded drain observes the same writer budgets as normal turn
      // preparation. Yield even when the global queue is empty: an orphaned
      // obligation must not be mistaken for a completed check.
      if (!db.isTransaction) drainRevokeMarkerBounded(db);
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, deadline - performance.now()))));
    }
  } catch { outcome = "error"; return false; }
  finally {
    try { console.warn(`[memory] pending fence settle outcome=${outcome} ms=${Math.round(performance.now() - started)} probes=${probes} boundMs=${maxMs}`); }
    catch { /* diagnostics never change a refusal or its settlement */ }
  }
}
