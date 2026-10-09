// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A memory continuation reset ends a warm engine session, and the next turn
// starts cold. One now and then is expected (the owner forgot or changed
// something the session was shown). The same thread resetting turn after
// turn is a loop, and costs every reply a cold start (1.0.1.1). This counts
// resets per thread and warns once per thread when they pass the limit
// inside the window, with the reasons seen, ids and reasons only.

export const RESET_LOOP_WINDOW_MS = 10 * 60_000;
export const RESET_LOOP_LIMIT = 3;

const seen = new Map<string, { at: number[]; reasons: string[]; warned: boolean }>();

/** Count one reset; returns the warning line when this reset crosses the limit (once per thread). */
export function noteContinuationReset(threadId: string, engine: string, reason: string, now = Date.now()): string | undefined {
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

/** Tests only. */
export function clearResetWatch() { seen.clear(); }
