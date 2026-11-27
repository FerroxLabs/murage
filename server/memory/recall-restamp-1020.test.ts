// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner of the epoch re-stamp in hydrateRecallViewSteps and these witnesses: reclaim-1020-n3. Owner of the epoch writers (binding triggers):
// recall-scope. Owner of the reclaimer and its pacing: recallcap-1020-n3c.
// FINAL6 storm (2300Z): every new routine thread binds its human principal, which moves the one global recall epoch; each context then rebuilt
// its whole history (records, terms and jobs phases) instead of carrying an unchanged view over. Work must follow the change, never history.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { Store } from '../store.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { bindHumanThread, OWNER } from '../human-principals.ts';
import * as views from './recall-view.ts';
import { revokeRecordDisclosures } from './revocation.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { views.stopRecallViewMaintenance(); closeDatabase(); vi.restoreAllMocks(); });

const HISTORY = 3000;
const binding = (store: Store, thread = store.bots[0].threadId): views.RecallViewBinding => ({ botId: store.bots[0].id, threadId: thread, notOwnerAudience: false, humanPrincipal: OWNER });
const admit = (store: Store, thread?: string) => views.resolveRecallView(binding(store, thread), store).handle;
function finish<T>(steps: Generator<void, T>): T { for (;;) { const item = steps.next(); if (item.done) return item.value; } }
async function fixture() {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  store.createBot({ name: 'Reader' }, { seedMessages: false });
  store.finishSharingBoot();
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  return store;
}
/** HISTORY records (with words) and HISTORY jobs in the reader's own conversation scope, projected into its view through the change log. */
function history(store: Store) {
  const db = database(), view = admit(store);
  const scope = String(db.prepare(`SELECT v.scope_id FROM memory_recall_view_scopes v JOIN memory_scopes s ON s.id=v.scope_id
    WHERE v.view_id=? AND v.generation=? AND v.lineage_only=0 AND s.kind='conversation' LIMIT 1`).get(view.viewId, view.generation)!.scope_id);
  const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',0,1,NULL,NULL,1)");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,1,'h','import','system','imported',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'h','{}',1)");
  const job = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES(?,?,1,'extract','1','complete',0,0)");
  db.exec('BEGIN');
  for (let n = 0; n < HISTORY; n++) {
    record.run(`fixture-record-${n}`, scope, `history entry ${n} alpha beta gamma delta word${n}`);
    source.run(`fixture-source-${n}`, scope); version.run(`fixture-source-${n}`); job.run(`fixture-job-${n}`, `fixture-source-${n}`);
  }
  db.exec('COMMIT');
  while (!views.maintainRecallViewSlice(view)) { /* bounded pages until the view holds the whole history */ }
  const held = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE view_id=? AND generation=?`).get(view.viewId, view.generation)!.n);
  expect(held('memory_recall_view_records')).toBeGreaterThanOrEqual(HISTORY);
  expect(held('memory_recall_view_jobs')).toBeGreaterThanOrEqual(HISTORY);
  return { view, scope };
}
const DERIVED = ['memory_recall_view_scopes', 'memory_recall_view_records', 'memory_recall_view_terms', 'memory_recall_view_pending', 'memory_recall_view_jobs', 'memory_recall_contains', 'memory_recall_thread_readers'];
/** Every row written to or deleted from a derived recall table on this connection, in the storage charge's bytes, across all build phases. */
function meter() {
  const db = database();
  db.exec('CREATE TEMP TABLE IF NOT EXISTS fixture_meter(tbl TEXT NOT NULL,rows INTEGER NOT NULL,bytes INTEGER NOT NULL)');
  for (const table of DERIVED) for (const [event, row] of [['INSERT', 'NEW'], ['DELETE', 'OLD']] as const) {
    const cost = table === 'memory_recall_view_terms' ? `512+4*length(CAST(${row}.term AS BLOB))` : '512';
    db.exec(`CREATE TEMP TRIGGER fixture_meter_${table}_${event.toLowerCase()} AFTER ${event} ON main.${table} BEGIN INSERT INTO fixture_meter VALUES('${table}',1,${cost}); END`);
  }
  return () => {
    const rows = db.prepare('SELECT tbl,sum(rows) AS rows,sum(bytes) AS bytes FROM fixture_meter GROUP BY tbl').all();
    return { bytes: rows.reduce((sum, row) => sum + Number(row.bytes), 0), rows: rows.reduce((sum, row) => sum + Number(row.rows), 0), byTable: Object.fromEntries(rows.map(row => [row.tbl, Number(row.rows)])) };
  };
}
const routineRun = () => bindHumanThread(`routine-run-${randomUUID()}`, OWNER);

it('W1 a routine run (new thread binding moves the epoch) writes bytes bounded by the change, not by history, in every phase', async () => {
  const store = await fixture(); const { view } = history(store); const db = database();
  const epoch = views.recallAuthorityEpoch(db), read = meter();
  routineRun();
  expect(views.recallAuthorityEpoch(db)).toBeGreaterThan(epoch);
  expect(() => admit(store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  await views.prepareRecallContext(store.bots[0].id, store.bots[0].threadId, store);
  const after = admit(store), written = read();
  // History is 3000 records with terms and 3000 jobs (a full rebuild writes several MB); the change is one binding.
  expect(written, JSON.stringify(written)).toMatchObject({ bytes: 0, rows: 0 });
  expect(after).toEqual(view);
  expect(Number(db.prepare('SELECT authority_epoch FROM memory_recall_views WHERE view_id=? AND generation=?').get(after.viewId, after.generation)!.authority_epoch)).toBe(views.recallAuthorityEpoch(db));
});

it('W2 repeated routine runs stay bounded per run (no history-sized work per minute)', async () => {
  const store = await fixture(); history(store); const read = meter();
  for (let run = 0; run < 5; run++) { routineRun(); await views.prepareRecallContext(store.bots[0].id, store.bots[0].threadId, store); expect(admit(store)).toBeDefined(); }
  expect(read().bytes).toBeLessThan(64 * 1024);
});

it('W3 a re-stamped view never exposes a record withdrawn before the epoch moved', async () => {
  const store = await fixture(); const { view } = history(store); const db = database();
  db.exec("UPDATE memory_records SET state='deleted' WHERE id='fixture-record-7'");
  routineRun();
  await views.prepareRecallContext(store.bots[0].id, store.bots[0].threadId, store);
  const after = admit(store);
  while (!views.maintainRecallViewSlice(after)) { /* the withdrawal's change row */ }
  // The re-stamped generation is the same one, and the withdrawal reached it through the change log (terms are derived metadata gated by
  // readRecord on the record's state; the view row carries that state, exactly as a fresh build projects it).
  expect(after).toEqual(view);
  expect(db.prepare("SELECT state FROM memory_recall_view_records WHERE view_id=? AND generation=? AND record_id='fixture-record-7'").get(view.viewId, view.generation)?.state).toBe('deleted');
  expect(db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND generation=? AND state='active' AND record_id LIKE 'fixture-record-%'").get(view.viewId, view.generation)!.n).toBe(HISTORY - 1);
});

it('W4 an epoch move that changes the membership still rebuilds (never re-stamped)', async () => {
  const store = await fixture(), db = database(), old = admit(store);
  const row = db.prepare('SELECT view_id,generation FROM memory_recall_views WHERE view_id=? AND generation=?').get(old.viewId, old.generation)!;
  db.prepare("UPDATE memory_recall_views SET state='building' WHERE view_id=? AND generation=?").run(row.view_id, row.generation);
  db.prepare("INSERT INTO memory_recall_view_scopes VALUES(?,?,'foreign-fixture-scope',0,0)").run(row.view_id, row.generation);
  db.prepare("UPDATE memory_recall_views SET state='ready',scope_count=scope_count+1 WHERE view_id=? AND generation=?").run(row.view_id, row.generation);
  routineRun(); expect(finish(store.certifyRecallRosterSteps())).toBeDefined(); views.evictRecallViewsForTest(db);
  expect(finish(views.hydrateRecallViewSteps(binding(store), store))).toBe(false);
  expect(Number(db.prepare('SELECT authority_epoch FROM memory_recall_views WHERE view_id=? AND generation=?').get(row.view_id, row.generation)!.authority_epoch)).not.toBe(views.recallAuthorityEpoch(db));
});

it('W5 a view another context also holds is never re-stamped (that context may have narrowed)', async () => {
  const store = await fixture(), db = database(), old = admit(store);
  db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?)').run('fixture-other-context', old.viewId, old.generation);
  routineRun(); expect(finish(store.certifyRecallRosterSteps())).toBeDefined(); views.evictRecallViewsForTest(db);
  expect(finish(views.hydrateRecallViewSteps(binding(store), store))).toBe(false);
  expect(Number(db.prepare('SELECT authority_epoch FROM memory_recall_views WHERE view_id=? AND generation=?').get(old.viewId, old.generation)!.authority_epoch)).not.toBe(views.recallAuthorityEpoch(db));
});

it('W6 a records revoke that ends no receipt (cause=import count=0) moves no epoch and rebuilds nothing', async () => {
  const store = await fixture(); const { view } = history(store); const db = database();
  const epoch = views.recallAuthorityEpoch(db), read = meter();
  expect(revokeRecordDisclosures(db, 'import', { recordIds: ['fixture-record-3'], sourceIds: ['fixture-source-3'], versions: {} })).toBe(0);
  expect(views.recallAuthorityEpoch(db)).toBe(epoch);
  await views.prepareRecallContext(store.bots[0].id, store.bots[0].threadId, store);
  expect(admit(store)).toEqual(view);
  expect(read().bytes).toBe(0);
});
