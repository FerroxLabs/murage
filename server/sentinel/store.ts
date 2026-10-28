// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The scanner-owned store, <outputRoot>/state.sqlite (1.0.9, GAP-SENTINEL-109 sections 6.3, 8.4 and 9).
//
// One ordinary-journal SQLite file, separate from every source database, holding source cursors, per-detector state,
// issue records (at most 256 rows plus a fixed overflow summary; resolved rows kept 30 days), page/digest intents,
// pending detector results (the checkpoint used when a scan has more changes than one commit may carry), self-health,
// the heartbeat, the page ledger and the write token bucket. Everything a scan changes is committed in ONE transaction.
//
// Schema version lives in PRAGMA user_version. A known older version migrates transactionally after one previous
// checkpoint (state.previous.sqlite, VACUUM INTO). An unknown (newer) version opens read-only: the caller keeps the last
// view, reports upgrade-needed and stops writing. A corrupt or foreign file is preserved untouched and reported
// unavailable; nothing here discards it, or any intent, automatically.
import { closeSync, lstatSync, openSync, rmSync } from "node:fs";
import { posix, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import type { PersistedDetectorState } from "./detectors/index.ts";
import type { IssueRecord, PageLedger } from "./lifecycle.ts";
import type { ProducerCursor, ProducerKey } from "./sources.ts";
import type { DetectorId, DetectorResult, Severity } from "./types.ts";

export const STORE_FILE = "state.sqlite";
export const STORE_PREVIOUS_FILE = "state.previous.sqlite";
export const STORE_SCHEMA_VERSION = 1;
export const PENDING_MAX = HEALTH_LIMITS.issueRows;
export const INTENTS_MAX = 512;
export const INTENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const PAGE_BYTES = 4096;

export type StoreStatus = "ok" | "upgrade-needed" | "corrupt" | "foreign" | "unavailable";
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({ low: 1, medium: 2, high: 3 });

/** A page or digest intent committed with the issue change that produced it (section 8.4). Delivery state lives in the
 * host's separate delivery ledger, never here. */
export interface DeliveryIntent {
  id: string;
  revision: number;
  fingerprint: string;
  episode: number;
  delivery: "page" | "digest";
  reason: "page" | "cooldown" | "cap" | "opened" | "recovered";
  titleKey: string;
  createdAt: number;
}

export interface PendingResult { seq: number; detectorId: DetectorId; detectorVersion: number; result: DetectorResult }

/** Scanner self-health, committed with each scan that writes. */
export interface SelfHealth {
  lastScanAt: number | null;
  lastCommitAt: number | null;
  lastCompleteAt: number | null;
  lastStop: string | null;
  budgetStops: number;
  overflow: { count: number; lastAt: number | null };
}

export interface StoreChanges {
  meta?: Record<string, unknown>;
  cursors?: Partial<Record<ProducerKey, ProducerCursor | null>>;
  detectorStates?: Partial<Record<DetectorId, PersistedDetectorState>>;
  issues?: IssueRecord[];
  removeIssues?: string[];
  intents?: Omit<DeliveryIntent, "revision">[];
  pendingAdd?: Omit<PendingResult, "seq">[];
  pendingRemove?: number[];
  pruneIntentsBefore?: number;
}

export type Migration = (db: DatabaseSync) => void;

/** Schema steps by target version. Version 1 is the first shipped schema. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({
  1: (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE cursors(producer TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE detector_state(id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE issues(fingerprint TEXT PRIMARY KEY, open INTEGER NOT NULL, rank INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        resolved_at INTEGER, presented INTEGER NOT NULL, record TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX issues_page ON issues(open, rank DESC, last_seen_at DESC, fingerprint);
      CREATE INDEX issues_resolved ON issues(open, resolved_at);
      CREATE TABLE intents(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, episode INTEGER NOT NULL,
        delivery TEXT NOT NULL, reason TEXT NOT NULL, title_key TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE INDEX intents_revision ON intents(revision, id);
      CREATE INDEX intents_created ON intents(created_at);
      CREATE TABLE pending(seq INTEGER PRIMARY KEY, detector TEXT NOT NULL, version INTEGER NOT NULL, result TEXT NOT NULL);
    `);
  },
});

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(text: unknown): T | null => { if (typeof text !== "string") return null; try { return JSON.parse(text) as T; } catch { return null; } };

export interface OpenStoreOptions {
  installationId: string;
  platform?: NodeJS.Platform;
  /** Open without creating or migrating (owner API reads). */
  readOnly?: boolean;
  migrations?: Readonly<Record<number, Migration>>;
  targetVersion?: number;
}

export type OpenStoreResult = { status: "ok"; store: SentinelStore } | { status: Exclude<StoreStatus, "ok">; store: SentinelStore | null; reason: string };

/** True for an issue shown under another issue's row while that presenter is open (section 6.1). */
const PRESENTER_OPEN = "presented = 1 AND EXISTS (SELECT 1 FROM issues p WHERE p.fingerprint = json_extract(issues.record, '$.issue.presentedBy') AND p.open = 1)";

export class SentinelStore {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly readOnly: boolean;

  private constructor(db: DatabaseSync, path: string, readOnly: boolean) {
    this.db = db;
    this.path = path;
    this.readOnly = readOnly;
  }

  /** Opens (creating and migrating when allowed) the store in `outputRoot`. Never throws. */
  static open(outputRoot: string, options: OpenStoreOptions): OpenStoreResult {
    const platform = options.platform ?? process.platform;
    const p = pathFor(platform);
    const path = p.join(outputRoot, STORE_FILE);
    const migrations = options.migrations ?? MIGRATIONS;
    const target = options.targetVersion ?? STORE_SCHEMA_VERSION;
    let exists = true;
    try { const st = lstatSync(path); if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return { status: "unavailable", store: null, reason: "not-regular" }; }
    catch { exists = false; }
    if (!exists) {
      if (options.readOnly) return { status: "unavailable", store: null, reason: "missing" };
      try { closeSync(openSync(path, "wx", 0o600)); } catch { return { status: "unavailable", store: null, reason: "create" }; }
    }
    let db: DatabaseSync;
    try { db = new DatabaseSync(path, { readOnly: options.readOnly === true, timeout: 0, allowExtension: false }); }
    catch { return { status: "corrupt", store: null, reason: "open" }; }
    const store = new SentinelStore(db, path, options.readOnly === true);
    try {
      const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      const tables = Number((db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n);
      if (version > target) return { status: "upgrade-needed", store: store.asReadOnly(), reason: `version-${version}` };
      if (version === 0 && tables > 0) { store.close(); return { status: "corrupt", store: null, reason: "unversioned" }; }
      if (version < target) {
        if (options.readOnly) { store.close(); return { status: "unavailable", store: null, reason: "not-migrated" }; }
        for (let v = version + 1; v <= target; v++) if (!migrations[v]) { store.close(); return { status: "upgrade-needed", store: null, reason: `no-migration-${v}` }; }
        if (version > 0) {
          // One previous checkpoint, replaced each migration.
          const previous = p.join(outputRoot, STORE_PREVIOUS_FILE);
          rmSync(previous, { force: true });
          db.prepare("VACUUM INTO ?").run(previous);
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          for (let v = version + 1; v <= target; v++) migrations[v]!(db);
          db.exec(`PRAGMA user_version=${target}`);
          if (version === 0) db.prepare("INSERT INTO meta(key, value) VALUES('installation_id', ?)").run(json(options.installationId));
          db.exec("COMMIT");
        } catch {
          // The old schema and data stay exactly as they were; this scanner cannot use them.
          try { db.exec("ROLLBACK"); } catch { /* none open */ }
          store.close();
          return { status: "unavailable", store: null, reason: "migration" };
        }
      }
      const owner = store.meta<string>("installation_id");
      if (owner !== options.installationId) { store.close(); return { status: "foreign", store: null, reason: "installation" }; }
      return { status: "ok", store };
    } catch {
      store.close();
      return { status: "corrupt", store: null, reason: "read" };
    }
  }

  /** Reopens this store read-only (an unknown schema is read for the last view but never written). */
  private asReadOnly(): SentinelStore | null {
    this.close();
    try { return new SentinelStore(new DatabaseSync(this.path, { readOnly: true, timeout: 0, allowExtension: false }), this.path, true); }
    catch { return null; }
  }

  close(): void { try { if (this.db.isOpen) this.db.close(); } catch { /* closed */ } }

  meta<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? parse<T>(row.value) : null;
  }

  revision(): number { return this.meta<number>("revision") ?? 0; }

  cursor(producer: ProducerKey): ProducerCursor | null {
    const row = this.db.prepare("SELECT value FROM cursors WHERE producer = ?").get(producer) as { value: string } | undefined;
    return row ? parse<ProducerCursor>(row.value) : null;
  }

  detectorStates(): Partial<Record<DetectorId, PersistedDetectorState>> {
    const out: Partial<Record<DetectorId, PersistedDetectorState>> = {};
    for (const row of this.db.prepare("SELECT id, version, state FROM detector_state LIMIT 32").all() as Array<{ id: DetectorId; version: number; state: string }>) {
      const state = parse<PersistedDetectorState["state"]>(row.state);
      if (state) out[row.id] = { version: row.version, state };
    }
    return out;
  }

  issue(fingerprint: string): IssueRecord | null {
    const row = this.db.prepare("SELECT record FROM issues WHERE fingerprint = ?").get(fingerprint) as { record: string } | undefined;
    return row ? parse<IssueRecord>(row.record) : null;
  }

  issueCount(): number { return Number((this.db.prepare("SELECT count(*) AS n FROM issues").get() as { n: number }).n); }

  /** Oldest resolved fingerprints (eviction candidates), bounded. */
  oldestResolved(limit: number): string[] {
    return (this.db.prepare("SELECT fingerprint FROM issues WHERE open = 0 ORDER BY resolved_at ASC, fingerprint LIMIT ?").all(limit) as Array<{ fingerprint: string }>).map(r => r.fingerprint);
  }

  /** Resolved issues past the 30-day retention, bounded per call. */
  expiredResolved(now: number, limit: number): string[] {
    return (this.db.prepare("SELECT fingerprint FROM issues WHERE open = 0 AND resolved_at < ? ORDER BY resolved_at ASC LIMIT ?").all(now - HEALTH_LIMITS.resolvedRetentionMs, limit) as Array<{ fingerprint: string }>).map(r => r.fingerprint);
  }

  /** Top rows for the published view: unresolved first by severity and recency, then recent recoveries. Bounded. */
  viewIssues(limit: number): IssueRecord[] {
    // A presented issue shows under its presenter's row only while that presenter is open; otherwise it has its own row
    // (presentedBy is dropped from the returned record, so the view never hides it).
    const rows = this.db.prepare(`SELECT record FROM issues WHERE NOT (${PRESENTER_OPEN}) ORDER BY open DESC, rank DESC, last_seen_at DESC, fingerprint LIMIT ?`).all(limit) as Array<{ record: string }>;
    const out: IssueRecord[] = [];
    for (const row of rows) {
      const record = parse<IssueRecord>(row.record);
      if (!record) continue;
      if (record.issue.presentedBy === undefined) { out.push(record); continue; }
      const issue = { ...record.issue };
      delete issue.presentedBy;
      out.push({ ...record, issue });
    }
    return out;
  }

  unresolvedCounts(): { open: number; byRank: Record<number, number> } {
    const rows = this.db.prepare(`SELECT rank, count(*) AS n FROM issues WHERE open = 1 AND NOT (${PRESENTER_OPEN}) GROUP BY rank`).all() as Array<{ rank: number; n: number }>;
    const byRank: Record<number, number> = {};
    let open = 0;
    for (const row of rows) { byRank[row.rank] = Number(row.n); open += Number(row.n); }
    return { open, byRank };
  }

  pending(limit = PENDING_MAX): PendingResult[] {
    const rows = this.db.prepare("SELECT seq, detector, version, result FROM pending ORDER BY seq LIMIT ?").all(limit) as Array<{ seq: number; detector: DetectorId; version: number; result: string }>;
    return rows.flatMap(r => { const result = parse<DetectorResult>(r.result); return result ? [{ seq: r.seq, detectorId: r.detector, detectorVersion: r.version, result }] : []; });
  }

  pendingCount(): number { return Number((this.db.prepare("SELECT count(*) AS n FROM pending").get() as { n: number }).n); }

  pageLedger(): PageLedger { return this.meta<PageLedger>("page_ledger") ?? { attempts: [] }; }

  selfHealth(): SelfHealth {
    return this.meta<SelfHealth>("self_health") ?? { lastScanAt: null, lastCommitAt: null, lastCompleteAt: null, lastStop: null, budgetStops: 0, overflow: { count: 0, lastAt: null } };
  }

  /** Bytes a commit of `changes` is charged: logical bytes written twice (rollback journal + database) plus page and
   * header overhead. A portable estimate; the daily bucket and the per-commit cap are applied to it. */
  static estimateCharge(changes: StoreChanges): number {
    let bytes = 0;
    for (const [key, value] of Object.entries(changes.meta ?? {})) bytes += key.length + json(value).length + 16;
    for (const value of Object.values(changes.cursors ?? {})) bytes += json(value).length + 16;
    for (const value of Object.values(changes.detectorStates ?? {})) bytes += json(value).length + 16;
    for (const record of changes.issues ?? []) bytes += json(record).length + 96;
    bytes += (changes.removeIssues ?? []).length * 80;
    for (const intent of changes.intents ?? []) bytes += json(intent).length + 32;
    for (const pending of changes.pendingAdd ?? []) bytes += json(pending.result).length + 32;
    bytes += (changes.pendingRemove ?? []).length * 16;
    return bytes * 2 + 3 * PAGE_BYTES;
  }

  /** Applies every change in one transaction and bumps the store revision. Answers the new revision. Throws (after a
   * rollback) on failure, leaving the previous committed state intact. */
  commit(changes: StoreChanges): number {
    if (this.readOnly) throw new Error("SENTINEL_STORE_READ_ONLY");
    const db = this.db;
    const revision = this.revision() + 1;
    db.exec("BEGIN IMMEDIATE");
    try {
      const setMeta = db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      for (const [key, value] of Object.entries(changes.meta ?? {})) setMeta.run(key, json(value));
      setMeta.run("revision", json(revision));
      const setCursor = db.prepare("INSERT INTO cursors(producer, value) VALUES(?, ?) ON CONFLICT(producer) DO UPDATE SET value = excluded.value");
      for (const [producer, cursor] of Object.entries(changes.cursors ?? {})) {
        if (cursor === null) db.prepare("DELETE FROM cursors WHERE producer = ?").run(producer);
        else if (cursor) setCursor.run(producer, json(cursor));
      }
      const setState = db.prepare("INSERT INTO detector_state(id, version, state) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, state = excluded.state");
      for (const [id, persisted] of Object.entries(changes.detectorStates ?? {})) if (persisted) setState.run(id, persisted.version, json(persisted.state));
      const setIssue = db.prepare(`INSERT INTO issues(fingerprint, open, rank, last_seen_at, resolved_at, presented, record) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET open = excluded.open, rank = excluded.rank, last_seen_at = excluded.last_seen_at,
        resolved_at = excluded.resolved_at, presented = excluded.presented, record = excluded.record`);
      for (const record of changes.issues ?? []) {
        const issue = record.issue;
        setIssue.run(issue.fingerprint, issue.state === "resolved" ? 0 : 1, SEVERITY_RANK[issue.severity], issue.lastSeenAt, issue.resolvedAt ?? null, issue.presentedBy ? 1 : 0, json(record));
      }
      const delIssue = db.prepare("DELETE FROM issues WHERE fingerprint = ?");
      for (const fp of changes.removeIssues ?? []) delIssue.run(fp);
      const addIntent = db.prepare("INSERT OR IGNORE INTO intents(id, revision, fingerprint, episode, delivery, reason, title_key, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)");
      for (const i of changes.intents ?? []) addIntent.run(i.id, revision, i.fingerprint, i.episode, i.delivery, i.reason, i.titleKey, i.createdAt);
      if (changes.pruneIntentsBefore !== undefined) db.prepare("DELETE FROM intents WHERE created_at < ?").run(changes.pruneIntentsBefore);
      // Fixed ceiling on intents: oldest beyond INTENTS_MAX go (they are digest/page inputs, not delivery receipts).
      db.prepare("DELETE FROM intents WHERE id IN (SELECT id FROM intents ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)").run(INTENTS_MAX);
      const delPending = db.prepare("DELETE FROM pending WHERE seq = ?");
      for (const seq of changes.pendingRemove ?? []) delPending.run(seq);
      const addPending = db.prepare("INSERT INTO pending(detector, version, result) VALUES(?, ?, ?)");
      for (const pending of changes.pendingAdd ?? []) addPending.run(pending.detectorId, pending.detectorVersion, json(pending.result));
      db.exec("COMMIT");
      return revision;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* nothing open */ }
      throw error;
    }
  }
}
