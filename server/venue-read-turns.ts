// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The venue-read records (BOT-VENUE-AWARENESS-106 4.2), in a module with no imports so internal-capabilities.ts can delete a generation's
// record when its claims are revoked without loading the venue reader. server/venue-read.ts is the only reader.

/** "paired": the owner's own paired Telegram/Slack/Discord DM (CROSS-CHAT-PAIRED-DM-1019); it lives only on this record, never on a
 * stored line (MessageOrigin and isOwnerOrigin are not widened), and always carries the binding it was verified against. */
export type VenueReadOrigin = "desktop" | "companion" | "paired";
export type VenueReadRecord = { botId: string; threadId: string; origin: VenueReadOrigin; rootThreadId?: string; paired?: { bindingId: string; revision: number }; attempts: number; lines: number };
/** The venue-read records by capability generation. Only recordVenueReadTurn writes it (from the mount in index.ts runTurn); the record is
 * deleted when the generation's claims are revoked (internal-capabilities.ts revokeGeneration and revokeAll). */
export const venueReadTurns = new Map<string, VenueReadRecord>();

export function recordVenueReadTurn(generation: string, record: Omit<VenueReadRecord, "attempts" | "lines">): void {
  // one live generation per thread: a newer turn's record replaces any older one on the thread
  for (const [key, old] of venueReadTurns) if (old.threadId === record.threadId && key !== generation) venueReadTurns.delete(key);
  venueReadTurns.set(generation, { botId: record.botId, threadId: record.threadId, origin: record.origin,
    ...(record.rootThreadId ? { rootThreadId: record.rootThreadId } : {}),
    ...(record.paired ? { paired: { bindingId: record.paired.bindingId, revision: record.paired.revision } } : {}), attempts: 0, lines: 0 });
}
export function forgetVenueReadTurn(generation: string): void { venueReadTurns.delete(generation); }
export function forgetAllVenueReadTurns(): void { venueReadTurns.clear(); }

