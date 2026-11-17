// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";

/** Main database initializer, also used by the installation snapshot's reference schema.
 * Packs survive pending_delegations cleanup; source/destination deletion owns their lifetime. */
export function initializeDelegationPacks(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS delegation_packs (
    id TEXT PRIMARY KEY,
    delegation_id TEXT NOT NULL UNIQUE,
    source_thread_id TEXT NOT NULL,
    source_bot_id TEXT NOT NULL,
    target_bot_id TEXT NOT NULL,
    destination_thread_id TEXT,
    refs TEXT NOT NULL,
    prepared TEXT NOT NULL DEFAULT '[]',
    cut_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS delegation_packs_source ON delegation_packs(source_thread_id);
  CREATE INDEX IF NOT EXISTS delegation_packs_destination ON delegation_packs(destination_thread_id);`);
}
