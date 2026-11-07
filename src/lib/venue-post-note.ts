// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VENUE-POST-1017 4b: the room note under a post a bot made from its own chat with the owner (Post in…). The words match
// server/venue-post.ts VENUE_POST_NOTE / VENUE_POST_NOTE_GONE.
import type { Bot } from "../state/store";

export const VENUE_POST_NOTE_GONE = "Sent from a chat you have since deleted";

export function venuePostNote(postedFrom: { botId: string; threadId: string }, bots: readonly Pick<Bot, "id" | "name">[]): string {
  const bot = bots.find((candidate) => candidate.id === postedFrom.botId);
  if (!bot) return VENUE_POST_NOTE_GONE;
  return `Sent from your chat with ${bot.name}`;
}
