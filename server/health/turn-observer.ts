// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turn outcomes for Sentinel (1.0.9, GAP-SENTINEL-109 sections 4.1, 4.2 and 5: S06 send fence, S07 exhausted dispatch,
// S08 continuation resets). Observe only: every function is O(1) (a bounded map operation and a counter increment), never
// throws, and never changes the turn it watches. Raw thread and turn ids go in; only the keyed tokens of counters.ts come
// out (noteTurn), and they are never logged.
//
//   observeTurnEvent(event)            the bus's common path for every engine: learns each instance's engine category and
//                                      reports a terminal turn as completed or cancelled (once)
//   turnAccepted(thread, turn, kind)   the engine accepted a dispatch; closes a rebuild interval after a refusal
//   turnRefused(thread, turn, kind)    the send fence refused this turn's prompt (MEMORY_CONTEXT_REVOKED)
//   turnExhausted(thread, turn, kind)  the turn ended with the refusal card: no rebuild left
//   observeReset(thread, instance, reason)  an automatic memory continuation reset (memory/reset-watch.ts)
//
// The thread map holds the logical turn in progress (a direct turn's user message, a room member's turn request) so a
// rebuilt dispatch and its later end are the same turn. It is bounded; an evicted entry only loses its correlation.
import type { EngineKind, ResetReason, TurnFinal } from "../../shared/health-protocol.mjs";
import { HEALTH_LIMITS, toEngineKind } from "../../shared/health-protocol.mjs";
import { deriveStableToken, noteTurn, recordCounter } from "./counters.ts";
import { healthEngineKind } from "./engine-kind.ts";
import { turnStopped, turnSucceeded } from "../turn-outcome.ts";

/** Hidden learning sessions (drivers/cli-memory-learning.ts MEMORY_LEARNING_THREAD_PREFIX) are not owner turns. */
export const LEARNING_THREAD_PREFIX = "memory-learning-";
const INSTANCE_ENTRIES = 256;

interface Current { turn: string; engine: EngineKind; refusedAt: number | null; refusals: number }
const current = new Map<string, Current>();
const engineByInstance = new Map<string, EngineKind>();
let clock: () => number = () => Date.now();

const remember = <K, V>(map: Map<K, V>, key: K, value: V, cap: number) => {
  map.delete(key);
  if (map.size >= cap) map.delete(map.keys().next().value as K);
  map.set(key, value);
};
const kindOf = (driverKind: string | undefined, threadId: string): EngineKind =>
  driverKind ? healthEngineKind(driverKind) : current.get(threadId)?.engine ?? "other";
function track(threadId: string, turn: string, engine: EngineKind): Current {
  const existing = current.get(threadId);
  if (existing && existing.turn === turn) { if (engine !== "other") existing.engine = engine; return existing; }
  const entry: Current = { turn, engine, refusedAt: null, refusals: 0 };
  remember(current, threadId, entry, HEALTH_LIMITS.correlationEntries);
  return entry;
}
function end(threadId: string, entry: Current, final: TurnFinal): void {
  noteTurn(threadId, entry.turn, entry.engine, { final });
  // Keyed by the thread's stable scope token: S07 counts completed turns per engine, S08 per scope (rows beyond the
  // keyed cap fold into the engine's total). A plain completed turn sends no fact (the 16-fact record stays free).
  recordCounter("dispatch-exhausted", final, entry.engine, deriveStableToken("scope", threadId));
  if (entry.refusals > 0 && final === "completed") recordCounter("send-fence", "recovered", entry.engine);
  if (entry.refusals > 0 && final === "cancelled") recordCounter("send-fence", "cancelled", entry.engine);
  if (current.get(threadId) === entry) current.delete(threadId);
}

/** The engine accepted a dispatch of this logical turn. After a refusal, the time since it is the rebuild's duration. */
export function turnAccepted(threadId: string, turn: string, driverKind?: string): void {
  try {
    const entry = track(threadId, turn, kindOf(driverKind, threadId));
    if (entry.refusedAt === null) return;
    const ms = Math.max(0, clock() - entry.refusedAt);
    entry.refusedAt = null;
    noteTurn(threadId, turn, entry.engine, { rebuildMs: ms });
    recordCounter("send-fence", "rebuild", entry.engine, undefined, 1, ms);
  } catch { /* telemetry never changes the operation it observes */ }
}

/** The send fence refused this turn's prompt; a rebuild may follow. Each refusal counts, the turn once. */
export function turnRefused(threadId: string, turn: string, driverKind?: string): void {
  try {
    const entry = track(threadId, turn, kindOf(driverKind, threadId));
    entry.refusals++;
    entry.refusedAt ??= clock();
    noteTurn(threadId, turn, entry.engine, { refusal: 1 });
    recordCounter("send-fence", "refusal", entry.engine);
  } catch { /* telemetry never changes the operation it observes */ }
}

/** The turn ended on the refusal card with no rebuild left: exhausted, once, whatever the refusal log volume was. */
export function turnExhausted(threadId: string, turn: string, driverKind?: string): void {
  try {
    const entry = track(threadId, turn, kindOf(driverKind, threadId));
    entry.refusedAt = null;
    recordCounter("send-fence", "exhausted", entry.engine);
    end(threadId, entry, "exhausted");
  } catch { /* telemetry never changes the operation it observes */ }
}

/** Automatic memory continuation resets only (owner-requested new sessions and engine changes never come through here). */
export function resetReasonOf(reason: string): ResetReason {
  return /^steer-refused\b/.test(reason) ? "send-fence" : "history-rebuild";
}
export function observeReset(threadId: string, instanceId: string, reason: string): void {
  try {
    const known = engineByInstance.get(instanceId);
    const existing = current.get(threadId);
    const engine = known ?? existing?.engine ?? "other";
    // a reset decided before the dispatch is accepted belongs to the turn being set up; with none known it gets its own
    const entry = existing ?? track(threadId, `reset:${clock()}`, engine);
    noteTurn(threadId, entry.turn, engine, { reset: 1 });
    recordCounter("resets", resetReasonOf(reason), engine);
  } catch { /* telemetry never changes the operation it observes */ }
}

type BusEvent = { type: string; threadId: string; provider?: string; providerInstanceId?: string; turnId?: string; ok?: boolean; stopReason?: string | null };
/** Every engine's events pass the bus (harness/bus.ts publish): a terminal turn reports completed or cancelled for the
 *  thread's logical turn. A turn waiting for its rebuild is not ended by its refused dispatch's terminal event, and an
 *  engine failure is no final outcome (the card paths say exhausted). */
export function observeTurnEvent(event: BusEvent): void {
  try {
    if (event.providerInstanceId && event.provider && !engineByInstance.has(event.providerInstanceId)) {
      remember(engineByInstance, event.providerInstanceId, healthEngineKind(event.provider), INSTANCE_ENTRIES);
    }
    if (event.type !== "turn.completed" || typeof event.threadId !== "string" || event.threadId.startsWith(LEARNING_THREAD_PREFIX)) return;
    const terminal = { ok: event.ok === true, stopReason: event.stopReason ?? null };
    const final: TurnFinal | null = turnStopped(terminal) ? "cancelled" : turnSucceeded(terminal) ? "completed" : null;
    const existing = current.get(event.threadId);
    if (existing !== undefined && existing.refusedAt !== null) return;
    if (final === null) { if (existing) current.delete(event.threadId); return; }
    const engine = event.provider ? healthEngineKind(event.provider) : existing?.engine ?? "other";
    end(event.threadId, existing ?? { turn: `turn:${event.threadId}:${event.turnId ?? clock()}`, engine, refusedAt: null, refusals: 0 }, final);
  } catch { /* telemetry never changes the operation it observes */ }
}

/** Test hooks. */
export function resetTurnObserverForTests(now?: () => number): void { current.clear(); engineByInstance.clear(); clock = now ?? (() => Date.now()); }
export const turnObserverSize = (): number => current.size;
export const engineKindForTests = (value: string): EngineKind => toEngineKind(value);
