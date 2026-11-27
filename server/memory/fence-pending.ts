// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b, pending verdict recovery producer and dispatch consumer.
import type { DatabaseSync } from "node:sqlite";
import { fenceRefusalDiagnosis, pendingFenceCheck, pendingFenceTargets } from "./send-fence.ts";
import { awaitWindowWake, closeWaitedPending, noteFenceWaiter, settleRevokesForTurn, wakeMemoryRevocation, type WindowLook } from "./memory-revocation.ts";
import { REVOKE_WRITE_WINDOW_MS } from "./revoke-budget.ts";

// A spent writer minute must age out before a retry spends another rebuild.
// Five seconds of margin allow the runnable checker to commit and be observed.
export const PENDING_FENCE_WAIT_MS = REVOKE_WRITE_WINDOW_MS + 5_000;
/** cause 25 (MAIN-RULING local-memory-budget: no local memory check may delay an owner turn): an owner's own turn never waits on a
 * pending check. Its bound is zero: the exact wait reads the verdict once at entry and its window wait is due at once (MEMORY V2 V14,
 * awaitWindowWake: due = now), so a still-pending check sends the turn to its last resort at once; what cannot be fenced stays out and
 * the check stays background work. */
export const OWNER_PENDING_WAIT_MS = 0;

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
 * another attempt with the same unchecked input. Durable jobs stay intact.
 * MEMORY V2 V14: the same wait as awaitExactPendingCheck (the `window` wake); it no longer drains the marker on a poll. */
export async function settleRefusedFence(db: DatabaseSync, error: unknown, cancelled: () => boolean = () => false,
  maxMs = PENDING_FENCE_WAIT_MS, wake: () => void = () => wakeMemoryRevocation(() => db)): Promise<boolean> {
  return waitPendingFence(db, error, cancelled, maxMs, wake, false);
}

/** MAIN Q2: the exact wait without foreground work. An input still checking:pending waits only for its own obligation: it never calls
 * drainRevokeMarkerBounded or settleRevokesForTurn, so the global revoke queue stays background work. Any other refusal resolves at once.
 * A timeout, Stop, read error or unresolved verdict never authorizes another attempt; durable jobs stay intact.
 * MEMORY V2 V14: it waits on the `window` wake (memory-revocation.ts awaitWindowWake): its exact check runs once at entry, then only when
 * a pending row was deleted or the deny generation moved, and once at the 65 s bound. No poll (was a full fence probe every 25 ms and a
 * runner wake every second), no drain, 0 statements while it waits. While it waits the runner has the full ledger and closes this turn's
 * own rows first (noteFenceWaiter with its targets). */
export async function awaitExactPendingCheck(db: DatabaseSync, error: unknown, cancelled: () => boolean = () => false,
  maxMs = PENDING_FENCE_WAIT_MS, wake: () => void = () => wakeMemoryRevocation(() => db)): Promise<boolean> {
  return waitPendingFence(db, error, cancelled, maxMs, wake, true);
}
async function waitPendingFence(db: DatabaseSync, error: unknown, cancelled: () => boolean, maxMs: number, wake: () => void, closer: boolean): Promise<boolean> {
  if (fenceRefusalDiagnosis(error).refused !== "checking:pending") return true;
  const check = pendingFenceCheck(error), targets = closer ? pendingFenceTargets(error) : undefined;
  const started = performance.now();
  let outcome = "deadline", probes = 0;
  const waiting = noteFenceWaiter(targets);
  try {
    if (cancelled()) { outcome = "stopped"; return false; }
    const look = (): WindowLook => {
      // option B (1.0.20 closer-n1): this turn's own threads' pending rows close as soon as their revoke has written every mark, ahead of
      // the paced tidy (memory-revocation.ts closeWaitedPending); bounded, never a global drain. The exact check below still decides.
      if (targets) closeWaitedPending(db, targets.threads, targets.scopes);
      const verdict = check?.(db);
      probes++;
      if (verdict && (verdict.state === "shown" || verdict.state === "withheld")) { outcome = verdict.state; return "done"; }
      if (verdict && verdict.reason !== "pending") { outcome = "unresolved"; return "fail"; }
      return "wait";
    };
    // once at entry (the window may have closed between the refusal and this wait), then the runner is woken and nothing runs until a wake
    if (!db.isTransaction) { const first = look(); if (first !== "wait") return first === "done"; }
    wake();
    // cause25: a zero bound (OWNER_PENDING_WAIT_MS) returns now, after the one look and the runner's wake: no wake cycle, no second look
    if (maxMs <= 0) return false;
    const result = await awaitWindowWake(db, maxMs, look, cancelled);
    if (result === "stopped") outcome = "stopped"; else if (result === "fail" && outcome !== "unresolved") outcome = "error"; else if (result === "deadline") outcome = "deadline";
    return result === "done";
  } catch { outcome = "error"; return false; }
  finally {
    waiting();
    try { console.warn(`[memory] pending fence settle outcome=${outcome} ms=${Math.round(performance.now() - started)} probes=${probes} boundMs=${maxMs}`); }
    catch { /* diagnostics never change a refusal or its settlement */ }
  }
}
