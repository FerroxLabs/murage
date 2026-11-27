// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import type { DatabaseSync } from "node:sqlite";
import { PHONE_BOT_DEFAULT, type CallRow, type CallScope, type CallStore, type CallWriteOptions, type OnLastReconcileMiss } from "./contracts.ts";
import type { RevisionState } from "./settings.ts";

const LIVE_STATUSES = new Set(["uncertain", "scheduled", "ringing", "in_progress"]);
const LIVE = `(${[...LIVE_STATUSES].map(status => `'${status}'`).join(", ")})`;

export function callIsLive(row: CallRow): boolean {
  return LIVE_STATUSES.has(row.status);
}
const DDL = `
CREATE TABLE IF NOT EXISTS phone_calls (
  id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, revision INTEGER NOT NULL, assistant_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  status TEXT NOT NULL, row_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_calls_live ON phone_calls(status) WHERE status IN ${LIVE};
CREATE TABLE IF NOT EXISTS phone_call_settings (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phone_call_keys (
  id TEXT PRIMARY KEY, bot_id TEXT, revision INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  reconcile_due INTEGER, reconcile_misses INTEGER NOT NULL DEFAULT 0, transcript_at INTEGER, identity TEXT, intent TEXT,
  analysis_due INTEGER
);
CREATE INDEX IF NOT EXISTS phone_call_keys_due ON phone_call_keys(reconcile_due) WHERE reconcile_due IS NOT NULL;
CREATE INDEX IF NOT EXISTS phone_call_keys_live_rev ON phone_call_keys(revision) WHERE status IN ${LIVE};
CREATE INDEX IF NOT EXISTS phone_call_keys_live_bot ON phone_call_keys(bot_id, id) WHERE status IN ${LIVE};
CREATE INDEX IF NOT EXISTS phone_call_keys_live_identity ON phone_call_keys(bot_id, identity) WHERE status IN ${LIVE};
CREATE INDEX IF NOT EXISTS phone_call_keys_intent ON phone_call_keys(bot_id, intent, identity) WHERE intent IS NOT NULL;
CREATE INDEX IF NOT EXISTS phone_call_keys_analysis ON phone_call_keys(analysis_due) WHERE analysis_due IS NOT NULL;
CREATE INDEX IF NOT EXISTS phone_call_keys_created ON phone_call_keys(created_at);
CREATE INDEX IF NOT EXISTS phone_call_keys_transcript ON phone_call_keys(transcript_at) WHERE transcript_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS phone_call_keys_scheduled ON phone_call_keys(revision) WHERE status = 'scheduled';
CREATE TABLE IF NOT EXISTS phone_call_bots (bot_id TEXT PRIMARY KEY, allowed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS phone_call_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phone_call_abandoned (id TEXT PRIMARY KEY, bot_id TEXT, pending INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS phone_call_abandoned_bot ON phone_call_abandoned(bot_id, id);
CREATE INDEX IF NOT EXISTS phone_call_abandoned_pending_bot ON phone_call_abandoned(bot_id, id) WHERE pending = 1;
CREATE INDEX IF NOT EXISTS phone_call_abandoned_pending ON phone_call_abandoned(id) WHERE pending = 1;
CREATE TABLE IF NOT EXISTS phone_call_legacy_dirty (id TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS phone_call_dirty_insert AFTER INSERT ON phone_calls BEGIN
  INSERT INTO phone_call_legacy_dirty VALUES (new.id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS phone_call_dirty_update AFTER UPDATE ON phone_calls BEGIN
  INSERT INTO phone_call_legacy_dirty VALUES (new.id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS phone_call_dirty_delete AFTER DELETE ON phone_calls BEGIN
  INSERT INTO phone_call_legacy_dirty VALUES (old.id) ON CONFLICT DO NOTHING;
END;
UPDATE phone_call_meta SET value = '0' WHERE key = 'migrated'
  AND NOT EXISTS (SELECT 1 FROM phone_call_meta WHERE key = 'abandoned_index_v1');
INSERT INTO phone_call_meta VALUES ('abandoned_index_v1', '1') ON CONFLICT DO NOTHING;
`;

const STATUSES = new Set(["uncertain", "scheduled", "ringing", "in_progress", "ended", "cancelled", "abandoned"]);
const INSERT_CALL = "INSERT INTO phone_calls (id, vendor_id, revision, assistant_id, created_at, status, row_json) VALUES (?, ?, ?, ?, ?, ?, ?)";
const CALLS_BY_KEY = "SELECT c.row_json FROM phone_call_keys k CROSS JOIN phone_calls c ON c.id = k.id";
const INSERT_KEYS = `INSERT INTO phone_call_keys
  (id, bot_id, revision, status, created_at, reconcile_due, transcript_at, identity, intent, analysis_due)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const LEGACY_JSON = "CASE WHEN json_valid(row_json) THEN row_json END";
const LEGACY_STOP = `coalesce(json_extract(${LEGACY_JSON}, '$.abandonCancel'), '')`;

function parseRow(json: string): CallRow | undefined {
  try {
    const row = JSON.parse(json) as CallRow;
    return row && typeof row.id === "string" && typeof row.vendorId === "string" && STATUSES.has(row.status) ? row : undefined;
  } catch { return undefined; }
}

function readRows(rows: unknown[]): CallRow[] {
  return (rows as { row_json: string }[]).flatMap(({ row_json }) => {
    const row = parseRow(row_json);
    return row ? [row] : [];
  });
}

export function callLimit(limit: number, cap: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.min(cap, Math.trunc(limit))) : cap;
}

export function needsReconcile(row: CallRow): boolean {
  return row.reconcileScan !== "unpageable" && !row.abandonCancel && (row.status === "uncertain" || row.status === "abandoned");
}

export function nextReconcileMiss(misses: number, now: number): number | null {
  return misses >= 12 ? null : now + Math.min(60_000 * 2 ** misses, 86_400_000);
}

export function transcriptAt(row: CallRow): number | null {
  return row.transcript && !row.transcriptCleared && !callIsLive(row) ? row.endedAt ?? row.createdAt : null;
}

export class SqliteCallStore implements CallStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync, now = Date.now) { this.db = db; this.now = now; db.exec(DDL); }

  private atomic(change: () => boolean): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = change();
      this.db.exec(changed ? "COMMIT" : "ROLLBACK");
      return changed;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private within(options?: CallWriteOptions): void {
    if (options?.within?.(this.db) !== undefined) throw new TypeError("CallStore within must finish synchronously");
  }

  get(id: string): CallRow | undefined {
    const hit = this.db.prepare("SELECT row_json FROM phone_calls WHERE id = ?").get(id) as { row_json: string } | undefined;
    return hit ? parseRow(hit.row_json) : undefined;
  }

  private keyValues(row: CallRow, due: number | null) {
    return [row.id, row.botId ?? null, row.revision, row.status, row.createdAt, due,
      transcriptAt(row), row.identity ?? null, row.intent ?? null, row.analysisDue ?? null] as const;
  }

  private writeKeys(row: CallRow, options?: CallWriteOptions): void {
    const due = !needsReconcile(row) ? null : options?.reconcileDue === undefined ? this.now() : options.reconcileDue;
    this.db.prepare(`${INSERT_KEYS} ON CONFLICT(id) DO UPDATE SET
      bot_id = excluded.bot_id, status = excluded.status, transcript_at = excluded.transcript_at,
      reconcile_due = CASE WHEN excluded.reconcile_due IS NULL OR phone_call_keys.status <> excluded.status OR ? THEN excluded.reconcile_due
        ELSE coalesce(phone_call_keys.reconcile_due, excluded.reconcile_due) END,
      analysis_due = excluded.analysis_due`).run(...this.keyValues(row, due), options?.reconcileDue !== undefined ? 1 : 0);
    this.writeAbandoned(row);
    this.db.prepare("DELETE FROM phone_call_legacy_dirty WHERE id = ?").run(row.id);
  }

  private writeAbandoned(row: CallRow): void {
    if (row.status === "abandoned" && row.abandonCancel !== "confirmed" && row.abandonCancel !== "not_found") {
      this.db.prepare(`INSERT INTO phone_call_abandoned VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET bot_id = excluded.bot_id, pending = excluded.pending`)
        .run(row.id, row.botId || null, row.abandonCancel ? 0 : 1);
    } else this.db.prepare("DELETE FROM phone_call_abandoned WHERE id = ?").run(row.id);
  }

  private deleteKeys(id: string): void {
    this.db.prepare("DELETE FROM phone_call_keys WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM phone_call_abandoned WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM phone_call_legacy_dirty WHERE id = ?").run(id);
  }

  put(row: CallRow): void {
    this.atomic(() => {
      this.db.prepare(`${INSERT_CALL}
        ON CONFLICT(id) DO UPDATE SET vendor_id = excluded.vendor_id, status = excluded.status, row_json = excluded.row_json`)
        .run(row.id, row.vendorId, row.revision, row.assistantId, row.createdAt, row.status, JSON.stringify(row));
      this.writeKeys(row);
      return true;
    });
  }

  insert(row: CallRow, options?: CallWriteOptions): void {
    this.atomic(() => {
      this.within(options);
      this.db.prepare(INSERT_CALL).run(row.id, row.vendorId, row.revision, row.assistantId, row.createdAt, row.status, JSON.stringify(row));
      this.writeKeys(row, options);
      return true;
    });
  }

  private updateRow(row: CallRow, options?: CallWriteOptions): boolean {
    const previous = this.get(row.id);
    if (!previous) return false;
    const stored = { ...row, revision: previous.revision, assistantId: previous.assistantId, createdAt: previous.createdAt,
      intent: previous.intent, identity: previous.identity };
    this.db.prepare("UPDATE phone_calls SET vendor_id = ?, status = ?, row_json = ? WHERE id = ?")
      .run(stored.vendorId, stored.status, JSON.stringify(stored), stored.id);
    this.writeKeys(stored, options);
    return true;
  }

  update(row: CallRow, options?: CallWriteOptions): boolean {
    return this.atomic(() => {
      if (!this.updateRow(row, options)) return false;
      this.within(options);
      return true;
    });
  }

  settle(cancel: CallRow, booking: CallRow, options?: CallWriteOptions): boolean {
    return this.atomic(() => {
      if (cancel.id === booking.id || !this.updateRow(cancel, options) || !this.updateRow(booking)) return false;
      this.within(options);
      return true;
    });
  }

  delete(id: string, options?: CallWriteOptions): boolean {
    return this.atomic(() => {
      if (!this.db.prepare("DELETE FROM phone_calls WHERE id = ?").run(id).changes) return false;
      this.deleteKeys(id);
      this.within(options);
      return true;
    });
  }

  *live(): Iterable<CallRow> {
    yield* readRows(this.db.prepare(`SELECT row_json FROM phone_calls WHERE status IN ${LIVE}`).all());
  }

  private *abandonedRows(pending: boolean, scope?: CallScope): Iterable<CallRow> {
    const indexed = this.meta("migrated") === "done";
    const bot = indexed ? "a.bot_id" : `nullif(json_extract(${LEGACY_JSON}, '$.botId'), '')`;
    const filter = scope ? ` AND ${bot} IS ?` : "";
    const stop = pending ? `${LEGACY_STOP} = ''` : `${LEGACY_STOP} NOT IN ('confirmed', 'not_found')`;
    const select = this.db.prepare(indexed
      ? `SELECT a.id, c.row_json FROM phone_call_abandoned a CROSS JOIN phone_calls c ON c.id = a.id
        WHERE a.id > ?${pending ? " AND a.pending = 1" : ""}${filter} ORDER BY a.id LIMIT 50`
      : `SELECT id, row_json FROM phone_calls WHERE id > ? AND status = 'abandoned'
        AND ${stop}${filter} ORDER BY id LIMIT 50`);
    let after = "";
    while (true) {
      const page = select.all(after, ...(scope ? [scope.botId ?? null] : [])) as { id: string; row_json: string }[];
      yield* readRows(page);
      if (page.length < 50) return;
      after = page[page.length - 1].id;
    }
  }

  abandoned(scope?: CallScope): Iterable<CallRow> {
    return this.abandonedRows(true, scope);
  }

  unstopped(scope?: CallScope): Iterable<CallRow> {
    return this.abandonedRows(false, scope);
  }

  /** Newest first, for the owner's call list. */
  recent(limit = 50): CallRow[] {
    // During backfill, the shipped query keeps every legacy call visible to its owner.
    const sql = this.meta("migrated") === "done" ? `${CALLS_BY_KEY} ORDER BY k.created_at DESC LIMIT ?`
      : "SELECT row_json FROM phone_calls ORDER BY created_at DESC LIMIT ?";
    return readRows(this.db.prepare(sql).all(Math.max(1, callLimit(limit, 200))));
  }

  firstUncertain(): CallRow | undefined {
    return readRows(this.db.prepare(`SELECT row_json FROM phone_calls INDEXED BY phone_calls_live
      WHERE status = 'uncertain' AND status IN ${LIVE} LIMIT 1`).all())[0];
  }

  duePending(now: number, limit = 8): CallRow[] {
    return readRows(this.db.prepare(`${CALLS_BY_KEY} WHERE k.reconcile_due <= ? ORDER BY k.reconcile_due LIMIT ?`).all(now, callLimit(limit, 8)));
  }

  markReconcileMiss(id: string, now: number, onLastMiss?: OnLastReconcileMiss): void {
    this.atomic(() => {
      const row = this.get(id);
      if (!row || !needsReconcile(row)) return false;
      const key = this.db.prepare("SELECT reconcile_misses FROM phone_call_keys WHERE id = ?").get(id) as { reconcile_misses: number } | undefined;
      const misses = (key?.reconcile_misses ?? 0) + 1;
      const due = nextReconcileMiss(misses, now);
      const next = { ...row, reconcileScan: undefined };
      if (due === null) next.abandonCancel = "not_found";
      const terminal = due === null ? onLastMiss?.(next) : undefined;
      if (!this.updateRow(next, { reconcileDue: due })) return false;
      if (terminal?.booking && (terminal.booking.id === id || !this.updateRow(terminal.booking))) return false;
      this.db.prepare("UPDATE phone_call_keys SET reconcile_misses = ? WHERE id = ?").run(misses, id);
      this.within(terminal);
      return true;
    });
  }

  revisionLive(revision: number): boolean {
    if (this.meta("migrated") !== "done") throw new Error("migration_incomplete");
    return !!this.db.prepare(`SELECT 1 FROM phone_call_keys WHERE revision = ? AND status IN ${LIVE} LIMIT 1`).get(revision);
  }

  liveByIdentity(botId: string, identity: string): CallRow | undefined {
    return readRows(this.db.prepare(`${CALLS_BY_KEY} WHERE k.bot_id = ? AND k.identity = ? AND k.status IN ${LIVE}
      LIMIT 1`).all(botId, identity))[0];
  }

  byIntent(botId: string, intent: string, identity: string): CallRow | undefined {
    return readRows(this.db.prepare(`${CALLS_BY_KEY} WHERE k.bot_id = ? AND k.intent = ? AND k.identity = ? LIMIT 1`).all(botId, intent, identity))[0];
  }

  analysisDue(now: number, limit = 8): CallRow[] {
    return readRows(this.db.prepare(`${CALLS_BY_KEY} WHERE k.analysis_due <= ? ORDER BY k.analysis_due LIMIT ?`).all(now, callLimit(limit, 8)));
  }

  scheduledOlderThan(revision: number, limit = 50): CallRow[] {
    return readRows(this.db.prepare(`${CALLS_BY_KEY} WHERE k.status = 'scheduled' AND k.revision < ?
      ORDER BY k.revision LIMIT ?`).all(revision, callLimit(limit, 50)));
  }

  countScheduledOlderThan(revision: number, cap = 500): number {
    return (this.db.prepare(`SELECT count(*) AS count FROM (SELECT 1 FROM phone_call_keys WHERE status = 'scheduled'
      AND revision < ? LIMIT ?)`).get(revision, callLimit(cap, 500) + 1) as { count: number }).count;
  }

  liveForBot(botId: string, limit = 50, after = ""): CallRow[] {
    return this.livePage(botId, limit, after);
  }

  liveLegacy(limit = 50, after = ""): CallRow[] {
    return this.livePage(null, limit, after);
  }

  private livePage(botId: string | null, limit: number, after: string): CallRow[] {
    // Archive must see legacy calls before its destructive decision, even while the key table is incomplete.
    if (this.meta("migrated") !== "done") throw new Error("migration_incomplete");
    return readRows(this.db.prepare(`${CALLS_BY_KEY} WHERE k.bot_id IS ? AND k.status IN ${LIVE} AND k.id > ?
      ORDER BY k.id LIMIT ?`).all(botId, after, callLimit(limit, 50)));
  }

  transcriptsOlderThan(cutoff: number, limit = 200): CallRow[] {
    return readRows(this.db.prepare(`${CALLS_BY_KEY} WHERE k.transcript_at < ? ORDER BY k.transcript_at LIMIT ?`).all(cutoff, callLimit(limit, 200)));
  }

  botMayPhone(botId: string): boolean {
    const row = this.db.prepare("SELECT allowed FROM phone_call_bots WHERE bot_id = ?").get(botId) as { allowed: number } | undefined;
    return row ? row.allowed === 1 : PHONE_BOT_DEFAULT;
  }

  setBotMayPhone(botId: string, on: boolean): void {
    this.db.prepare("INSERT INTO phone_call_bots VALUES (?, ?) ON CONFLICT(bot_id) DO UPDATE SET allowed = excluded.allowed").run(botId, on ? 1 : 0);
  }

  meta(key: string): string | undefined {
    const value = (this.db.prepare("SELECT value FROM phone_call_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
    if (key === "migrated" && value === "done" && this.db.prepare("SELECT 1 FROM phone_call_legacy_dirty LIMIT 1").get()) return "dirty";
    return value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO phone_call_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Commit one batch and return whether migration is complete. */
  migrateBatch(): boolean {
    this.atomic(() => {
      const dirty = this.db.prepare("SELECT id FROM phone_call_legacy_dirty ORDER BY id LIMIT 500").all() as { id: string }[];
      if (dirty.length) {
        for (const { id } of dirty) {
          const row = this.get(id);
          this.deleteKeys(id);
          if (row) this.writeKeys(row, { reconcileDue: row.createdAt });
        }
        return true;
      }
      const cursor = this.meta("migrated");
      if (cursor === "done") return false;
      const rows = this.db.prepare("SELECT rowid, row_json FROM phone_calls WHERE rowid > ? ORDER BY rowid LIMIT 500")
        .all(Number(cursor ?? "0")) as { rowid: number; row_json: string }[];
      const insert = this.db.prepare(`${INSERT_KEYS} ON CONFLICT(id) DO NOTHING`);
      for (const { row_json } of rows) {
        const row = parseRow(row_json);
        if (row) {
          insert.run(...this.keyValues(row, needsReconcile(row) ? row.createdAt : null));
          this.writeAbandoned(row);
        }
      }
      this.setMeta("migrated", rows.length < 500 ? "done" : String(rows[rows.length - 1].rowid));
      return true;
    });
    return this.meta("migrated") === "done";
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
