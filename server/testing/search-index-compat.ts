// SPDX-License-Identifier: AGPL-3.0-or-later
// Historical RED support only: production never imports this module.
import * as search from '../message-search-index.ts';
import * as wal from '../wal-maintenance.ts';
export const assertWalWriteAdmission = wal.assertWalWriteAdmission ?? (() => {});
import * as tables from '../message-tables.ts';
const ddl = tables.MESSAGE_SEARCH_DDL ?? "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none)";
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export * from '../message-search-index.ts';
export const stopSearchIndex = search.stopSearchIndex ?? (async () => true);
export const startSearchIndex = search.startSearchIndex ?? (() => {});
export const pruneMessageSearchIntents = search.pruneMessageSearchIntents ?? (() => {});
export const SEARCH_FILES = search.SEARCH_FILES ?? ['search.db', 'search.db-wal', 'search.db-shm'];
export const MESSAGE_SEARCH_DDL = search.MESSAGE_SEARCH_DDL ?? ddl;
export const PENDING_MAX = search.PENDING_MAX ?? 2000;
export const PRUNE_PER_COMMIT = search.PRUNE_PER_COMMIT ?? 2;
export const INTENT_MAX_BYTES = search.INTENT_MAX_BYTES ?? 120;
export const messageSearchIndexReady = search.messageSearchIndexReady ?? (() => true);
export const searchCleanupPending = search.searchCleanupPending ?? (() => false);
export const readMessageSearchCandidates = search.readMessageSearchCandidates ?? ((db: DatabaseSync, match: string, cap: number) => ({
  rowids: db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT ?').all(match, cap).map(row => Number(row.rowid)), partial: false,
}));
export const intentCount = search.intentCount ?? ((db: DatabaseSync) => db.prepare("SELECT 1 FROM sqlite_master WHERE name='search_intents'").get()
  ? Number(db.prepare('SELECT COUNT(*) AS n FROM search_intents').get()!.n) : 0);
export const searchDbPath = search.searchDbPath ?? ((dir: string) => join(dir, existsSync(join(dir, 'search.db')) ? 'search.db' : 'messages.db'));
export const openSearchIndex = search.openSearchIndex ?? ((dir: string) => new DatabaseSync(searchDbPath(dir), { readOnly: true }));
export const recovery = search.recovery ?? (() => { throw new Error('recovery observations require the amended worker fixture'); });
export const scrubDelay = search.scrubDelay ?? ((n: number) => Math.min(50 * 2 ** Math.min(Math.max(0, n - 1), 10), 30000));
export const searchIndexTestHooks = search.searchIndexTestHooks ?? {
  event: null, barrier: null, halted: false, failStart: false, candidateSnapshot: null, fence: () => false, now: () => Date.now(), recovery,
};
// A historical tree has no worker module. Reading source here avoids a link error;
// historical tests must reach their behavioural assertions before using a worker.
const workerPath = join(process.cwd(), 'server/search-index-worker.ts');
export const SEARCH_INDEX_WORKER_SOURCE = existsSync(workerPath)
  ? readFileSync(workerPath, 'utf8').split('= String.raw`')[1].slice(0, -3).replaceAll('workerData.scrubDelaySource', JSON.stringify(scrubDelay.toString())) : '';

export const SEARCH_RECOVERY_CONSECUTIVE = search.SEARCH_RECOVERY_CONSECUTIVE ?? 8;
export const SEARCH_RECOVERY_WINDOW_MS = search.SEARCH_RECOVERY_WINDOW_MS ?? 24*3600_000;
export const SEARCH_RECOVERY_WINDOW_MAX = search.SEARCH_RECOVERY_WINDOW_MAX ?? 12;
export const searchRetryDelay = search.searchRetryDelay ?? ((n:number)=>Math.max(10,Math.min(30000,n)));
