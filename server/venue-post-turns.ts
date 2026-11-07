// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VENUE-POST-1017: the venue_post records by capability generation, kept apart from venue-post.ts so the capability store can forget a
// generation without importing the post's checks (the same split as venue-read-turns.ts).
import type { PostTo } from "./store.ts";

export type VenuePostRecord = {
  botId: string; threadId: string; origin: "desktop" | "companion"; rootThreadId?: string;
  request: { messageId: string; textHash: string; postTo: PostTo };
  attempts: number;
};
/** Only recordVenuePostTurn writes it (from the mount in index.ts startTurnAdmitting). */
export const venuePostTurns = new Map<string, VenuePostRecord>();
export function recordVenuePostTurn(generation: string, record: Omit<VenuePostRecord, "attempts">): void {
  venuePostTurns.set(generation, { ...record, attempts: 0 });
}
export function forgetVenuePostTurn(generation: string): void { venuePostTurns.delete(generation); }
export function forgetAllVenuePostTurns(): void { venuePostTurns.clear(); }
