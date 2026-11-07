// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Saved calls and settings revisions for bot phone calls (BOT-CALLS-1020 3b, 3c, 4; build item 4). A leaf: node:sqlite only.
// Owner-only call storage: the transcript and the reference live here, never in a thread's message history, so no engine
// gets them in a later turn. The harness opens its own small file for it (phone-calls.db in the data dir), so the shared
// messages.db schema and its snapshot reference stay as they are.
import type { DatabaseSync } from "node:sqlite";
import type { CallRow, CallStore } from "./service.ts";
import type { RevisionState } from "./settings.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS phone_calls (
  id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, revision INTEGER NOT NULL, assistant_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  status TEXT NOT NULL, row_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_calls_live ON phone_calls(status) WHERE status IN ('uncertain', 'scheduled', 'ringing', 'in_progress');
CREATE TABLE IF NOT EXISTS phone_call_settings (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL);
`;

const STATUSES = new Set(["uncertain", "scheduled", "ringing", "in_progress", "ended", "cancelled", "abandoned"]);

function parseRow(json: string): CallRow | undefined {
  try {
    const row = JSON.parse(json) as CallRow;
    return row && typeof row.id === "string" && typeof row.vendorId === "string" && STATUSES.has(row.status) ? row : undefined;
  } catch { return undefined; }
}

export class SqliteCallStore implements CallStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; db.exec(DDL); }

  get(id: string): CallRow | undefined {
    const hit = this.db.prepare("SELECT row_json FROM phone_calls WHERE id = ?").get(id) as { row_json: string } | undefined;
    return hit ? parseRow(hit.row_json) : undefined;
  }

  put(row: CallRow): void {
    this.db.prepare(`INSERT INTO phone_calls (id, vendor_id, revision, assistant_id, created_at, status, row_json) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET vendor_id = excluded.vendor_id, status = excluded.status, row_json = excluded.row_json`)
      .run(row.id, row.vendorId, row.revision, row.assistantId, row.createdAt, row.status, JSON.stringify(row));
  }

  /** Scheduled or in-progress calls only (indexed), so releasing old assistants never scans call history. */
  *live(): Iterable<CallRow> {
    const rows = this.db.prepare("SELECT row_json FROM phone_calls WHERE status IN ('uncertain', 'scheduled', 'ringing', 'in_progress')").all() as { row_json: string }[];
    for (const r of rows) { const row = parseRow(r.row_json); if (row) yield row; }
  }

  *abandoned(): Iterable<CallRow> {
    const rows = this.db.prepare("SELECT row_json FROM phone_calls WHERE status = 'abandoned'").all() as { row_json: string }[];
    for (const r of rows) { const row = parseRow(r.row_json); if (row && !row.abandonCancel) yield row; }
  }

  /** Newest first, for the owner's call list. */
  recent(limit = 50): CallRow[] {
    const rows = this.db.prepare("SELECT row_json FROM phone_calls ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(200, limit))) as { row_json: string }[];
    return rows.map((r) => parseRow(r.row_json)).filter((r): r is CallRow => Boolean(r));
  }

  loadRevisions(): RevisionState | null {
    const hit = this.db.prepare("SELECT state_json FROM phone_call_settings WHERE id = 1").get() as { state_json: string } | undefined;
    if (!hit) return null;
    try { return JSON.parse(hit.state_json) as RevisionState; } catch { return null; }
  }

  saveRevisions(state: RevisionState): void {
    this.db.prepare("INSERT INTO phone_call_settings (id, state_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json")
      .run(JSON.stringify(state));
  }
}
