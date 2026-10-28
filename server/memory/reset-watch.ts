// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A memory continuation reset ends a warm engine session, and the next turn
// starts cold. One now and then is expected (the owner forgot or changed
// something the session was shown). The same thread resetting turn after
// turn is a loop, and costs every reply a cold start (1.0.1.1). This counts
// resets per thread and warns once per thread when they pass the limit
// inside the window, with the reasons seen, ids and reasons only.

import { observeReset } from "../health/turn-observer.ts";

export const RESET_LOOP_WINDOW_MS = 10 * 60_000;
export const RESET_LOOP_LIMIT = 3;

const seen = new Map<string, { at: number[]; reasons: string[]; warned: boolean }>();

/** Count one reset; returns the warning line when this reset crosses the limit (once per thread). */
export function noteContinuationReset(threadId: string, engine: string, reason: string, now = Date.now()): string | undefined {
  observeReset(threadId, engine, reason); // Sentinel S08: an automatic reset, per opaque scope (observe only)
  const entry = seen.get(threadId) ?? { at: [], reasons: [], warned: false };
  entry.at.push(now); entry.reasons.push(reason);
  while (entry.at.length && now - entry.at[0]! > RESET_LOOP_WINDOW_MS) { entry.at.shift(); entry.reasons.shift(); }
  seen.set(threadId, entry);
  // bounded: a long-running server with many threads keeps only recent ones
  if (seen.size > 2_000) for (const [id, other] of seen) if (!other.at.length || now - other.at.at(-1)! > RESET_LOOP_WINDOW_MS) seen.delete(id);
  if (entry.at.length <= RESET_LOOP_LIMIT || entry.warned) return undefined;
  entry.warned = true;
  const counts = new Map<string, number>();
  for (const item of entry.reasons) counts.set(item, (counts.get(item) ?? 0) + 1);
  const reasons = [...counts].map(([item, count]) => `${item} x${count}`).join("; ");
  const line = `memory continuation reset loop thread=${threadId} engine=${engine} resets=${entry.at.length} window=${RESET_LOOP_WINDOW_MS / 60_000}m reasons=${reasons}`;
  console.warn(line);
  return line;
}

/** Thread recall (design S2): a turn on a sealed thread starts fresh by
 * design, so it is not a loop and never reaches noteContinuationReset. It is
 * counted here instead, per thread, with no warning, for the beta telemetry. */
const sealedTurns = new Map<string, { count: number; instances: Set<string>; lastAt: number }>();

/** Count one sealed turn on this thread. Never warns. */
export function noteSealedTurn(threadId: string, instanceId: string, now = Date.now()): number {
  const entry = sealedTurns.get(threadId) ?? { count: 0, instances: new Set<string>(), lastAt: now };
  entry.count++; entry.lastAt = now;
  if (entry.instances.size < 32) entry.instances.add(instanceId);
  sealedTurns.delete(threadId); sealedTurns.set(threadId, entry);
  // bounded like the reset map: keep the most recently used threads
  while (sealedTurns.size > 2_000) sealedTurns.delete(sealedTurns.keys().next().value!);
  return entry.count;
}

/** The thread-recall sealed turn counter: per thread, the turns counted and the engines they ran on. */
export function sealedTurnCounts(): { threadId: string; count: number; instances: string[]; lastAt: number }[] {
  return [...sealedTurns].map(([threadId, entry]) => ({ threadId, count: entry.count, instances: [...entry.instances], lastAt: entry.lastAt }));
}

/** The beta telemetry read of the sealed turn counter: totals and the most recently sealed threads, bounded. It is served in the owner's
 * memory status (`sealedTurns` on GET /api/memory/status, memory/settings.ts), which is where the other memory diagnostics are read. */
export function sealedTurnSummary(limit = 20): { threads: number; turns: number; recent: { threadId: string; count: number; instances: string[]; lastAt: number }[] } {
  const all = sealedTurnCounts();
  return { threads: all.length, turns: all.reduce((sum, entry) => sum + entry.count, 0), recent: all.sort((a, b) => b.lastAt - a.lastAt).slice(0, limit) };
}

/** Tests only. */
export function clearResetWatch() { seen.clear(); sealedTurns.clear(); }
