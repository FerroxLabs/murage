// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Retry on a room member's failed turn (1.0.4 item 117). A direct chat retries
// its last message; a room has several members, so the retry must send the
// words that member was answering back to THAT member alone, never the last
// message of the room and never to everyone.
import type { Message } from "@/state/store";

export interface RoomRetryTarget {
  /** the member whose turn is run again */
  responderId: string;
  /** the words the member was answering */
  text: string;
}

/**
 * The retry for a failed row, or null when none should be offered: the row is
 * not a member's, the member is not in the room now, the room is busy, a later
 * row from the same member already followed it, or there is no earlier message
 * of the owner's to answer.
 */
export function roomRetryTarget(
  transcript: readonly Message[],
  failed: Message,
  opts: { memberIds: readonly string[]; roomBusy: boolean },
): RoomRetryTarget | null {
  const responderId = failed.from?.botId;
  if (!responderId || opts.roomBusy || !opts.memberIds.includes(responderId)) return null;
  const at = transcript.findIndex((message) => message.id === failed.id);
  if (at < 0) return null;
  for (let i = at + 1; i < transcript.length; i += 1) {
    if (transcript[i]!.from?.botId === responderId) return null;
  }
  for (let i = at - 1; i >= 0; i -= 1) {
    const message = transcript[i]!;
    if (message.role === "user" && message.kind === "text" && message.text?.trim()) {
      return { responderId, text: message.text };
    }
  }
  return null;
}
