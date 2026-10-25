// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot #3374 (src/state/turn-status.ts), Apache-2.0 (see NOTICE).
//
// Whether each thread's newest turn has ended, read from the live runtime
// frames (turn.started, turn.completed). The mascot and its timer stay for the
// whole turn: a bot's sentence in the middle of a turn is not its end. A turn
// ends across three frames (the settled reply, turn.completed, busy off), so
// knowing the turn has completed is what keeps the mascot from popping back
// under the final reply while busy winds down (turn-tail.ts).
//
// Held per thread outside the app reducer, so a frame re-renders only the chat
// that shows that thread, and only when its answer changes. The live "what the
// bot is doing" status line from the same upstream change is not part of this.
import { useSyncExternalStore } from "react";

import type { RuntimeEvent } from "../../server/contracts.ts";

export interface TurnLive {
  turnId?: string;
  /** The newest turn this thread showed has completed. */
  ended: boolean;
}

const UNKNOWN: TurnLive = { ended: false };
const MAX_THREADS = 500;
/** Older turns a thread has moved past, newest last, so their late frames are ignored. */
const MAX_SUPERSEDED = 16;
const threads = new Map<string, TurnLive>();
const superseded = new Map<string, string[]>();
const listeners = new Map<string, Set<() => void>>();

function put(threadId: string, next: TurnLive): void {
  const current = threads.get(threadId);
  if (current && current.turnId === next.turnId && current.ended === next.ended) return;
  // Moving to a different turn retires the old one for good: a late frame of
  // it (activity, completion, exit) must never take the thread back.
  if (current?.turnId && next.turnId && current.turnId !== next.turnId) {
    const older = (superseded.get(threadId) ?? []).filter((id) => id !== current.turnId && id !== next.turnId);
    older.push(current.turnId);
    if (older.length > MAX_SUPERSEDED) older.shift();
    superseded.set(threadId, older);
  }
  threads.delete(threadId);
  threads.set(threadId, next);
  if (threads.size > MAX_THREADS) {
    const evicted = threads.keys().next().value!;
    threads.delete(evicted);
    superseded.delete(evicted);
  }
  for (const listener of Array.from(listeners.get(threadId) ?? [])) listener();
}

/** One live runtime frame. */
export function noteTurnEvent(event: Pick<RuntimeEvent, "type" | "threadId" | "turnId">): void {
  const { threadId, turnId } = event;
  if (!threadId) return;
  // A frame of a turn this thread already moved past is late: ignore it.
  if (turnId && superseded.get(threadId)?.includes(turnId)) return;
  const current = threads.get(threadId);
  switch (event.type) {
    case "turn.started":
      return put(threadId, { turnId: turnId ?? undefined, ended: false });
    case "turn.completed":
      // A late completion of an older turn never ends the newer one.
      if (turnId && current?.turnId && current.turnId !== turnId && !current.ended) return;
      return put(threadId, { turnId: turnId ?? current?.turnId, ended: true });
    case "session.exited":
      // A retained session can exit after a newer turn reused the thread; only
      // an exit naming the running turn ends it (turn.completed covers the rest).
      if (turnId && current?.turnId === turnId) put(threadId, { turnId, ended: true });
      return;
    default:
      // Any frame of a turn this thread has not seen yet means a new turn is
      // running, also on a thread first seen mid-turn (its turn.started was
      // missed), so that turn's session.exited can still end it.
      if (turnId && current?.turnId !== turnId) put(threadId, { turnId, ended: false });
  }
}

export function turnLive(threadId: string | null | undefined): TurnLive {
  return (threadId && threads.get(threadId)) || UNKNOWN;
}

function subscribe(threadId: string | null | undefined, listener: () => void): () => void {
  if (!threadId) return () => {};
  let set = listeners.get(threadId);
  if (!set) listeners.set(threadId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadId);
  };
}

export function useTurnLive(threadId: string | null | undefined): TurnLive {
  return useSyncExternalStore(
    (listener) => subscribe(threadId, listener),
    () => turnLive(threadId),
    () => turnLive(threadId),
  );
}

/** Tests only. */
export function resetTurnLive(): void {
  threads.clear();
  superseded.clear();
}
