// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a room request ended, kept apart from its text fields. The bot-facing ending is Murage's own line, stored as a key and the parameters
// its schema names (server/murage-status.ts `KEPT`), in a field of its own; nothing is ever read back as a line by parsing a text. The
// provider's or engine's own words, when there are any, are kept beside it in `diagnostic`, which only the owner's views read.
import type { DatabaseSync } from "node:sqlite";
import { statusFromLegacyNote, statusFromStored, storedStatusOf, type MurageStatus, type StoredStatus } from "./murage-status.ts";

const ready = new WeakMap<DatabaseSync, boolean>();
function hasTable(db: DatabaseSync): boolean {
  let known = ready.get(db);
  if (known === undefined) {
    known = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='room_request_status'").get());
    if (known) ready.set(db, true);
  }
  return known;
}

/** Records how a request ended. Called inside the completion's own transaction, only when the completion took effect. */
export function writeRequestStatus(db: DatabaseSync, requestId: string, ending: MurageStatus | undefined, diagnostic: string | undefined): void {
  if ((!ending && diagnostic === undefined) || !hasTable(db)) return;
  const kept: StoredStatus | undefined = ending ? storedStatusOf(ending) : undefined;
  db.prepare("INSERT OR REPLACE INTO room_request_status (request_id, status_key, status_data, diagnostic) VALUES (?,?,?,?)")
    .run(requestId, kept?.key ?? "request_failed", kept?.data ? JSON.stringify(kept.data) : null, diagnostic === undefined ? null : diagnostic.slice(0, 4096));
}

/** The line a bot may be told about how a request ended: the kept key, written again only when its parameters pass the key's schema now, or
 * (for a request finished before endings were kept) one of the few exact fixed lines an older note may hold. Undefined when there is none. */
export function requestEnding(db: DatabaseSync, request: { id: string; outcomeNote?: string | null }): MurageStatus | undefined {
  if (hasTable(db)) {
    const row = db.prepare("SELECT status_key, status_data FROM room_request_status WHERE request_id=?").get(request.id) as { status_key: string; status_data: string | null } | undefined;
    if (row) {
      let data: unknown;
      try { data = row.status_data === null ? undefined : JSON.parse(row.status_data); } catch { return undefined; }
      return statusFromStored(row.status_key, data);
    }
  }
  return statusFromLegacyNote(request.outcomeNote);
}

/** The engine's own words about how a request ended, for the owner's views only. */
export function requestDiagnostic(db: DatabaseSync, requestId: string): string | null {
  if (!hasTable(db)) return null;
  const row = db.prepare("SELECT diagnostic FROM room_request_status WHERE request_id=?").get(requestId) as { diagnostic: string | null } | undefined;
  return row?.diagnostic ?? null;
}
