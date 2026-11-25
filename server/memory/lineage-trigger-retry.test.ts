// Lineage trigger retry consumer: lintrig-1020; deferral producer: scperf-p1 (bg-admission.ts).
// LINTRIG 1.0.20: the start-up recall-view rebuild keeps background writes deferred (BG_DEFERRED) at the moment the lineage cache triggers
// are first installed. The refusal was kept as the answer for the whole session: every write dropped the verdict cache. The install must
// happen once background work resumes, from an
// owner look at once and from its own timer without one. Any other failure keeps the per-write fallback (recall-seal-cache-stamp.test.ts).
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { BgDeferred } from '../bg-admission.ts';
import { closeDatabase, database, databaseGeneration } from '../database.ts';
import { ioBudget } from '../io-budget.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { capturedMessageVerdict, databaseStamp, lineageTriggersInstalled, prepareLineageCache, replayRowsRead } from './replay-lineage.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { THREAD, freshDataDir } from './testing/recall-fixture.ts';

vi.hoisted(() => vi.resetModules());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); closeDatabase(); });

/** The background budget refuses the trigger setup while `deferred`, as instrumentDatabase's exec does: only for a memory source's write (a
 * look from outside every source is not charged to the background budget). */
function deferTriggerSetup(retryInMs: number): { resume(): void; refusals(): number } {
  let deferred = true, refusals = 0;
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (deferred && ioBudget.currentSource()?.startsWith('memory-') && sql.includes('CREATE TEMP TABLE IF NOT EXISTS lineage_epoch')) { refusals++; throw new BgDeferred(retryInMs); }
    return exec.call(this, sql);
  });
  return { resume: () => { deferred = false; }, refusals: () => refusals };
}
const installedNow = (): boolean => Boolean(database().prepare("SELECT 1 FROM sqlite_temp_master WHERE type='trigger' AND name='lineage_messages_u'").get());

it('a deferred first install is installed by the owner look after background work resumes, and the verdict cache then outlives a write', () => {
  const gate = deferTriggerSetup(60_000);
  freshDataDir('active');
  // the first look happens inside the deferred background source (memory capture at start-up)
  expect(ioBudget.withSource('memory-capture', () => lineageTriggersInstalled())).toBe(false);
  expect(gate.refusals()).toBeGreaterThan(0);
  expect(installedNow()).toBe(false);
  // still deferred: the background caller does not hammer the refused install before its time
  const refused = gate.refusals();
  expect(ioBudget.withSource('memory-capture', () => lineageTriggersInstalled())).toBe(false);
  expect(gate.refusals()).toBe(refused);
  gate.resume();
  // the owner turn's setup looks from outside every background source: installed now, not "every write drops the verdict cache" for good
  expect(lineageTriggersInstalled()).toBe(true);
  expect(installedNow()).toBe(true);
  // the triggers are live: a write to an unrelated table moves the per-write stamp but is not a lineage change
  expect(() => prepareLineageCache()).not.toThrow();
  const epoch = () => Number(database().prepare('SELECT n FROM temp.lineage_epoch').get()?.n);
  const before = epoch(), stamp = databaseStamp();
  database().exec('CREATE TEMP TABLE fixture_unrelated(n INTEGER); INSERT INTO fixture_unrelated VALUES(1)');
  expect(databaseStamp()).not.toBe(stamp);
  expect(epoch()).toBe(before);

  const db = database();
  const scope = db.prepare('SELECT id FROM memory_scopes LIMIT 1').get()!.id;
  db.prepare("INSERT INTO memory_records VALUES('fixture-record',1,?,'constraint','Working evidence.','owner-statement','active',1,1,NULL,NULL,0)").run(scope);
  storeAnchorMessage(db, THREAD, 'fixture-reply', 'A proven reply.', 'bot');
  db.prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES('fixture-receipt',?,'fixture','[{"id":"fixture-record","version":1}]','[]','["fixture-reply"]',0,0,0,'delivered',1)`).run(THREAD);
  const verdict = () => capturedMessageVerdict(LineageAllowance.turn(), THREAD, 'fixture-reply');
  const cold = replayRowsRead();
  expect(verdict()).toEqual({ withheld: false, unproven: false });
  const warm = replayRowsRead();
  expect(warm).toBeGreaterThan(cold);
  storeAnchorMessage(db, THREAD, 'owner-turn', 'Continue.');
  expect(verdict()).toEqual({ withheld: false, unproven: false });
  expect(replayRowsRead()).toBe(warm);
});

it('without any owner look, the install retries on its own timer outside the deferred source, bounded by its backoff', async () => {
  const gate = deferTriggerSetup(1);
  freshDataDir('active');
  expect(ioBudget.withSource('memory-capture', () => lineageTriggersInstalled())).toBe(false);
  expect(installedNow()).toBe(false);
  // no caller at all, and background work still deferred: the retry timer (floor 250 ms, set from inside the deferred source) runs
  // outside that source, where the temp-schema install is not a background write, and installs them
  await vi.waitFor(() => expect(installedNow()).toBe(true), { timeout: 3_000, interval: 50 });
  const refusals = gate.refusals();
  expect(ioBudget.withSource('memory-capture', () => lineageTriggersInstalled())).toBe(true);
  // idempotent: no further attempt once installed
  expect(gate.refusals()).toBe(refusals);
  gate.resume();
});

it('a refusal that is not a deferral keeps the per-write fallback (no retry loop)', async () => {
  const exec = DatabaseSync.prototype.exec;
  let attempts = 0;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql.includes('CREATE TEMP TABLE IF NOT EXISTS lineage_epoch')) { attempts++; throw new Error('fixture broken trigger setup'); }
    return exec.call(this, sql);
  });
  freshDataDir('active');
  expect(lineageTriggersInstalled()).toBe(false);
  const seen = attempts;
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(lineageTriggersInstalled()).toBe(false);
  expect(attempts).toBe(seen);
});

it('the first look inside a transaction cannot mark rolled-back triggers as installed', () => {
  freshDataDir('active');
  const db = database();
  db.exec('BEGIN');
  try {
    expect(lineageTriggersInstalled()).toBe(false);
    expect(installedNow()).toBe(false);
  } finally {
    db.exec('ROLLBACK');
  }
  expect(lineageTriggersInstalled()).toBe(true);
  expect(installedNow()).toBe(true);
});

it('a transaction that outlasts the retry deadline keeps a bounded delay before the next try', async () => {
  const gate = deferTriggerSetup(1);
  freshDataDir('active');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const timer = vi.spyOn(globalThis, 'setTimeout');
  expect(ioBudget.withSource('memory-capture', () => lineageTriggersInstalled())).toBe(false);
  const db = database();
  db.exec('BEGIN');
  try {
    expect(lineageTriggersInstalled()).toBe(false);
    const firstDelay = timer.mock.lastCall?.[1] as number;
    await vi.advanceTimersByTimeAsync(firstDelay);
    expect(installedNow()).toBe(false);
    expect(timer.mock.lastCall?.[1]).toBeGreaterThanOrEqual(firstDelay);
  } finally {
    db.exec('ROLLBACK');
    gate.resume();
  }
  await vi.advanceTimersByTimeAsync(timer.mock.lastCall?.[1] as number);
  expect(installedNow()).toBe(true);
});

it('a retry scheduled on a connection cannot reopen the database after close', async () => {
  deferTriggerSetup(1);
  freshDataDir('active');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const timer = vi.spyOn(globalThis, 'setTimeout');
  expect(ioBudget.withSource('memory-capture', () => lineageTriggersInstalled())).toBe(false);
  const retryDelay = timer.mock.lastCall?.[1] as number;
  closeDatabase();
  const closed = databaseGeneration();
  await vi.advanceTimersByTimeAsync(retryDelay);
  expect(databaseGeneration()).toBe(closed);
});
