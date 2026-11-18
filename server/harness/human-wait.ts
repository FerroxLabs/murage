// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cards the harness itself holds open while an engine tool waits (an image approval, for one). The driver has no ask entry for
// these, so its timers read this instead: no timer of ours ends a turn while the owner is being waited on.

const open = new Map<string, Set<string>>();

/** With a generation, membership is that generation's own: releasing an old generation's handle never removes a successor's
 * handle that reuses the same request id (design1019-approval-attention). */
export function noteHumanWait(threadId: string, requestId: string, waiting: boolean, generation?: string): void {
  const member = generation ? `${generation}\u0000${requestId}` : requestId;
  const cards = open.get(threadId) ?? new Set<string>();
  if (waiting) cards.add(member); else cards.delete(member);
  if (cards.size) open.set(threadId, cards); else open.delete(threadId);
}

export function humanWaitOpen(threadId: string): boolean {
  return open.has(threadId);
}
