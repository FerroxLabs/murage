// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane deep1022-withheld-fable owns this witness and the runner's source rule it pins (memory-revocation.ts unsourced tick and
// wake); io-budget.ts owns the source context (withSource, withoutSource) and the background write gate; revoke-wake.ts owns the timer.
//
// 1.0.22 release gate (field log of 1.0.21, no chat text): "[memory] revocation job: BG_DEFERRED; trying again" 105 times in 27 hours,
// with zero disk I/O errors in the last hours, and every owner turn in between read "fence recovery ... cause=checking" then
// "turn dispatch recall=withheld". The revocation runner has no background admission of its own (it is paced by its own ledger,
// revoke-budget.ts). Its wake (wakeIfStarted: a microtask) and its deadline timer (revoke-wake.ts) are created inside whatever
// AsyncLocalStorage store the committing writer runs in. When that writer is a memory worker slice (io-budget.ts withSource
// "memory-worker", "memory-capture", ...), every later tick of the runner runs as that background source: its writes meet the
// background byte gate (io-budget.ts beforeWrite), and once that slice was refused a write inside a transaction (afterWrite ->
// deferCurrentSlice; a spent minute alone refuses through refusalRetry, not sticky) the store's `deferred` is sticky, so
// every tick throws BG_DEFERRED for as long as the timer chain lives. The revoke's '*' window never closes and every chat reads
// checking:pending.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { ioBudget } from '../io-budget.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { memoryRevocationStats, resetMemoryRevocationStats, stopMemoryRevocation, wakeIfStarted, wakeMemoryRevocation } from './memory-revocation.ts';
import { resetRevokeWriteBudget } from './revoke-budget.ts';
import { commitRevoke } from './revoke-commit.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetMemoryRevocationStats(); resetRevokeWriteBudget(); });
afterEach(async () => { stopMemoryRevocation(); vi.restoreAllMocks(); closeDatabase(); await stopWalMaintenance(); resetRevokeWriteBudget(); });

const pendingRows = () => Number(database().prepare("SELECT (SELECT count(*) FROM memory_deny_pending) + (SELECT count(*) FROM memory_deny_pending_scope) AS n").get()!.n);
async function settle(ms: number, done: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !done()) await new Promise(resolve => setTimeout(resolve, 50));
}
/** The owner forgets one line of a chat (the real commit: its job row and its '*' windows), not marked inline: the runner owns the walk. */
function queueRevoke(): void {
  const db = database();
  db.exec('BEGIN IMMEDIATE');
  try { commitRevoke(db, { kind: 'line', threadId: 'fixture-thread', messageIds: ['fixture-line'], cause: 'forget' }, { inline: false }); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

// One row per background source a committing writer runs under in production (grep withSource("memory-: worker-controller.ts, capture).
const SOURCES = ['memory-worker', 'memory-capture', 'memory-idle', 'memory-continuity'] as const;
it.each(SOURCES)('W-RUNNER-SOURCE a revoke whose wake comes from a refused %s slice is still walked to its end: its windows close, no BG_DEFERRED retry', async source => {
  const db = database();
  await stopWalMaintenance();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  wakeMemoryRevocation(() => db, { retryMs: 5, pauseMs: 5, busy: () => false }); // the start at listen: nothing queued, the runner idles
  await new Promise(resolve => setTimeout(resolve, 100));
  // a background slice commits a revoke (its commit wakes the runner: wakeIfStarted), then is refused a write: the slice is deferred
  ioBudget.withSource(source, () => { queueRevoke(); wakeIfStarted(); ioBudget.deferCurrentSlice(); });
  expect(pendingRows()).toBeGreaterThan(0); // the commit's '*' windows stand: every chat reads checking:pending until the walk ends
  await settle(8_000, () => pendingRows() === 0);
  const deferred = warn.mock.calls.map(call => String(call[0])).filter(line => line === '[memory] revocation job: BG_DEFERRED; trying again');
  // base (435d038d9c + revoke-ioerr + withheld-compaction): the tick runs inside the refused slice's store, every write throws
  // BG_DEFERRED, the windows stay
  expect({ windows: pendingRows(), deferredRetries: deferred.length }).toEqual({ windows: 0, deferredRetries: 0 });
  expect(memoryRevocationStats.errorRetries).toBe(0);
}, 30_000);

it('W-RUNNER-UNSOURCED a tick woken from a background slice that was NOT refused runs under no source at all (not as the slice, not as a named one): its writes never meet the background gate', async () => {
  const db = database();
  await stopWalMaintenance();
  const seen = new Set<string>();
  wakeMemoryRevocation(() => db, { retryMs: 5, pauseMs: 5, busy: () => false, admit: async () => { seen.add(String(ioBudget.currentSource())); } });
  await new Promise(resolve => setTimeout(resolve, 100));
  seen.clear();
  ioBudget.withSource('memory-worker', () => { queueRevoke(); wakeIfStarted(); });
  await settle(8_000, () => pendingRows() === 0);
  // base: every tick of the walk reads 'memory-worker' here (the runner's own admission hook runs first in each tick)
  expect({ windows: pendingRows(), sources: [...seen] }).toEqual({ windows: 0, sources: ['undefined'] });
}, 30_000);

it('W-RUNNER-SOURCE-CONTROL a background slice that is refused a write still defers its OWN writes (the gate is not opened for the worker)', () => {
  const db = database();
  db.exec('CREATE TABLE IF NOT EXISTS w1022_source_control(id INTEGER PRIMARY KEY)');
  let failure: unknown = null;
  ioBudget.withSource('memory-worker', () => {
    ioBudget.deferCurrentSlice();
    try { db.prepare('INSERT INTO w1022_source_control DEFAULT VALUES').run(); } catch (error) { failure = error; }
  });
  expect(String((failure as Error | null)?.message)).toBe('BG_DEFERRED');
  expect(Number(db.prepare('SELECT count(*) AS n FROM w1022_source_control').get()!.n)).toBe(0);
});
