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
import { database } from "./database.ts";
import { largeReceiptThread, messageMadeWithMemory, messageSourceForgotten, replayExclusions } from "./memory/replay-lineage.ts";
import { GROUP_CONTEXT_MESSAGES, roomContextMessages, withholdRoomReplies } from "./room-context.ts";
import type { Message } from "./store.ts";

export interface RoomTranscript {
  messages: Message[];
  /** Replies shown as a withheld line. Empty for a filtered transcript,
   * whose removed messages are not shown at all. */
  withheld: Set<string>;
  /** Of those, the replies the owner forgot themselves, rather than ones
   * that used something forgotten, deleted or changed. */
  forgotten: Set<string>;
  /** The messages checked for this turn. The owner's "bots no longer see
   * this reply" note follows only these. */
  checked: Set<string>;
}

/** A room past this many messages, or past the receipt limit a thread is
 * read whole under, checks only the lines a member prompt can show (the
 * newest window, the pin, each quoted line): bounded work, and a line it
 * did not check is never shown (0.1.61, replay limit). */
const WHOLE_ROOM_MESSAGES = 10000;

export function roomTranscriptForTurn(threadId: string, messages: readonly Message[], ownerAudience: boolean, access: MemoryAccess, pinnedMessageId?: string): RoomTranscript {
  const bounded = messages.length > WHOLE_ROOM_MESSAGES || largeReceiptThread(threadId);
  if (!ownerAudience) {
    if (!bounded) return { messages: filterMemoryReplay(threadId, messages, access, { persist: false, failClosed: true }), withheld: new Set(), forgotten: new Set(), checked: new Set(messages.map(m => m.id)) };
    return boundedFilter(threadId, messages, access, pinnedMessageId);
  }
  const candidates = bounded ? promptCandidates(messages, pinnedMessageId, GROUP_CONTEXT_MESSAGES) : messages;
  const withheld = roomReplayWithheld(threadId, candidates);
  const forgotten = forgottenReplies(threadId, candidates, withheld);
  return { messages: withholdRoomReplies(candidates, withheld, forgotten), withheld, forgotten, checked: new Set(candidates.map(m => m.id)) };
}

/** The withheld replies whose own source the owner forgot. */
function forgottenReplies(threadId: string, messages: readonly Message[], withheld: ReadonlySet<string>): Set<string> {
  return new Set(messages.filter(m => m.role !== "user" && withheld.has(m.id) && messageSourceForgotten(threadId, m.id)).map(m => m.id));
}

/** The transcript a member reads when memory is not active (capture only,
 * paused or off). Receipts from when it was on still name the replies made
 * with memory, and what the owner forgot since must not come back because
 * memory stopped: the content rule still applies, as a withheld line for the
 * owner's turn and as a dropped line for anyone else. A room that never used
 * memory (no receipt, no copy, no reply with output roots) is read as it is. */
export function roomTranscriptWithoutMemory(threadId: string, messages: readonly Message[], ownerAudience: boolean, pinnedMessageId?: string, unprovenInOwnerRoom = false): { messages: Message[]; withheld: Set<string>; forgotten: Set<string>; checked: Set<string> } | undefined {
  // A thread with no receipt of its own may still hold replies built on
  // memory from elsewhere (v6 output roots, e.g. cross-thread working
  // context): those are checked too (Astra r4 #3).
  if (!database().prepare("SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT 1").get(threadId) && !messages.some(m => m.copyOf)
    && !database().prepare("SELECT 1 FROM memory_output_roots WHERE thread_id=? LIMIT 1").get(threadId)) return undefined;
  const bounded = messages.length > WHOLE_ROOM_MESSAGES || largeReceiptThread(threadId);
  const candidates = bounded ? promptCandidates(messages, pinnedMessageId, GROUP_CONTEXT_MESSAGES) : [...messages];
  const withheld = replayExclusions(threadId, candidates, null, { failClosed: true });
  for (const m of candidates) if (m.role !== "user" && !withheld.has(m.id) && messageSourceForgotten(threadId, m.id)) withheld.add(m.id);
  // Words nobody proved are the owner's, in the owner's room, with no memory
  // access to check a reply against: no reply made with memory is shown.
  if (unprovenInOwnerRoom) for (const m of candidates) if (m.role !== "user" && !withheld.has(m.id) && messageMadeWithMemory(threadId, m.id)) withheld.add(m.id);
  const checked = new Set(candidates.map(m => m.id));
  if (!ownerAudience) return { messages: candidates.filter(m => !withheld.has(m.id)), withheld: new Set(), forgotten: new Set(), checked };
  const forgotten = forgottenReplies(threadId, candidates, withheld);
  return { messages: withholdRoomReplies(candidates, withheld, forgotten), withheld, forgotten, checked };
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
  return { messages: kept, withheld: new Set(), forgotten: new Set(), checked: new Set(candidates.map(m => m.id)) };
}
