// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// VENUE-POST-1017 section 6: the composer's Post in… pick (presentation only; the send route and the tool re-check every pick).

export interface PostableVenue { venueId: string; name: string }
export interface VenuePickState { venueId: string; name: string }

export const POST_IN_LABEL = "Post in…";
export const POST_IN_EMPTY = "None of your projects or channels can take a post from this chat right now.";
export const POST_IN_LOAD_FAILED = "Could not load your projects and channels. Try again.";

/** The button's tooltip: busy greys it until the turn ends, so a pick always rides a fresh turn. */
export function postInTooltip(botName: string, busy: boolean): string {
  const name = botName.trim() || "the bot";
  return busy ? `Available when ${name} finishes` : `Have ${name} post in a project or channel`;
}

/** Whether the Post in… button is shown: 1:1 chats only, with a bot to post for. */
export function postInOffered(input: { bot: boolean; group: boolean; locked: boolean }): boolean {
  return input.bot && !input.group && !input.locked;
}

/** The send's pick fields (store.tsx "send" and the draft's outbox entry): absent with no pick. The quoted line is a bot reply only. */
export function postPickFields(pick: VenuePickState | null, replyTo: { id: string; fromBot: boolean } | null):
  { postTo?: { venueId: string }; quoteMessageId?: string } {
  if (!pick?.venueId) return {};
  return { postTo: { venueId: pick.venueId }, ...(replyTo?.fromBot ? { quoteMessageId: replyTo.id } : {}) };
}

/** The list body from GET /api/bots/:id/postable-venues, kept to well-formed rows. */
export function parsePostableVenues(body: unknown): PostableVenue[] {
  const venues = (body as { venues?: unknown } | null)?.venues;
  if (!Array.isArray(venues)) return [];
  return venues.filter((row): row is PostableVenue =>
    Boolean(row) && typeof (row as PostableVenue).venueId === "string" && typeof (row as PostableVenue).name === "string");
}

/** The picker's request path. */
export function postableVenuesPath(botId: string, threadId: string): string {
  return `/api/bots/${encodeURIComponent(botId)}/postable-venues${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`;
}
