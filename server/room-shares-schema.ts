// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CROSS-CHAT-READ-1019: the room_shares table, kept apart from room-shares.ts so database.ts can create it without importing the picker.
import type { DatabaseSync } from "node:sqlite";

export function initializeRoomShares(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS room_shares (id TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL, room_id TEXT NOT NULL, room_thread_id TEXT NOT NULL, origin_thread_id TEXT NOT NULL,
    query TEXT NOT NULL, excerpts TEXT NOT NULL, excerpts_hash TEXT NOT NULL, nonce TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','sharing','shared','declined','unavailable')), stable_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS room_shares_status ON room_shares(status, expires_at);`);
}
