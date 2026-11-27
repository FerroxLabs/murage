// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: reclaim-1020-n2 (1.0.20 storm after a revoke/import: recall-reclaim 9457.9 MB/min, top statements one job lookup and one job-row delete
// per job of the WHOLE memory_jobs table, x397432 a minute). A view build projected every job on the machine, then dropped the ones outside its
// scopes; any epoch move (a revoke, an import's scope or binding write, a routine turn's fence) rebuilt every live context that way.
// Consumer owner of the view tables: recall-scope.
import { mkdirSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { (await import('./recall-view.ts')).stopRecallViewMaintenance(); closeDatabase(); });

/** Counts the rows every statement naming memory_jobs reads or writes, and the rows written to memory_recall_view_jobs, on the real connection. */
function meter(db: DatabaseSync) {
  const seen = { jobRows: 0, viewJobWrites: 0 };
  const prepare = db.prepare.bind(db);
  (db as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
    const statement = prepare(sql), jobs = /\bmemory_jobs\b/.test(sql), writes = /^\s*(INSERT|DELETE)[^;]*memory_recall_view_jobs/i.test(sql);
    if (!jobs && !writes) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (jobs) seen.jobRows += key === 'all' ? (result as unknown[]).length : key === 'get' ? (result ? 1 : 0) : 0;
        if (writes && key === 'run') seen.viewJobWrites += Number((result as { changes: number | bigint }).changes);
        return result;
      };
    } });
  };
  return { seen, restore: () => { delete (db as { prepare?: unknown }).prepare; } };
}

it('W-JOBSCALE a rebuild after an epoch move touches the reader\'s own jobs only, never every job in history; foreign jobs never enter the view', async () => {
  const views = await import('./recall-view.ts');
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active'); views.stopRecallViewMaintenance();
  const db = database(), own = ensureScope('conversation', 'direct'), foreign = ensureScope('conversation', 'elsewhere');
  const OWN = 12, FOREIGN = 6000;
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','owner','recorded',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,'{}',1)");
  const job = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','complete',0,0,0,0,0)");
  db.exec('SAVEPOINT fixture_jobs');
  // Foreign history interleaved with the reader's own jobs, as a real file accumulates them.
  for (let n = 0; n < OWN + FOREIGN; n++) {
    const mine = n % Math.floor((OWN + FOREIGN) / OWN) === 0 && n / Math.floor((OWN + FOREIGN) / OWN) < OWN;
    const id = `src-${String(n).padStart(6, '0')}`;
    source.run(id, mine ? own : foreign, mine ? 'direct' : 'elsewhere', `m${n}`, `h${n}`); version.run(id, `h${n}`);
    job.run(`job-${String(n).padStart(6, '0')}`, id);
  }
  db.exec('RELEASE fixture_jobs');
  const mine = Number(db.prepare('SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.scope_id=?').get(own)!.n);
  expect(mine).toBe(OWN);
  await views.prepareRecallContext('reader', 'direct', roster);
  // The revoke/import class: the authority epoch moves, every live view is stale and the reader's next demand builds a new generation.
  db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1');
  const { seen, restore } = meter(db);
  try { await views.prepareRecallContext('reader', 'direct', roster); } finally { restore(); }
  views.stopRecallViewMaintenance();
  const current = db.prepare('SELECT view_id,generation FROM memory_recall_contexts').get()!;
  const viewJobs = db.prepare('SELECT job_id FROM memory_recall_view_jobs WHERE view_id=? AND generation=? ORDER BY job_id').all(current.view_id, current.generation).map(row => String(row.job_id));
  const foreignInView = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_jobs v JOIN memory_jobs j ON j.id=v.job_id JOIN memory_sources s ON s.id=j.source_id WHERE s.scope_id=?').get(foreign)!.n);
  console.log('W-JOBSCALE', JSON.stringify({ own: OWN, foreign: FOREIGN, ...seen, viewJobs: viewJobs.length, foreignInView }));
  // Correctness: exactly the reader's jobs are in the new view; no job of another scope ever is.
  expect(viewJobs.length).toBe(OWN);
  expect(foreignInView).toBe(0);
  // Proportional to the change and the reader's own data, never to history: a few rows per own job, not one lookup and one delete per job on the machine.
  expect(seen.jobRows).toBeLessThanOrEqual(4 * OWN + 16);
  expect(seen.viewJobWrites).toBeLessThanOrEqual(2 * OWN);
}, 180_000);
