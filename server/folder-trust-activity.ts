// Producer: FUIGO-TRUST-V2 store seat. Consumers: ACP driver (record), Settings/API (last), message-db (thread deletion).
// Derived activity only: a row is a report of what a turn observed, never authority for a configuration grant.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { database, transaction } from './database.ts';

export const FOLDER_TRUST_ACTIVITY_KINDS = ['process-choice-sent', 'saved-choice-sent', 'configuration-withheld', 'unknown'] as const;
export type FolderTrustActivityKind = (typeof FOLDER_TRUST_ACTIVITY_KINDS)[number];
/** Fixed local codes. A reason never carries a path, a name or an environment value. */
export const FOLDER_TRUST_ACTIVITY_REASONS = [
  'none', 'authority-unavailable', 'store-unreadable', 'seed-not-durable', 'version-unsupported', 'not-picked',
  'saved-decline', 'coverage-incomplete', 'ineligible-origin', 'reply-failed', 'unsafe-key', 'unsupported-scope', 'inactive-turn',
] as const;
export type FolderTrustActivityReason = (typeof FOLDER_TRUST_ACTIVITY_REASONS)[number];
export interface FolderTrustActivityRow {
  threadId: string; kind: FolderTrustActivityKind; revision: string; keyDigest: string;
  observation: FolderTrustActivityKind; reason: FolderTrustActivityReason; recordedAt: number;
  /** Which engine instance and generation saw it: Settings never shows a key's report from another instance. */
  instanceId?: string; generation?: 1 | 2; destination?: FolderTrustActivityDestination;
}
export type FolderTrustActivityDestination = 'own-local-home' | 'per-turn-local-home' | 'cloud-home' | 'refused';
export interface FolderTrustActivityIdentity { instanceId?: string; generation?: 1 | 2; destination?: FolderTrustActivityDestination }
const IDENTITY_COLUMNS = ['instance_id TEXT', 'generation INTEGER', 'destination TEXT'] as const;

/** The only digest a row carries for a folder key. */
export const folderTrustKeyDigest = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

const DDL = `CREATE TABLE IF NOT EXISTS thread_folder_trust_activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL, kind TEXT NOT NULL, revision TEXT NOT NULL, key_digest TEXT NOT NULL,
  observation TEXT NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  UNIQUE(thread_id, kind, revision, key_digest))`;
const initialized = new WeakSet<DatabaseSync>();
export function initializeFolderTrustActivity(db: DatabaseSync): void {
  if (initialized.has(db)) return;
  db.exec(DDL);
  const have = new Set((db.prepare('PRAGMA table_info(thread_folder_trust_activity)').all() as { name: string }[]).map((c) => c.name));
  for (const column of IDENTITY_COLUMNS) if (!have.has(column.split(' ')[0]!)) db.exec(`ALTER TABLE thread_folder_trust_activity ADD COLUMN ${column}`);
  db.exec('CREATE INDEX IF NOT EXISTS thread_folder_trust_activity_last ON thread_folder_trust_activity(thread_id, seq)');
  if (!db.isTransaction) initialized.add(db);
}

/** One row per (thread, kind, decision revision, key digest). Repeating the same tuple is a no-op for
 * the once-only claim (returns false) and only moves the "last turn" marker. A bad code or digest throws. */
export function recordActivity(threadId: string, kind: FolderTrustActivityKind, revision: string, keyDigest: string,
  observation: FolderTrustActivityKind, reason: FolderTrustActivityReason, db: DatabaseSync = database(), identity: FolderTrustActivityIdentity = {}): boolean {
  if (!FOLDER_TRUST_ACTIVITY_KINDS.includes(kind) || !FOLDER_TRUST_ACTIVITY_KINDS.includes(observation)) throw new Error('Unknown folder trust activity kind');
  if (!FOLDER_TRUST_ACTIVITY_REASONS.includes(reason)) throw new Error('Unknown folder trust activity reason');
  if (!/^[0-9a-f]{64}$/.test(keyDigest) || revision.length === 0 || revision.length > 128) throw new Error('Folder trust activity needs a key digest and a revision');
  const write = (target: DatabaseSync): boolean => {
    initializeFolderTrustActivity(target);
    const first = target.prepare('INSERT OR IGNORE INTO thread_folder_trust_activity(thread_id,kind,revision,key_digest,observation,reason,recorded_at,instance_id,generation,destination) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(threadId, kind, revision, keyDigest, observation, reason, Date.now(), identity.instanceId ?? null, identity.generation ?? null, identity.destination ?? null).changes === 1;
    if (!first) target.prepare('UPDATE thread_folder_trust_activity SET seq=(SELECT COALESCE(MAX(seq),0)+1 FROM thread_folder_trust_activity), observation=?, reason=?, recorded_at=?, instance_id=?, generation=?, destination=? WHERE thread_id=? AND kind=? AND revision=? AND key_digest=?')
      .run(observation, reason, Date.now(), identity.instanceId ?? null, identity.generation ?? null, identity.destination ?? null, threadId, kind, revision, keyDigest);
    return first;
  };
  return db.isTransaction ? write(db) : db === database() ? transaction(write) : write(db);
}

/** The most recent observation for the thread, by one point read. */
export function lastActivity(threadId: string, db: DatabaseSync = database()): FolderTrustActivityRow | null {
  initializeFolderTrustActivity(db);
  const row = db.prepare('SELECT kind, revision, key_digest AS keyDigest, observation, reason, recorded_at AS recordedAt, instance_id AS instanceId, generation, destination FROM thread_folder_trust_activity WHERE thread_id=? ORDER BY seq DESC LIMIT 1')
    .get(threadId) as Omit<FolderTrustActivityRow, 'threadId'> | undefined;
  if (!row) return null;
  const { instanceId, generation, destination, ...rest } = row as typeof row & { instanceId: string | null; generation: 1 | 2 | null; destination: FolderTrustActivityDestination | null };
  return { threadId, ...rest, ...(instanceId ? { instanceId } : {}), ...(generation ? { generation } : {}), ...(destination ? { destination } : {}) };
}

/** Called inside the thread-deletion transaction. */
export function deleteFolderTrustActivity(db: DatabaseSync, threadId: string): void {
  initializeFolderTrustActivity(db);
  db.prepare('DELETE FROM thread_folder_trust_activity WHERE thread_id=?').run(threadId);
}
