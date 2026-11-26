// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: closer2-1021 (1.0.21 O11 R2, Astra H2). Hydration and its publication fence: recall-view.ts hydrateRecallViewSteps (re-stamp owner
// reclaim-1020-n3). Roster saves: store.ts saveGroups/saveGroupsNow -> acknowledgeRecallRosterRevision + ACK_RECALL_ROSTER (store owners).
// A routine turn's presentation save (memoryRosterRevision moves, the audience is proven unchanged) landing while an existing view is being
// hydrated/re-stamped made hydration return false (it compared the exact revision), and the caller then fell to startBuild: a full copy of
// the history for a save that changed nothing. A revision nothing proved unchanged still ends the hydration (fail closed).
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { Store } from '../store.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { bindHumanThread, OWNER } from '../human-principals.ts';
import * as views from './recall-view.ts';
import { RecallPreparationPending } from './recall-recovery.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { views.stopRecallViewMaintenance(); views.setRecallReclaimClockForTest(); closeDatabase(); });

const HISTORY = 2000;
const binding = (store: Store): views.RecallViewBinding => ({ botId: store.bots[0].id, threadId: store.bots[0].threadId, notOwnerAudience: false, humanPrincipal: OWNER });
const admit = (store: Store) => views.resolveRecallView(binding(store), store).handle;
/** The first view after boot: the reader's demand may still queue its build after the startup sweep went idle, so ask until it is admitted. */
async function admitted(store: Store): Promise<views.RecallViewHandle> {
  for (const deadline = Date.now() + 60_000; ;) {
    try { return admit(store); } catch (error) { if (!(error instanceof RecallPreparationPending) || Date.now() > deadline) throw error; }
    await views.waitForRecallConstructionIdleForTest(store).catch(() => undefined); views.stopRecallViewMaintenance();
    await new Promise(r => setTimeout(r, 20));
  }
}
function finish<T>(steps: Generator<void, T>): T { for (;;) { const item = steps.next(); if (item.done) return item.value; } }
// the store's own groups save (a presentation save: no audience change, so saveGroupsNow proves it unchanged and acknowledges it)
const presentationSave = (store: Store) => (store as unknown as { saveGroups(): void }).saveGroups();
async function fixture() {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  store.createBot({ name: 'Reader' }, { seedMessages: false });
  store.finishSharingBoot();
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  const db = database(), view = await admitted(store);
  const scope = String(db.prepare(`SELECT v.scope_id FROM memory_recall_view_scopes v JOIN memory_scopes s ON s.id=v.scope_id
    WHERE v.view_id=? AND v.generation=? AND v.lineage_only=0 AND s.kind='conversation' LIMIT 1`).get(view.viewId, view.generation)!.scope_id);
  const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',0,1,NULL,NULL,1)");
  db.exec('BEGIN');
  for (let n = 0; n < HISTORY; n++) record.run(`fixture-record-${n}`, scope, `history entry ${n} alpha beta word${n}`);
  db.exec('COMMIT');
  while (!views.maintainRecallViewSlice(view)) { /* the view holds the whole history */ }
  // a live store has saved its roster since boot (each save proves it unchanged): the settled token is at the current revision
  presentationSave(store);
  // a routine run binds its thread's human principal: the epoch moves, so the view needs re-stamping through hydration
  bindHumanThread(`routine-run-${randomUUID()}`, OWNER);
  expect(finish(store.certifyRecallRosterSteps())).toBeDefined();
  views.evictRecallViewsForTest(db);
  db.exec('CREATE TEMP TABLE written(n INTEGER NOT NULL); INSERT INTO temp.written VALUES(0)');
  for (const table of ['memory_recall_view_records', 'memory_recall_view_terms', 'memory_recall_view_jobs', 'memory_recall_view_scopes'])
    db.exec(`CREATE TEMP TRIGGER w_${table} AFTER INSERT ON main.${table} BEGIN UPDATE temp.written SET n=n+1; END`);
  return { store, db, view, written: () => Number(db.prepare('SELECT n FROM temp.written').get()!.n) };
}

it('W-R2-HYDRATE a presentation save during hydration keeps the re-stamp: the existing view is published, no history row is written', async () => {
  const { store, db, view, written } = await fixture();
  const revision = store.memoryRosterRevision, steps = views.hydrateRecallViewSteps(binding(store), store);
  let item = steps.next(), saves = 0;
  // the save lands at the hydration's first suspension (it always suspends at least once before its publication fence)
  while (!item.done) { if (!saves++) presentationSave(store); item = steps.next(); }
  expect(saves).toBeGreaterThan(0);
  expect(store.memoryRosterRevision).toBe(revision + 1);
  expect(item.value).toBe(true);
  expect(written()).toBe(0);
  expect(admit(store)).toEqual(view);
  expect(Number(db.prepare('SELECT authority_epoch FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId, view.generation)!.authority_epoch)).toBe(views.recallAuthorityEpoch(db));
}, 120_000);

it('W-R2-HYDRATE-GAP a revision nothing proved unchanged during hydration ends it (fail closed), and the view is not re-stamped', async () => {
  const { store, db, view } = await fixture();
  const steps = views.hydrateRecallViewSteps(binding(store), store), epochBefore = Number(db.prepare('SELECT authority_epoch FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId, view.generation)!.authority_epoch);
  const started = Date.now();
  let item = steps.next(), bumps = 0;
  // the store's own save while memory is not ready: it bumps the revision and writes groups.json but skips the roster proof (no ack, no queue)
  const ready = store as unknown as { memoryReady: boolean };
  while (!item.done) { if (!bumps++) { ready.memoryReady = false; presentationSave(store); ready.memoryReady = true; } item = steps.next(); }
  expect(bumps).toBeGreaterThan(0);
  expect(item.value).toBe(false);
  // fenced at once (store.ts RECALL_PROOF 'unproven' -> unsettleRecallRoster), never after the 20 s proof wait
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(Number(db.prepare('SELECT authority_epoch FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId, view.generation)!.authority_epoch)).toBe(epochBefore);
}, 120_000);

// W-R2-DEFERRED (Astra M3): two routine presentation saves on the store's deferred path (saveGroups defer: scheduleCoalesced, one flush
// 250 ms later) bump memoryRosterRevision twice before ONE acknowledgement. A full history build in flight keeps copying while the bumps
// await their proof and publishes after it: rows written = one build. Before, the first slice after the bump fenced the build (the token was
// one revision behind) and the coalesced ack then minted a fresh token, so the copy started again.
// W-R2-DEFERRED-STATEONLY (Astra fix-check M3): a proof-bearing deferred save, then a stateOnly deferred save (a message on an inactive
// task, store.ts ~2707) in the same window: the last closure wins the coalesced key, and it must still run the proof the first one owed.
const DEFERRED = [
  { name: 'W-R2-DEFERRED two coalesced deferred presentation saves', saves: [{ defer: true }, { defer: true }], bumps: 2 },
  { name: 'W-R2-DEFERRED-STATEONLY a deferred presentation save then a stateOnly one on the same key', saves: [{ defer: true }, { defer: true, stateOnly: true }], bumps: 1 },
] as const;
for (const scenario of DEFERRED) it(`${scenario.name} during a full build never restart it: rows written stay one build`, async () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  store.createBot({ name: 'Reader' }, { seedMessages: false });
  store.finishSharingBoot();
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  const db = database(), first = await admitted(store);
  const scope = String(db.prepare(`SELECT v.scope_id FROM memory_recall_view_scopes v JOIN memory_scopes s ON s.id=v.scope_id
    WHERE v.view_id=? AND v.generation=? AND v.lineage_only=0 AND s.kind='conversation' LIMIT 1`).get(first.viewId, first.generation)!.scope_id);
  const JOBS = 20_000;
  db.exec('BEGIN');
  const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',0,1,NULL,NULL,1)");
  for (let n = 0; n < 500; n++) record.run(`fixture-record-${n}`, scope, `history entry ${n} alpha beta word${n}`);
  db.prepare(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<?) INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state)
    SELECT 's'||i,?,NULL,NULL,1,'h','text','owner','recorded','active' FROM c`).run(JOBS / 100 - 1, scope);
  db.exec("INSERT INTO memory_source_versions SELECT id,1,'h','{}',0 FROM memory_sources WHERE id GLOB 's[0-9]*'");
  db.prepare(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<?) INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch)
    SELECT 'j'||i,'s'||(i%${JOBS / 100}),1,'capture','v'||i,'complete',0,0 FROM c`).run(JOBS - 1);
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // Forced full rebuild: the published view is withdrawn, so nothing is hydrated or adopted and every phase runs.
  db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=? AND generation=?').run(first.viewId, first.generation);
  db.prepare("UPDATE memory_recall_views SET state='building' WHERE view_id=? AND generation=?").run(first.viewId, first.generation);
  views.evictRecallViewsForTest(db);
  presentationSave(store); // the live store has proved its roster since boot
  db.exec('CREATE TEMP TABLE written(n INTEGER NOT NULL); INSERT INTO temp.written VALUES(0)');
  const DERIVED = ['memory_recall_view_records', 'memory_recall_view_terms', 'memory_recall_view_jobs', 'memory_recall_view_scopes', 'memory_recall_view_pending'];
  for (const table of DERIVED) db.exec(`CREATE TEMP TRIGGER w_${table} AFTER INSERT ON main.${table} BEGIN UPDATE temp.written SET n=n+1; END`);
  const written = () => Number(db.prepare('SELECT n FROM temp.written').get()!.n);
  const revision = store.memoryRosterRevision;
  let reads = 0, deferred = 0;
  // The meter is read around each build slice; at the 8th reading (past membership, inside the copy) two deferred saves land together.
  views.setRecallReclaimClockForTest({ now: () => Date.now(), written: () => {
    if (!db.isTransaction) try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* the next reading */ }
    if (++reads === 8) for (const options of scenario.saves) { (store as unknown as { saveGroups(bots: unknown, options: object): void }).saveGroups(store.bots, options); deferred++; }
    return 0;
  } });
  const started = Date.now();
  await views.prepareRecallContext(store.bots[0].id, store.bots[0].threadId, store);
  const view = admit(store);
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE view_id=? AND generation=?`).get(view.viewId, view.generation)!.n);
  const oneBuild = DERIVED.reduce((n, t) => n + count(t), 0);
  console.log(scenario.name.split(' ')[0], JSON.stringify({ reads, deferred, revision, now: store.memoryRosterRevision, written: written(), oneBuild, jobs: count('memory_recall_view_jobs') }));
  expect(deferred).toBe(scenario.saves.length);
  expect(store.memoryRosterRevision).toBe(revision + scenario.bumps);
  // published once the coalesced flush proved the bumps, never after the 20 s publication bound
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(count('memory_recall_view_jobs')).toBe(JOBS);
  expect(written()).toBe(oneBuild);
}, 120_000);
