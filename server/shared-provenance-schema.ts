// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { ensureChildTable } from "./added-table-lifecycle.ts";

/** Routine provenance of each shared request (server/shared-work.ts). Created by the database
 * initializer, never at use time inside a request transaction, and registered in the installation
 * snapshot's reference schema so backup and restore accept it. */
export function initializeSharedRequestProvenance(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS shared_request_provenance (request_id TEXT PRIMARY KEY, origin TEXT NOT NULL CHECK(origin IN ('routine','none')), permission_mode TEXT, trigger_source TEXT)");
  // The event run (the ledger key) a shared request does work for, so a bot that receives the work is counted against that run.
  // a child of room_requests: its definition and its cleanup live in added-table-lifecycle.ts
  ensureChildTable(db, "shared_request_events");
}
