// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b, pending verdict recovery producer and dispatch consumer.
import type { DatabaseSync } from "node:sqlite";
import { fenceRefusalDiagnosis, pendingFenceCheck, pendingFenceTargets } from "./send-fence.ts";
import { closeWaitedPending, drainRevokeMarkerBounded, noteFenceWaiter, settleRevokesForTurn, wakeMemoryRevocation } from "./memory-revocation.ts";
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
  const waiting = noteFenceWaiter();
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
    waiting();
    try { console.warn(`[memory] pending fence settle outcome=${outcome} ms=${Math.round(performance.now() - started)} probes=${probes} boundMs=${maxMs}`); }
    catch { /* diagnostics never change a refusal or its settlement */ }
  }
}

/** MAIN Q2: the exact wait without foreground work. An input still checking:pending waits only for its own obligation: it never calls
 * drainRevokeMarkerBounded or settleRevokesForTurn, so the global revoke queue stays background work. It only (re)wakes the scheduled
 * runner (which keeps its own admission and pace) so a job that becomes runnable later is picked up. Any other refusal resolves at once.
 * A timeout, Stop, read error or unresolved verdict never authorizes another attempt; durable jobs stay intact. */
export async function awaitExactPendingCheck(db: DatabaseSync, error: unknown, cancelled: () => boolean = () => false,
  maxMs = PENDING_FENCE_WAIT_MS, wake: () => void = () => wakeMemoryRevocation(() => db)): Promise<boolean> {
  if (fenceRefusalDiagnosis(error).refused !== "checking:pending") return true;
  const check = pendingFenceCheck(error), targets = pendingFenceTargets(error);
  const started = performance.now(), deadline = started + maxMs;
  let outcome = "deadline", probes = 0, woke = started;
  const waiting = noteFenceWaiter();
  try {
    if (cancelled()) { outcome = "stopped"; return false; }
    wake();
    for (;;) {
      if (cancelled()) { outcome = "stopped"; return false; }
      if (!db.isTransaction) {
        // option B (1.0.20 closer-n1): this turn's own threads' pending rows close as soon as their revoke has written every mark, ahead of
        // the paced tidy (memory-revocation.ts closeWaitedPending); bounded, never a global drain. The exact check below still decides.
        if (targets) closeWaitedPending(db, targets.threads, targets.scopes);
        const verdict = check?.(db);
        probes++;
        if (verdict && (verdict.state === "shown" || verdict.state === "withheld")) { outcome = verdict.state; return true; }
        if (verdict && verdict.reason !== "pending") { outcome = "unresolved"; return false; }
      }
      const now = performance.now(), left = deadline - now;
      if (left <= 0) return false;
      // An idle runner is not restarted by a job that turns runnable later; wake it again at a coarse pace (never a drain here).
      if (now - woke >= REWAKE_MS) { woke = now; wake(); }
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, deadline - performance.now()))));
    }
  } catch { outcome = "error"; return false; }
  finally {
    waiting();
    try { console.warn(`[memory] pending fence settle outcome=${outcome} ms=${Math.round(performance.now() - started)} probes=${probes} boundMs=${maxMs}`); }
    catch { /* diagnostics never change a refusal or its settlement */ }
  }
}
const REWAKE_MS = 1_000;
