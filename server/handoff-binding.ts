// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whose answer is this? A direct ask or delegation (no room or card request above it) starts its turn with a user message that records the
// conversation that handed the work over (`Message.handoffFrom`, written when the turn is dispatched and stored with the message). A worker
// reply is proven to be that conversation's own answer when the reply follows that message in the worker's conversation. Nothing else is evidence:
// a request that once targeted the same conversation says nothing about this reply (review round 5 #3).
import type { Message } from "./store.ts";

type Row = Pick<Message, "id" | "role"> & { parentId?: string | null; steered?: boolean; handoffFrom?: string };

/** The user message a reply answers: the nearest earlier user message that was not steered into a running turn. */
function promptOf(message: (id: string) => Row | undefined, messageId: string): Row | undefined {
  const seen = new Set<string>();
  let at = message(messageId);
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    if (at.role === "user" && at.steered !== true) return at;
    at = at.parentId ? message(at.parentId) : undefined;
  }
  return undefined;
}

/** True when every message of `origin` answers a direct hand-off started by `sourceThreadId`. An origin with no messages has nothing to prove.
 * `message` reads one message of the worker's conversation by id (never the whole transcript). */
export function resultBoundToHandoff(message: (id: string) => Row | undefined, origin: { messageIds: readonly string[] }, sourceThreadId: string): boolean {
  if (!origin.messageIds.length) return true;
  return origin.messageIds.every(id => promptOf(message, id)?.handoffFrom === sourceThreadId);
}

/** The gate's `ownUnsharedWork` question, answered from the live records: both sides are the owner's own unshared conversations and, when the
 * result has an original, that original answers a hand-off this very conversation started. */
export function ownUnsharedWorkCheck<Bot>(env: {
  bot: (id: string) => Bot | undefined;
  isOwnUnsharedThread: (bot: Bot | undefined, threadId: string) => boolean;
  message: (threadId: string, messageId: string) => Row | undefined;
}): (who: { fromBotId: string; toBotId: string; fromThreadId: string }, origin: { threadId: string; messageIds: readonly string[] } | undefined) => boolean {
  return (who, origin) => {
    const from = env.bot(who.fromBotId), target = env.bot(who.toBotId);
    return target !== undefined && env.isOwnUnsharedThread(from, who.fromThreadId)
      && (origin === undefined || env.isOwnUnsharedThread(target, origin.threadId) && resultBoundToHandoff(id => env.message(origin.threadId, id), origin, who.fromThreadId));
  };
}
