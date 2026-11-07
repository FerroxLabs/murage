// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VENUE-POST-1017 step 4: the held post at Ask and Auto. One venue_posts row per (generation, room, words); the 1:1 card is a view of the
// row and is answered only through answerHeldVenuePost (venue-post.ts). States: held -> posting -> posted | unavailable; held -> declined;
// held -> stopped. A held row never expires (cards wait). Light module: no store import, so database.ts and the snapshot can create it.
import type { DatabaseSync } from "node:sqlite";

export const VENUE_POSTS_DDL = `CREATE TABLE IF NOT EXISTS venue_posts (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, origin TEXT NOT NULL,
  root_thread_id TEXT, request_message_id TEXT NOT NULL, request_hash TEXT NOT NULL, venue_id TEXT NOT NULL, venue_thread_id TEXT, target_thread_id TEXT NOT NULL,
  text TEXT NOT NULL, stable_id TEXT NOT NULL, lineage TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('held','posting','posted','unavailable','declined','stopped')),
  card_message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;
export const VENUE_POSTS_INDEX = "CREATE INDEX IF NOT EXISTS venue_posts_open ON venue_posts(thread_id, state)";
export function initializeVenuePosts(db: DatabaseSync): void { db.exec(VENUE_POSTS_DDL); db.exec(VENUE_POSTS_INDEX); }

export type VenuePostState = "held" | "posting" | "posted" | "unavailable" | "declined" | "stopped";
export type VenuePostHeldRow = {
  id: string; botId: string; threadId: string; origin: string; rootThreadId?: string; requestMessageId: string; requestHash: string;
  venueId: string; venueThreadId?: string; targetThreadId: string; text: string; stableId: string; lineage: string; state: VenuePostState;
  cardMessageId?: string; createdAt: number; updatedAt: number;
};

/** The card's request id; the row id is the post's stableId. */
export const VENUE_POST_CARD_PREFIX = "venue-post-";
export const venuePostRequestId = (id: string): string => `${VENUE_POST_CARD_PREFIX}${id}`;
export const isVenuePostRequestId = (requestId: unknown): requestId is string => typeof requestId === "string" && requestId.startsWith(VENUE_POST_CARD_PREFIX) && requestId.length > VENUE_POST_CARD_PREFIX.length;
export const venuePostIdOf = (requestId: string): string => requestId.slice(VENUE_POST_CARD_PREFIX.length);

/** Card copy (MurageMain 11-04). */
export const VENUE_POST_CARD_POST = "Post it";
export const VENUE_POST_CARD_SKIP = "Don't post";
export const VENUE_POST_PREVIEW_MAX = 280;
export const venuePostCardTitle = (botName: string, roomName: string): string => `${botName} wants to post in ${roomName}`;
export const venuePostPreview = (text: string): string => text.length > VENUE_POST_PREVIEW_MAX ? `${text.slice(0, VENUE_POST_PREVIEW_MAX)}…` : text;
export const venuePostDoneLine = (roomName: string): string => `Posted in ${roomName}`;
export const VENUE_POST_NOT_POSTED = "Not posted";
/** What the bot hears when its call is held for the owner's card. */
export const VENUE_POST_HELD = "The owner sees a card to post this. It posts when they choose Post it; nothing more to do now.";

type Raw = Record<string, unknown>;
const toRow = (raw: Raw): VenuePostHeldRow => ({
  id: String(raw.id), botId: String(raw.bot_id), threadId: String(raw.thread_id), origin: String(raw.origin),
  ...(raw.root_thread_id ? { rootThreadId: String(raw.root_thread_id) } : {}),
  requestMessageId: String(raw.request_message_id), requestHash: String(raw.request_hash), venueId: String(raw.venue_id),
  ...(raw.venue_thread_id ? { venueThreadId: String(raw.venue_thread_id) } : {}),
  targetThreadId: String(raw.target_thread_id), text: String(raw.text), stableId: String(raw.stable_id), lineage: String(raw.lineage),
  state: String(raw.state) as VenuePostState, ...(raw.card_message_id ? { cardMessageId: String(raw.card_message_id) } : {}),
  createdAt: Number(raw.created_at), updatedAt: Number(raw.updated_at),
});

export function heldVenuePost(db: DatabaseSync, id: string): VenuePostHeldRow | null {
  initializeVenuePosts(db);
  const raw = db.prepare("SELECT * FROM venue_posts WHERE id=?").get(id) as Raw | undefined;
  return raw ? toRow(raw) : null;
}

/** Inserts the held row once; a repeated call (same generation, room and words) returns the row already there. */
export function holdVenuePost(db: DatabaseSync, row: Omit<VenuePostHeldRow, "state" | "createdAt" | "updatedAt" | "cardMessageId">, now = Date.now()): { row: VenuePostHeldRow; created: boolean } {
  initializeVenuePosts(db);
  const result = db.prepare(`INSERT OR IGNORE INTO venue_posts (id, bot_id, thread_id, origin, root_thread_id, request_message_id, request_hash, venue_id, venue_thread_id,
    target_thread_id, text, stable_id, lineage, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'held',?,?)`).run(row.id, row.botId, row.threadId, row.origin,
    row.rootThreadId ?? null, row.requestMessageId, row.requestHash, row.venueId, row.venueThreadId ?? null, row.targetThreadId, row.text, row.stableId, row.lineage, now, now);
  return { row: heldVenuePost(db, row.id)!, created: Number(result.changes) === 1 };
}

export function setVenuePostCard(db: DatabaseSync, id: string, cardMessageId: string): void {
  db.prepare("UPDATE venue_posts SET card_message_id=? WHERE id=?").run(cardMessageId, id);
}

/** A state move from an expected state; false when the row was not in `from` (someone else moved it). */
export function moveVenuePost(db: DatabaseSync, id: string, from: VenuePostState, to: VenuePostState, now = Date.now()): boolean {
  return Number(db.prepare("UPDATE venue_posts SET state=?, updated_at=? WHERE id=? AND state=?").run(to, now, id, from).changes) === 1;
}

/** Stop in the 1:1: every held post of that conversation becomes stopped (its card then reads Not posted). */
export function stopHeldVenuePosts(db: DatabaseSync, threadId: string, now = Date.now()): VenuePostHeldRow[] {
  initializeVenuePosts(db);
  const rows = (db.prepare("SELECT * FROM venue_posts WHERE thread_id=? AND state='held'").all(threadId) as Raw[]).map(toRow);
  for (const row of rows) moveVenuePost(db, row.id, "held", "stopped", now);
  return rows;
}

/** Boot: a post cut short between its claim and its write. The line on the target, by stableId, decides: there -> posted, else -> held
 * (the card is open again; the owner answers it again). Returns the rows it moved, with their new state. */
export function recoverVenuePosts(db: DatabaseSync, lineExists: (targetThreadId: string, stableId: string) => boolean, now = Date.now()): VenuePostHeldRow[] {
  initializeVenuePosts(db);
  const rows = (db.prepare("SELECT * FROM venue_posts WHERE state='posting'").all() as Raw[]).map(toRow);
  const moved: VenuePostHeldRow[] = [];
  for (const row of rows) {
    let there = false;
    try { there = lineExists(row.targetThreadId, row.stableId); } catch { there = false; }
    const to: VenuePostState = there ? "posted" : "held";
    if (moveVenuePost(db, row.id, "posting", to, now)) moved.push({ ...row, state: to });
  }
  return moved;
}
