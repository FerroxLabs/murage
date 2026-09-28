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
import { withholdRoomReplies } from "./room-context.ts";
import type { Message } from "./store.ts";

export interface RoomTranscript {
  messages: Message[];
  /** Replies shown as a withheld line. Empty for a filtered transcript,
   * whose removed messages are not shown at all. */
  withheld: Set<string>;
}

export function roomTranscriptForTurn(threadId: string, messages: readonly Message[], ownerAudience: boolean, access: MemoryAccess): RoomTranscript {
  if (!ownerAudience) return { messages: filterMemoryReplay(threadId, messages, access, { persist: false }), withheld: new Set() };
  const withheld = roomReplayWithheld(threadId, messages);
  return { messages: withholdRoomReplies(messages, withheld), withheld };
}
