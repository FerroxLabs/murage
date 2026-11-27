// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: closer2-1021 (1.0.21 O11 R3, Astra M5). Recall build jobs phase: recall-view.ts buildRecallViewSlice. Publication fences: recall-scope.
// Extreme-scale rule: one build slice never scales with history. The 1.0.20 n2 jobs page was one JOIN of a scope's sources and their jobs whose
// LIMIT counted joined rows, so a single statement walked every job-less source of the scope, and its ORDER BY j.rowid read and sorted a
// source's whole job history before the slice could yield. These replay both shapes through the real build and count what one slice did.
import { mkdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { OWNER } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { RecallPreparationPending } from './recall-recovery.ts';
import type { RecallViewHandle } from './recall-view.ts';
import { setMemoryMode } from './repository.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { const views = await import('./recall-view.ts'); views.stopRecallViewMaintenance(); views.setRecallReclaimClockForTest(); closeDatabase(); });

async function store(fill: (db: DatabaseSync, scope: string) => void) {
  const views = await import('./recall-view.ts');
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active'); views.stopRecallViewMaintenance();
  const db = database(), scope = ensureScope('conversation', 'direct');
  db.exec('SAVEPOINT fixture');
  db.prepare("INSERT INTO memory_records VALUES('record-0',1,?,'constraint','fixture memory alpha','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  fill(db, scope);
  db.exec('RELEASE fixture');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('CREATE TEMP TABLE projected(n INTEGER NOT NULL); INSERT INTO temp.projected VALUES(0)');
  db.exec('CREATE TEMP TRIGGER p_jobs AFTER INSERT ON main.memory_recall_view_jobs BEGIN UPDATE temp.projected SET n=n+1; END');
  const projected = () => Number(db.prepare('SELECT n FROM temp.projected').get()!.n);
  // the meter reads 0 bytes, so the build is unpaced: each reading checkpoints the log as the WAL worker would (recall-roster-save-rebuild-1020)
  const walCopied = () => { if (!db.isTransaction) try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy: the next reading */ } };
  return { views, roster, db, projected, walCopied };
}
const job = (db: DatabaseSync, source: string, id: string, stage: string) => db.prepare(
  "INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch,error) VALUES(?,?,1,?,'v1','complete',0,0,0,0,0,NULL)").run(id, source, stage);
const sources = (db: DatabaseSync, scope: string, prefix: string, n: number) => db.prepare(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<?)
  INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) SELECT ?||i,?,'direct','m'||?||i,1,'h','text','owner','recorded','active' FROM c`).run(n - 1, prefix, scope, prefix);
async function publish(views: Awaited<ReturnType<typeof store>>['views'], roster: MemoryRoster): Promise<RecallViewHandle> {
  views.acknowledgeRecallRosterRevision(roster);
  const binding = { botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false };
  const deadline = Date.now() + 240_000;
  for (;;) {
    try { return views.resolveRecallView(binding, roster).handle; } catch (error) { if (!(error instanceof RecallPreparationPending)) throw error; }
    if (Date.now() > deadline) throw new Error('no view published');
    await views.waitForRecallConstructionIdleForTest(roster).catch(() => undefined);
    await new Promise(r => setTimeout(r, 20));
  }
}

// W-R3-JOBLESS: one job, then 100k job-less sources of the same scope, then one more job. Each build slice reads the meter (the reclaim
// clock's written()); a slice examines at most RECALL_BUILD_SLICE sources, so the second job is reached only after many slices. Before, the
// one page statement skipped all 100k sources inside a single slice and both jobs landed together.
it('W-R3-JOBLESS a scope of 100k job-less sources between two jobs is walked in bounded slices, and every job is projected', async () => {
  const JOBLESS = 100_000;
  const { views, roster, db, projected, walCopied } = await store((db, scope) => {
    sources(db, scope, 'a', 1); sources(db, scope, 'gap', JOBLESS); sources(db, scope, 'z', 1);
    db.exec("INSERT INTO memory_source_versions SELECT id,1,'h','{}',0 FROM memory_sources WHERE id IN ('a0','z0')");
    job(db, 'a0', 'job-first', 's1'); job(db, 'z0', 'job-last', 's1');
  });
  let readsBetween = 0;
  views.setRecallReclaimClockForTest({ now: () => Date.now(), written: () => { walCopied(); if (projected() === 1) readsBetween++; return 0; } });
  const view = await publish(views, roster);
  const jobs = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_jobs WHERE view_id=? AND generation=?').get(view.viewId, view.generation)!.n);
  console.log('W-R3-JOBLESS', JSON.stringify({ readsBetween, jobs, slice: views.RECALL_BUILD_SLICE }));
  expect(jobs).toBe(2);
  // at least one meter reading per slice, and at least JOBLESS / RECALL_BUILD_SLICE slices between the two jobs
  expect(readsBetween).toBeGreaterThanOrEqual(Math.floor(JOBLESS / views.RECALL_BUILD_SLICE));
}, 300_000);

// W-R3-MANY: one source with 20k capture jobs (capture.ts inserts one per changed revision/stage). Every jobs statement the build prepares is
// planned on an index in its own ORDER BY (no temp b-tree sort of the source's history per slice), and every job is projected.
it('W-R3-MANY a source with 20k jobs pages them by an index cursor (no per-slice sort of its history), and every job is projected', async () => {
  const MANY = 20_000;
  const { views, roster, db, walCopied } = await store((db, scope) => {
    sources(db, scope, 'busy', 1);
    db.exec("INSERT INTO memory_source_versions SELECT id,1,'h','{}',0 FROM memory_sources WHERE id='busy0'");
    db.prepare(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<?) INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch,error)
      SELECT 'job-'||i,'busy0',1,'s'||(? - i),'v1','complete',0,0,0,0,0,NULL FROM c`).run(MANY - 1, MANY);
  });
  views.setRecallReclaimClockForTest({ now: () => Date.now(), written: () => { walCopied(); return 0; } });
  // record the SQL of every statement the build prepares that reads memory_jobs (the real statements, planned below on the real file)
  const seen = new Set<string>(), prepare = db.prepare.bind(db);
  (db as { prepare: DatabaseSync['prepare'] }).prepare = ((sql: string) => { if (/\bmemory_jobs\b/.test(sql) && /^\s*SELECT/i.test(sql)) seen.add(sql); return prepare(sql); }) as DatabaseSync['prepare'];
  let view: RecallViewHandle;
  try { view = await publish(views, roster); } finally { delete (db as { prepare?: unknown }).prepare; }
  const jobs = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_jobs WHERE view_id=? AND generation=?').get(view.viewId, view.generation)!.n);
  const plans = [...seen].map(sql => ({ sql: sql.slice(0, 80), plan: (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => row.detail) }));
  console.log('W-R3-MANY', JSON.stringify({ jobs, plans }));
  expect(jobs).toBe(MANY);
  expect(plans.length).toBeGreaterThan(0);
  for (const { plan } of plans) {
    expect(plan.join(' | ')).not.toMatch(/TEMP B-TREE/);
    expect(plan.join(' | ')).not.toMatch(/SCAN (j|memory_jobs)\b(?! USING)/);
  }
}, 300_000);
