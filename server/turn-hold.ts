// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The memory worker's turn hold (worker-controller.ts holdForTurn) spans a
// turn from its acceptance until the engine has its prompt: background SQL
// that runs while the engine is starting leaves the engine's replies unread
// (RC1-FULL-TURN row 2: rpc.initialize 646-987 ms instead of about 100 ms).
// The turn hands its release here when it dispatches; the driver says when the
// prompt is written (notePromptSent), and any engine event of the turn, its
// completion included, ends the hold for a driver that does not.
//
// Standalone and dependency-free: drivers import it.

const pending = new Map<string, () => void>();

/** Release `release` once the engine on `threadId` has its prompt. An earlier
 * release still waiting on the thread is run first: one turn at a time. */
export function releaseWhenPromptSent(threadId: string, release: () => void): void {
  const earlier = pending.get(threadId);
  pending.set(threadId, release);
  earlier?.();
}

/** The engine on `threadId` has the turn's prompt (or has started answering). */
export function notePromptSent(threadId: string): void {
  const release = pending.get(threadId);
  if (!release) return;
  pending.delete(threadId);
  release();
}
