// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which room messages a member turn reads, when memory is on (0.1.61
// transcript fix, R-A).
//
// A room message is a room record. For a turn whose audience is the owner,
// every teammate reply stays in the transcript: a roster change, a settings
// change or what this member could recall no longer removes it. A reply that
// used something the owner forgot, deleted or changed is replaced by a
// visible withheld line (room-context.ts), never dropped.
//
// Any other room turn (a channel person's pair room, a chain a channel person
// started, words nobody proved are the owner's) keeps the per-reader replay
// filter unchanged.
import { filterMemoryReplay, roomReplayWithheld } from "./memory/disclosures.ts";
import type { MemoryAccess } from "./memory/policy.ts";
import { largeReceiptThread } from "./memory/replay-lineage.ts";
import { GROUP_CONTEXT_MESSAGES, roomContextMessages, withholdRoomReplies } from "./room-context.ts";
import type { Message } from "./store.ts";

export interface RoomTranscript {
  messages: Message[];
  /** Replies shown as a withheld line. Empty for a filtered transcript,
   * whose removed messages are not shown at all. */
  withheld: Set<string>;
  /** The messages checked for this turn. The owner's "bots no longer see
   * this reply" note follows only these. */
  checked: Set<string>;
}

/** A room past this many messages, or past the receipt limit a thread is
 * read whole under, checks only the lines a member prompt can show (the
 * newest window, the pin, each quoted line): bounded work, and a line it
 * did not check is never shown (0.1.61 lane T2, replay limit). */
const WHOLE_ROOM_MESSAGES = 10000;

export function roomTranscriptForTurn(threadId: string, messages: readonly Message[], ownerAudience: boolean, access: MemoryAccess, pinnedMessageId?: string): RoomTranscript {
  const bounded = messages.length > WHOLE_ROOM_MESSAGES || largeReceiptThread(threadId);
  if (!ownerAudience) {
    if (!bounded) return { messages: filterMemoryReplay(threadId, messages, access, { persist: false, failClosed: true }), withheld: new Set(), checked: new Set(messages.map(m => m.id)) };
    return boundedFilter(threadId, messages, access, pinnedMessageId);
  }
  const candidates = bounded ? promptCandidates(messages, pinnedMessageId, GROUP_CONTEXT_MESSAGES) : messages;
  const withheld = roomReplayWithheld(threadId, candidates);
  return { messages: withholdRoomReplies(candidates, withheld), withheld, checked: new Set(candidates.map(m => m.id)) };
}

/** The newest `limit` text lines, the pin and every line they quote, in
 * their places in the conversation. */
function promptCandidates(messages: readonly Message[], pinnedMessageId: string | undefined, limit: number): Message[] {
  const window = roomContextMessages(messages, limit, pinnedMessageId);
  const ids = new Set(window.map(m => m.id));
  for (const m of window) if (m.replyToId) ids.add(m.replyToId);
  return messages.filter(m => ids.has(m.id));
}

/** A filtered transcript drops what it may not show, so older lines move up
 * into the window: widen the checked tail until the window is full, up to a
 * fixed number of rounds. */
function boundedFilter(threadId: string, messages: readonly Message[], access: MemoryAccess, pinnedMessageId: string | undefined): RoomTranscript {
  const texts = messages.filter(m => m.kind === "text" && m.text).length;
  let limit = GROUP_CONTEXT_MESSAGES * 2, kept: Message[] = [], candidates: Message[] = [];
  for (let round = 0; round < 4; round++, limit *= 2) {
    candidates = promptCandidates(messages, pinnedMessageId, limit);
    kept = filterMemoryReplay(threadId, candidates, access, { persist: false, failClosed: true });
    if (kept.filter(m => m.kind === "text" && m.text).length >= GROUP_CONTEXT_MESSAGES || limit >= texts) break;
  }
  return { messages: kept, withheld: new Set(), checked: new Set(candidates.map(m => m.id)) };
}
