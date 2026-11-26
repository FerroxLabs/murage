// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (memory-revocation.ts storage park reset backoff and owner notice). Consumer owner: the owner notice route
// (GET /api/deletions/owed) and every hold the parked runner keeps.
// 1.0.22 MUST-FIX item 3 (HIDDEN-COST-opus section 4, HIDDEN-COST-fable M17): after REVOKE_STORAGE_SELF_RESETS resets the runner parked with
// parkResetAt=+Infinity until a restart or an owner Forget, every hold kept and only the console told.
import { mkdirSync, truncateSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import * as runner from './memory-revocation.ts';
import { memoryRevocationStats, resetMemoryRevocationStats, stopMemoryRevocation, wakeMemoryRevocation } from './memory-revocation.ts';

const FILE = () => `${DATA_DIR}/messages.db`;
const opened: DatabaseSync[] = [];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetMemoryRevocationStats(); });
afterEach(async () => {
  vi.useRealTimers(); stopMemoryRevocation(); vi.restoreAllMocks();
  for (const db of opened.splice(0)) { try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* broken on purpose */ } try { db.close(); } catch { /* closed */ } }
  closeDatabase(); await stopWalMaintenance();
});
const notices = (): Array<{ id: string }> =>
  ((runner as unknown as Record<string, unknown>).revokeHealthNotices as ((db: unknown) => Array<{ id: string }>) | undefined)?.(null) ?? [];

/** A connection whose log index names frames the log no longer has: every statement's first page read is past the end of the file, a
 * real and lasting SQLITE_IOERR_SHORT_READ (what the field log shows: the same "disk I/O error" on every retry for hours). */
function brokenConnection(): DatabaseSync {
  const db = database();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('CREATE TABLE w1022_tail(x)'); // page 1 (the schema) now lives only in the log
  truncateSync(`${FILE()}-wal`, 0); // the server connection keeps the index alive: no recovery runs for the next open
  const broken = new DatabaseSync(FILE(), { timeout: 50 }); opened.push(broken);
  let message = '';
  try { broken.prepare('SELECT count(*) FROM sqlite_schema').get(); } catch (error) { message = String((error as Error).message); }
  expect(message).toMatch(/disk I\/O error/);
  return broken;
}

it('W-PARK-NO-INFINITY a runner parked on a lasting storage failure keeps resetting with a doubling delay past its self resets (never +Infinity), and the owner is told while it is parked', async () => {
  const broken = brokenConnection();
  await stopWalMaintenance();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  wakeMemoryRevocation(() => broken, { retryMs: 5, pauseMs: 5 });
  // two hours on the runner's own clock: resets at 5, 10, 15 min (the self resets), then 25, 45, 85 min (doubling)
  for (let minute = 0; minute < 120; minute++) await vi.advanceTimersByTimeAsync(60_000);
  // the behaviour: base 68ed0def17 parks at +Infinity after its 3 resets, so it never tries again within the process
  expect(memoryRevocationStats.storageResets).toBeGreaterThanOrEqual(5);
  expect(memoryRevocationStats.storageParks).toBeGreaterThanOrEqual(6);
  // bounded: the doubling keeps it far from a retry loop (base 1.0.21 retried every few ms)
  expect(memoryRevocationStats.storageParks).toBeLessThanOrEqual(8);
  expect(memoryRevocationStats.parkedNow).toBe(1);
  expect(notices().map(notice => notice.id)).toContain('revoke:storage');
}, 120_000);
