// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: reclaim-1020-n4 (root trigger of the 1.0.20 recall-reclaim storm), landed by closer2-1021 (1.0.21 O11). Reclaimer pacing: recallcap-1020-n3c. Publication fences: recall-scope.
// The 23:00Z owner log: a scheduled routine turn saved its roster (a presentation save: memoryRosterRevision moves, the audience does not) while
// a recall view of the whole history was being built; the build was cancelled (MEMORY_CONTEXT_REVOKED), its partial records/terms/jobs rows
// were reclaimed and the copy started again from the first job, once per save. An import that withdrew nothing (receipts revoked count=0)
// ran alongside. This replays that sequence on a large history and counts every derived row written across all phases.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { OWNER } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { RecallPreparationPending } from './recall-recovery.ts';
import type { RecallViewHandle } from './recall-view.ts';
import { setMemoryMode } from './repository.ts';
import { revokeRecordDisclosures } from './revocation.ts';

const JOBS = 200_000, RECORDS = 3000;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { const views = await import('./recall-view.ts'); views.stopRecallViewMaintenance(); views.setRecallReclaimClockForTest(); closeDatabase(); });

async function history(jobs: number) {
  const views = await import('./recall-view.ts');
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active'); views.stopRecallViewMaintenance();
  const db = database(), scope = ensureScope('conversation', 'direct');
  db.exec('SAVEPOINT fixture');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',0,1,NULL,NULL,1)");
  for (let n = 0; n < RECORDS; n++) put.run(`record-${n}`, scope, `fixture memory ${n} alpha${n} beta${n % 97}`);
  db.prepare(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<?) INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state)
    SELECT 's'||i,?,'direct','m'||i,1,'h','text','owner','recorded','active' FROM c`).run(jobs / 100 - 1, scope);
  db.exec("INSERT INTO memory_source_versions SELECT id,1,'h','{}',0 FROM memory_sources");
  db.prepare(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<?) INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch,error)
    SELECT 'j'||i,'s'||(i%${jobs / 100}),1,'capture','v'||i,'complete',0,0,0,0,0,NULL FROM c`).run(jobs - 1);
  db.exec('RELEASE fixture');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // Every derived row the view work writes, in every phase (records, terms, jobs, pending, scopes), counted by a temp trigger.
  db.exec('CREATE TEMP TABLE written(n INTEGER NOT NULL); INSERT INTO temp.written VALUES(0)');
  for (const table of ['memory_recall_view_records', 'memory_recall_view_terms', 'memory_recall_view_jobs', 'memory_recall_view_pending', 'memory_recall_view_scopes'])
    db.exec(`CREATE TEMP TRIGGER w_${table} AFTER INSERT ON main.${table} BEGIN UPDATE temp.written SET n=n+1; END`);
  const written = () => Number(db.prepare('SELECT n FROM temp.written').get()!.n);
  // closer2-1021: the meter below reads 0 bytes (rows are what this counts), so the build is never paced and its log (about 540 MB for this
  // history) outran the WAL worker: WAL_ADMISSION_BYTES refused every build write busy and the build was dropped, a fixture artifact (the
  // real meter paces the build). Each meter reading, between slices and outside their transactions, checkpoints the log as the worker would.
  // No fence, meter or assertion changes.
  const walCopied = () => { if (!db.isTransaction) try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy: the next reading */ } };
  return { views, roster, db, written, walCopied };
}
it('W-ROSTER-SAVE presentation saves and a count=0 import during a history build never restart it: derived rows written stay one build, then a change writes rows proportional to it', async () => {
  const { views, roster, db, written, walCopied } = await history(JOBS);
  const epochBefore = views.recallAuthorityEpoch(db);
  // Between slices (the meter is read around each one) the routine turn saves its roster: the revision moves, the audience is proven
  // unchanged (store.ts saveGroupsNow -> acknowledgeRecallRosterRevision). Every 4th save the import of an unchanged notebook revokes nothing.
  let reads = 0, saves = 0, revoked = 0;
  views.setRecallReclaimClockForTest({ now: () => Date.now() + reads * 60_000, written: () => {
    walCopied();
    if (++reads % 6 === 0 && saves < 40) {
      roster.memoryRosterRevision = roster.memoryRosterRevision! + 1; views.acknowledgeRecallRosterRevision(roster); saves++;
      if (saves % 4 === 0) revoked += revokeRecordDisclosures(db, 'import', { recordIds: [], sourceIds: [] });
    }
    return 0;
  } });
  // The live store has saved its roster at least once (the boot reconcile, then each save proves it unchanged): the settled token exists.
  // A build begun before a roster's first proven save still restarts once at its first save (fail closed, bounded), never once per save.
  views.acknowledgeRecallRosterRevision(roster);
  const binding = { botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false };
  expect(() => views.resolveRecallView(binding, roster)).toThrow(RecallPreparationPending);
  const deadline = Date.now() + 240_000;
  let view: RecallViewHandle | undefined;
  while (!view && Date.now() < deadline) {
    await views.waitForRecallConstructionIdleForTest(roster);
    try { view = views.resolveRecallView(binding, roster).handle; } catch (error) { if (!(error instanceof RecallPreparationPending)) throw error; await new Promise(r => setTimeout(r, 20)); }
  }
  expect(view).toBeDefined();
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE view_id=? AND generation=?`).get(view!.viewId, view!.generation)!.n);
  const oneBuild = ['memory_recall_view_records', 'memory_recall_view_terms', 'memory_recall_view_jobs', 'memory_recall_view_pending', 'memory_recall_view_scopes'].reduce((n, t) => n + count(t), 0);
  const views_ = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
  console.log('W-ROSTER-SAVE', JSON.stringify({ saves, revoked, written: written(), oneBuild, jobs: count('memory_recall_view_jobs'), records: count('memory_recall_view_records'), terms: count('memory_recall_view_terms'), pending: count('memory_recall_view_pending'), scopes: count('memory_recall_view_scopes'), views: views_ }));
  expect(saves).toBeGreaterThanOrEqual(10);
  expect(revoked).toBe(0);
  // count=0 import and the saves never move the authority epoch (no generation bump)
  expect(views.recallAuthorityEpoch(db)).toBe(epochBefore);
  expect(count('memory_recall_view_jobs')).toBe(JOBS);
  // The history was copied once: every row written is a row of the published view (no restarted build, no reclaimed partial copy).
  expect(written()).toBe(oneBuild);
  expect(views_).toBe(1);
  // A real change after publication: one record edited, then upkeep. Rows written are that record's, never the history's.
  views.setRecallReclaimClockForTest();
  const base = written();
  db.prepare("UPDATE memory_records SET text='edited gamma delta' WHERE id='record-7'").run();
  while (!views.maintainRecallViewSlice(view!)) { /* bounded change pages */ }
  expect(written() - base).toBeGreaterThan(0);
  expect(written() - base).toBeLessThanOrEqual(16);
}, 300_000);

// closer2-1021 W-R2-GAP (P3): a revision no ack and no queue settled (store.ts skips queueRecallRosterPreparation while a team change is open
// or memory is not ready, and that save may change the audience) breaks the chain: a later proven-unchanged ack proves only "same as the
// last persist", so it must not carry the token across the unsettled revision. The build begun before it is fenced and starts again.
it('W-R2-GAP an unsettled revision between two saves fences a build begun before it, even when the next save is acknowledged', async () => {
  const jobs = 20_000;
  const { views, roster, db, written, walCopied } = await history(jobs);
  let reads = 0, gaps = 0;
  views.setRecallReclaimClockForTest({ now: () => Date.now() + reads * 60_000, written: () => {
    walCopied();
    if (++reads === 6) {
      roster.memoryRosterRevision = roster.memoryRosterRevision! + 1; // an unsettled save (no ack, no queue)
      roster.memoryRosterRevision = roster.memoryRosterRevision! + 1; views.acknowledgeRecallRosterRevision(roster); // then a proven-unchanged one
      gaps++;
    }
    return 0;
  } });
  views.acknowledgeRecallRosterRevision(roster);
  const binding = { botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false };
  expect(() => views.resolveRecallView(binding, roster)).toThrow(RecallPreparationPending);
  const deadline = Date.now() + 240_000;
  let view: RecallViewHandle | undefined;
  while (!view && Date.now() < deadline) {
    await views.waitForRecallConstructionIdleForTest(roster);
    try { view = views.resolveRecallView(binding, roster).handle; } catch (error) { if (!(error instanceof RecallPreparationPending)) throw error; await new Promise(r => setTimeout(r, 20)); }
  }
  expect(view).toBeDefined();
  expect(gaps).toBe(1);
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE view_id=? AND generation=?`).get(view!.viewId, view!.generation)!.n);
  const oneBuild = ['memory_recall_view_records', 'memory_recall_view_terms', 'memory_recall_view_jobs', 'memory_recall_view_pending', 'memory_recall_view_scopes'].reduce((n, t) => n + count(t), 0);
  expect(count('memory_recall_view_jobs')).toBe(jobs);
  // the build in flight at the gap was cancelled: its partial copy was written, then the whole view again under the new token
  expect(written()).toBeGreaterThan(oneBuild);
}, 300_000);
