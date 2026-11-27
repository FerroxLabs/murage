// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s4 (hydration, queues and publication). Consumer owner: recall-s4b (admission wake).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { appendMessage } from '../message-db.ts';
import { launchVerificationServer, runControlMurage } from '../../scripts/control-murage.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { Store } from '../store.ts';
import { ensureWorkspace } from '../workspace.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { OWNER } from '../human-principals.ts';
import { pauseRestoredMemory } from './restore.ts';
import { migrateDetectedMemoryNotebooks } from './import.ts';
import { downgradeMemorySchema, migrateMemorySchema } from './schema.ts';
import * as views from './recall-view.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { views.stopRecallViewMaintenance(); closeDatabase(); vi.restoreAllMocks(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function releasedSchema() {
  const raw = readFileSync(new URL('./testing/schema-1.0.18.ts.txt', import.meta.url), 'utf8');
  const original = new URL('./schema.ts', import.meta.url);
  const relocated = raw.replace(/from (["'])(\.[^"']+)\1/g, (_all, quote, relative) => `from ${quote}${new URL(relative, original).href}${quote}`);
  const path = join(DATA_DIR, 'fixture-released-schema.mts'); writeFileSync(path, relocated);
  return import(/* @vite-ignore */ pathToFileURL(path).href);
}

function binding(store: Store, thread = store.bots[0].threadId, notOwnerAudience = false): views.RecallViewBinding {
  return { botId: store.bots[0].id, threadId: thread, notOwnerAudience, humanPrincipal: OWNER };
}
function admit(store: Store, thread?: string) { return views.resolveRecallView(binding(store, thread), store).handle; }
async function fixture(tasks = 0) {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  store.createBot({ name: 'Reader' }, { seedMessages: false });
  for (let n = 0; n < tasks; n++) store.createTask(store.bots[0].id, `Task ${n}`, false);
  store.finishSharingBoot();
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  return store;
}
function finish<T>(steps: Generator<void, T>): T { for (;;) { const item = steps.next(); if (item.done) return item.value; } }
function proof(store: Store) { return finish(store.certifyRecallRosterSteps()); }
// Observe SQL through the real connection, including asynchronous background work.
function sqlProbe() {
  const db = database(), sql: string[] = [], original = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation((query: string) => { sql.push(query); return original(query); });
  return { sql, stop: () => spy.mockRestore() };
}
const walks = (sql: string[]) => sql.filter(query => /FROM memory_(records|jobs)\b/i.test(query));
// MAIN RULING 1114-RECALL-S4-FIXTURES: attribute observed scans to their actual
// caller. Schema validation and startup maintenance are independent of recall construction.
function historyScanOrigin(sql: string, stack: string): 'construction' | 'schema' | 'maintenance' | undefined {
  if (!/FROM memory_(records|jobs)\b[\s\S]*\bWHERE rowid\s*>/i.test(sql)) return undefined;
  if (/\brecall-view\.(?:ts|js):/.test(stack)) return 'construction';
  if (/\b(?:validateMemorySchema|migrateMemorySchema)\b/.test(stack)) return 'schema';
  return 'maintenance';
}
function expectNoRecallRebuild(log: string) {
  expect(log).not.toContain('fixture history walk');
  expect(log).not.toContain('fixture full build');
}
function persisted(store: Store) {
  const b = binding(store), key = views.recallContextKey(b);
  return database().prepare('SELECT v.* FROM memory_recall_contexts c JOIN memory_recall_views v USING(view_id,generation) WHERE c.context_key=?').get(key)!;
}
// Simulate stale/corrupt derived bytes while preserving the real immutability triggers.
function corruptScopes(store: Store, sql: string) {
  const row = persisted(store), db = database();
  db.prepare("UPDATE memory_recall_views SET state='building' WHERE view_id=? AND generation=?").run(row.view_id, row.generation);
  db.prepare(sql).run(row.view_id, row.generation);
  db.prepare("UPDATE memory_recall_views SET state='ready' WHERE view_id=? AND generation=?").run(row.view_id, row.generation);
}

it('ready persisted view admits after restart without rebuilding, on the first owner admission probe', async () => {
  const first = await fixture(), old = admit(first), epoch = views.recallAuthorityEpoch(database());
  database().exec("INSERT INTO memory_records VALUES('fixture-pin',1,(SELECT id FROM memory_scopes WHERE kind='conversation' LIMIT 1),'constraint','Pinned fixture.','owner-statement','active',1,1,NULL,NULL,1)");
  views.maintainRecallViewSlice(old);
  closeDatabase(); database(); const probe = sqlProbe();
  const restarted = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  restarted.finishSharingBoot(); await views.waitForRecallConstructionIdleForTest(restarted); views.stopRecallViewMaintenance();
  let probes = 0; probes++; const current = admit(restarted);
  expect(current).toEqual(old); expect(probes).toBe(1);
  expect(views.recallAuthorityEpoch(database())).toBe(epoch);
  expect(walks(probe.sql)).toEqual([]); probe.stop();
});

it('durable roster_revision is not a cross-process certificate', async () => {
  const store = await fixture(), old = admit(store), db = database();
  db.exec('UPDATE memory_recall_views SET roster_revision=roster_revision+700');
  views.evictRecallViewsForTest(db); expect(proof(store)).toBeDefined();
  const probe = sqlProbe(); await views.prepareRecallContext(store.bots[0].id, store.bots[0].threadId, store);
  expect(admit(store)).toEqual(old); expect(walks(probe.sql)).toEqual([]); probe.stop();
});

// reclaim-1020-n3: 'moved epoch' alone is no longer a refusal. A view whose only difference is the epoch, bound by this context alone, passes the
// full membership proof under the current epoch and is re-stamped (recall-restamp-1020.test.ts W1-W5); an epoch move together with any membership
// difference still refuses ('moved epoch with membership' below, and W4/W5 there).
for (const fault of ['corrupt digest', 'wrong count', 'person flag', 'thread eligibility', 'room flag', 'non-lineage membership', 'lineage membership', 'redirected context', 'moved epoch with membership', 'uncertified roster', 'missing epoch'] as const) {
  it(`hydration refuses independently: ${fault}`, async () => {
    const store = await fixture(), row = persisted(store), db = database(), key = views.recallContextKey(binding(store));
    if (fault === 'redirected context') {
      const other = db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key!=? LIMIT 1').get(key)!;
      db.prepare('UPDATE memory_recall_contexts SET view_id=?,generation=? WHERE context_key=?').run(other.view_id, other.generation, key);
    }
    if (fault === 'corrupt digest') db.prepare("UPDATE memory_recall_views SET digest='corrupt' WHERE view_id=? AND generation=?").run(row.view_id, row.generation);
    if (fault === 'wrong count') db.prepare('UPDATE memory_recall_views SET scope_count=scope_count+1 WHERE view_id=? AND generation=?').run(row.view_id, row.generation);
    if (fault === 'room flag') db.prepare('UPDATE memory_recall_views SET room_reader=1-room_reader WHERE view_id=? AND generation=?').run(row.view_id, row.generation);
    if (fault === 'person flag') corruptScopes(store, 'UPDATE memory_recall_view_scopes SET person_scope=1-person_scope WHERE view_id=? AND generation=?');
    if (fault === 'non-lineage membership') corruptScopes(store, 'DELETE FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0');
    if (fault === 'lineage membership') corruptScopes(store, "INSERT INTO memory_recall_view_scopes VALUES(?,?,'foreign-fixture-scope',1,1)");
    if (fault === 'thread eligibility') db.prepare('UPDATE memory_recall_thread_readers SET eligible=1-eligible WHERE view_id=? AND generation=?').run(row.view_id, row.generation);
    if (fault === 'moved epoch with membership') { corruptScopes(store, 'DELETE FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0'); db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1'); }
    if (fault === 'missing epoch') db.exec('DELETE FROM memory_recall_epoch');
    if (fault === 'uncertified roster') vi.spyOn(store, 'recallRosterCertificate').mockReturnValue(undefined);
    else if (fault !== 'missing epoch') expect(proof(store)).toBeDefined();
    views.evictRecallViewsForTest(db);
    const probe = sqlProbe();
    expect(finish(views.hydrateRecallViewSteps(binding(store), store))).toBe(false);
    expect(() => admit(store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
    expect(walks(probe.sql)).toEqual([]); probe.stop();
    if (fault === 'person flag' || fault === 'thread eligibility') expect(persisted(store).digest).toBe(row.digest);
  });
}

for (const fault of ['epoch', 'revision', 'pointer', 'certificate', 'close'] as const) it(`final hydration fence refuses ${fault} after comparison`, async () => {
  const store = await fixture(); expect(proof(store)).toBeDefined(); const db = database();
  // Discover the final suspension on an independent full pass; neither pass publishes until resumed.
  views.evictRecallViewsForTest(db); let yields = 0;
  const count = views.hydrateRecallViewSteps(binding(store), store);
  while (!count.next().done) yields++;
  views.evictRecallViewsForTest(db);
  const steps = views.hydrateRecallViewSteps(binding(store), store);
  for (let n = 0; n < yields; n++) expect(steps.next().done).toBe(false);
  if (fault === 'epoch') db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1');
  if (fault === 'revision') (store as unknown as { memoryRosterCounter: number }).memoryRosterCounter++;
  if (fault === 'pointer') db.prepare('DELETE FROM memory_recall_contexts WHERE context_key=?').run(views.recallContextKey(binding(store)));
  if (fault === 'certificate') vi.spyOn(store, 'recallRosterCertificate').mockReturnValue(undefined);
  if (fault === 'close') { closeDatabase(); database(); }
  expect(finish(steps)).toBe(false);
  expect(() => admit(store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
});

it('projection upkeep defers while hydration holds its exact publication snapshot', async () => {
  const store = await fixture(), db = database(), old = admit(store);
  expect(proof(store)).toBeDefined();
  views.evictRecallViewsForTest(db);
  let yields = 0; const count = views.hydrateRecallViewSteps(binding(store), store);
  while (!count.next().done) yields++;
  views.evictRecallViewsForTest(db);
  db.exec("INSERT INTO memory_records VALUES('fixture-pin',1,(SELECT id FROM memory_scopes WHERE kind='conversation' LIMIT 1),'constraint','Pinned fixture.','owner-statement','active',1,1,NULL,NULL,1)");
  const mark = () => db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(old.viewId, old.generation)!.watermark;
  const before = mark(), steps = views.hydrateRecallViewSteps(binding(store), store);
  for (let n = 0; n < yields; n++) expect(steps.next().done).toBe(false);
  expect(db.prepare('SELECT context_key FROM memory_recall_contexts ORDER BY context_key LIMIT 1').get()!.context_key).toBe(views.recallContextKey(binding(store)));
  // The journal row above armed the applier's wall-clock wake; it is dropped here so that everything below runs on the fake clock.
  views.stopRecallViewMaintenance();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    views.startRecallViewMaintenance();
    await vi.advanceTimersByTimeAsync(50);
    await new Promise(resolve => setImmediate(resolve));
    expect(mark()).toBe(before);
    expect(steps.next()).toEqual({ done: true, value: true });
    expect(admit(store)).toEqual(old);
    // memv2 lane A (MEMORY-V2-DESIGN 4.2 A3, A6): the applier, not a 50 ms walk, reads the row once the hydration has let go: it looks
    // again 250 ms after it found the view held, and the persisted watermark is a lower bound written lazily. The assertion is the same
    // one: the row is applied and the view's watermark passes it; it is read after the flush that a clean stop makes.
    // (the applier's "look again" is a deadline of lane W's registry, which holds wall-clock times: it is waited for on the real clock)
    vi.useRealTimers();
    for (let n = 0; n < 60 && !views.recallViewCurrent(db, old); n++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(views.recallViewCurrent(db, old)).toBe(true);
    views.flushRecallWatermarks(db);
    expect(Number(mark())).toBeGreaterThan(Number(before));
  } finally { steps.return(false); views.stopRecallViewMaintenance(); vi.useRealTimers(); }
});

it('hydration and oracle work never run on the turn path', async () => {
  const store = await fixture(); views.evictRecallViewsForTest(database());
  const before = views.recallViewCounters(), probe = sqlProbe();
  for (let n = 0; n < 4; n++) expect(() => admit(store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  expect(views.recallViewCounters().oracleComputes).toBe(before.oracleComputes);
  expect(probe.sql.some(sql => /memory_recall_view_scopes|memory_scope_bindings.*rowid|memory_scopes.*rowid/.test(sql))).toBe(false);
  expect(probe.sql.length).toBeLessThanOrEqual(12); probe.stop();
});

it('crash during rebuild never hydrates or publishes the interrupted building generation', async () => {
  const store = await fixture(), db = database(); db.exec('DELETE FROM memory_recall_contexts'); views.evictRecallViewsForTest(db);
  const pending = views.prepareRecallContext(store.bots[0].id, store.bots[0].threadId, store).catch(error => error);
  closeDatabase(); database(); expect(await pending).toBeInstanceOf(Error);
  expect(proof(store)).toBeDefined();
  expect(finish(views.hydrateRecallViewSteps(binding(store), store))).toBe(false);
  expect(() => admit(store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
});

it('publication notifies only after cache publication; throwing and removed listeners are isolated', async () => {
  const store = await fixture(), seen: string[] = [];
  const removed = views.subscribeRecallViewPublication(() => { seen.push('removed'); }); removed(); removed();
  const throwing = views.subscribeRecallViewPublication(() => { throw new Error('fixture listener'); });
  const unsubscribe = views.subscribeRecallViewPublication(event => { expect(admit(store)).toEqual(event.view); seen.push(event.contextKey); });
  views.evictRecallViewsForTest(database()); expect(proof(store)).toBeDefined();
  expect(finish(views.hydrateRecallViewSteps(binding(store), store))).toBe(true);
  expect(seen).toEqual([]); await tick();
  expect(seen).toEqual([views.recallContextKey(binding(store))]); unsubscribe(); throwing();
});

it('repeated demand during multi-slice certification does not supersede its active proof', async () => {
  const store = await fixture(25); database().exec('UPDATE memory_recall_epoch SET epoch=epoch+1');
  const start = vi.spyOn(store, 'certifyRecallRosterSteps'); store.queueRecallRosterCertification();
  for (let n = 0; n < 250 && !store.recallRosterCertificate(); n++) { await tick(); store.queueRecallRosterCertification(); }
  expect(store.recallRosterCertificate()).toBeDefined(); expect(start).toHaveBeenCalledTimes(1);
});

it('thread creation queues its own context', async () => {
  const store = await fixture(), seen: string[] = [];
  const unsubscribe = views.subscribeRecallViewPublication(event => { seen.push(event.contextKey); });
  const task = store.createTask(store.bots[0].id, 'New conversation', false)!;
  // Structural queueing must prepare tasks without any admission demand.
  await views.waitForRecallConstructionIdleForTest(store);
  expect(admit(store, task.threadId)).toBeDefined();
  expect(seen).toContain(views.recallContextKey(binding(store, task.threadId))); unsubscribe();
});

for (const phase of ['enumeration', 'construction'] as const) it(`presentation save during ${phase} requeues superseded background work`, async () => {
  const store = await fixture(3), db = database();
  const task = store.createTask(store.bots[0].id, 'Queued conversation', false)!;
  const before = views.recallViewCounters().oracleComputes;
  if (phase === 'enumeration') await tick();
  else {
    for (let n = 0; n < 1000 && views.recallViewCounters().oracleComputes === before; n++) await tick();
    expect(views.recallViewCounters().oracleComputes).toBeGreaterThan(before);
  }
  const epoch = views.recallAuthorityEpoch(db), revision = store.memoryRosterRevision;
  store.patchBot(store.bots[0].id, { name: 'Renamed reader' });
  expect(store.memoryRosterRevision).toBeGreaterThan(revision);
  expect(views.recallAuthorityEpoch(db)).toBe(epoch);
  await views.waitForRecallConstructionIdleForTest(store);
  expect(admit(store, task.threadId)).toBeDefined();
  const stale = db.prepare(`SELECT count(*) AS n FROM memory_recall_contexts c JOIN memory_recall_views v USING(view_id,generation)
    WHERE v.state!='ready' OR v.authority_epoch!=(SELECT epoch FROM memory_recall_epoch WHERE id=1)`).get()!.n;
  expect(stale).toBe(0);
  for (const thread of [store.bots[0].threadId, ...store.bots[0].tasks!.map(item => item.threadId)])
    for (const notOwner of [false, true]) expect(views.resolveRecallView(binding(store, thread, notOwner), store).handle).toBeDefined();
});

for (const partial of [false, true]) it(`restored database drops recall generations (partial=${partial}) and keeps authority`, async () => {
  const store = await fixture(), old = admit(store), db = database();
  db.exec("INSERT INTO memory_records VALUES('fixture-pin',1,(SELECT id FROM memory_scopes WHERE kind='conversation' LIMIT 1),'constraint','Pinned fixture.','owner-statement','active',1,1,NULL,NULL,1)");
  db.exec("INSERT INTO memory_records VALUES('fixture-deleted',1,(SELECT id FROM memory_scopes WHERE kind='conversation' LIMIT 1),'constraint','Removed fixture.','owner-statement','deleted',0,1,NULL,NULL,1)");
  if (partial) db.exec('DROP TABLE memory_recall_thread_readers');
  db.exec('BEGIN'); expect(pauseRestoredMemory(db)).toBe(true); db.exec('COMMIT');
  expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(0);
  expect(db.prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n).toBe(0);
  expect(db.prepare("SELECT owner_pinned FROM memory_records WHERE id='fixture-pin'").get()!.owner_pinned).toBe(1);
  expect(db.prepare("SELECT text FROM memory_records WHERE id='fixture-deleted'").get()!.text).toBe('');
  expect(() => views.assertRecallView(db, old)).toThrow();
  expect(finish(views.hydrateRecallViewSteps(binding(store), store))).toBe(false);
  expect(db.prepare('SELECT mode FROM memory_meta').get()!.mode).toBe('paused');
});

it('notebook import retains the recall tables and generations', async () => {
  const store = await fixture(), old = admit(store), root = ensureWorkspace(store.bots[0].id);
  database().exec("UPDATE memory_meta SET mode='active'");
  writeFileSync(join(root, 'MEMORY.md'), 'A durable notebook fixture for the reader.');
  let cursor: string | undefined, imported = 0;
  do { const result = migrateDetectedMemoryNotebooks(store, cursor); imported += result.imported; cursor = result.nextCursor; } while (cursor);
  expect(imported).toBe(1);
  expect(database().prepare('SELECT state FROM memory_recall_views WHERE view_id=? AND generation=?').get(old.viewId, old.generation)?.state).toBe('ready');
});

it('1.0.19 to 1.0.18 to 1.0.19 recreates empty derived recall tables without losing pins', async () => {
  const store = await fixture(), db = database();
  db.exec("INSERT INTO memory_records VALUES('fixture-pin',1,(SELECT id FROM memory_scopes WHERE kind='conversation' LIMIT 1),'constraint','Pinned fixture.','owner-statement','active',1,1,NULL,NULL,1)");
  // 1.0.18's memory schema is v13; it never interprets 1.0.19 derived views.
  db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1; UPDATE memory_recall_views SET watermark=-1,authority_epoch=(SELECT epoch FROM memory_recall_epoch),roster_revision=roster_revision+1');
  downgradeMemorySchema(db, 13);
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_recall_views'").get()).toBeUndefined();
  expect(db.prepare("SELECT owner_pinned FROM memory_records WHERE id='fixture-pin'").get()!.owner_pinned).toBe(1);
  const old = await releasedSchema();
  expect(() => old.validateMemorySchema(db)).not.toThrow();
  old.migrateMemorySchema(db);
  migrateMemorySchema(db);
  expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(0);
  expect(() => admit(store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
});

it('waiting demand preempts an active speculative hydration at the next slice', async () => {
  const store = await fixture(8), target = store.bots[0].tasks!.at(-1)!.threadId, seen: string[] = [];
  const unsubscribe = views.subscribeRecallViewPublication(event => { seen.push(event.contextKey); });
  views.evictRecallViewsForTest(database());
  views.prepareRosterRecallViews(store); await tick(); await tick();
  expect(() => admit(store, target)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  await views.waitForRecallConstructionIdleForTest(store); await tick();
  expect(seen[0]).toBe(views.recallContextKey(binding(store, target)));
  expect(admit(store, target)).toBeDefined(); unsubscribe();
});

it('offline backup restore recreates empty recall tables and preserves grants, messages and pins', async () => {
  const store = await fixture(), db = database(), path = join(DATA_DIR, 'fixture-backup.db');
  appendMessage(store.bots[0].threadId, { id: 'fixture-message', at: 1, role: 'user', kind: 'text', text: 'A retained fixture message.' });
  db.exec("INSERT INTO memory_records VALUES('fixture-pin',1,(SELECT id FROM memory_scopes WHERE kind='conversation' LIMIT 1),'constraint','Pinned fixture.','owner-statement','active',1,1,NULL,NULL,1)");
  const grants = db.prepare("SELECT * FROM memory_scope_bindings WHERE state='granted' ORDER BY id").all();
  await backup(db, path);
  const restored = new DatabaseSync(path);
  try {
    restored.exec('BEGIN'); expect(pauseRestoredMemory(restored)).toBe(true); restored.exec('COMMIT');
    expect(restored.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(0);
    expect(restored.prepare("SELECT * FROM memory_scope_bindings WHERE state='granted' ORDER BY id").all()).toEqual(grants);
    expect(restored.prepare("SELECT text FROM messages WHERE id='fixture-message'").get()!.text).toBe('A retained fixture message.');
    expect(restored.prepare("SELECT owner_pinned FROM memory_records WHERE id='fixture-pin'").get()!.owner_pinned).toBe(1);
  } finally { restored.close(); }
});

for (const { crash, reconstruct } of [
  { crash: false, reconstruct: false }, { crash: true, reconstruct: false },
  { crash: false, reconstruct: true },
]) it(reconstruct ? 'restart probe positive control detects real reconstruction and rejects the no-rebuild assertion'
  : `real launcher restart (crash=${crash}) admits the first owner turn on its first probe with no history walk`, async () => {
  const instrumentationSource = `
    const historyScanOrigin = ${historyScanOrigin.toString()};
    const { registerHooks } = await import('node:module');
    registerHooks({ load(url, context, next) {
      const loaded = next(url, context);
      if (url.endsWith('/server/memory/recall-view.ts')) {
        let source = String(loaded.source);
        // Independent startBuild entry witness: fail setup if instrumentation cannot attach.
        const build = 'function startBuild(binding: RecallViewBinding,roster: MemoryRoster): Build {';
        if (!source.includes(build)) throw new Error('fixture startBuild anchor missing');
        source = source.replace(build, build + "console.warn('fixture full build');");
        const start = source.indexOf('export function* hydrateRecallViewSteps'), end = source.indexOf('export function prepareRecallContextSync', start);
        const hydration = source.slice(start, end).split('\\n').map((line, index) => line.replaceAll('return false;', "{ console.warn('fixture hydration refused line=" + index + "'); return false; }")).join('\\n');
        source = source.slice(0, start) + hydration + source.slice(end);
        return { ...loaded, source: source
          .replaceAll('const current=read();', "const current=read(); if(current && current.watermark!==row.watermark)console.warn('fixture snapshot watermark advanced old=' + row.watermark + ' live=' + current.watermark);")
          .replace('const event=Object.freeze({contextKey:key', "console.warn('fixture published epoch=' + epoch + ' revision=' + revision); const event=Object.freeze({contextKey:key") };
      }
      if (!url.endsWith('/server/index.ts')) return loaded;
      const needle = 'function turnMemoryAccess(botId: string, threadId: string, generation: string): MemoryAccess {';
      const text = String(loaded.source);
      if (!text.includes(needle)) throw new Error('fixture probe anchor missing');
      const issue = 'return memoryAccess(internalCapabilities,internalCapabilities.resolve(\`Bearer \${token}\`)!,()=>store);';
      if (!text.includes(issue)) throw new Error('fixture admission result anchor missing');
      return { ...loaded, source: text.replace(needle, needle + "console.warn('fixture admission probe');")
        .replace('store.finishSharingBoot();', \`store.finishSharingBoot(); database().prepare("UPDATE memory_meta SET mode='active' WHERE id=1").run();\`)
        .replace(issue, "try { const issued = " + issue.slice(7, -1) + "; console.warn('fixture admission accepted'); return issued; } catch(error) { console.warn('fixture admission refused'); throw error; }") };
    }});
    const { DatabaseSync } = await import('node:sqlite');
    const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const origin = historyScanOrigin(sql, new Error().stack ?? '');
      if (origin) console.warn(origin === 'construction' ? 'fixture history walk' : 'fixture startup scan ' + origin, sql);
      return original.call(this, sql);
    };
  `;
  const fixture = await launchVerificationServer(process.env, undefined, {
    separateHome: true, turnLog: { replies: ['First fixture reply.', 'Restart fixture reply.'] }, instrumentationSource,
  }).catch(error => {
    const path = /see (.+\.log)/.exec(String(error))?.[1];
    if (path) console.error(readFileSync(path, 'utf8').slice(-12000));
    throw error;
  });
  const run = (args: string[]) => runControlMurage([...args, '--url', fixture.info.url], { env: { MURAGE_DATA_DIR: fixture.info.dataDir } }) as Promise<any>;
  try {
    expect((await run(['doctor'])).ok).toBe(true);
    const created = await run(['new-bot', '--name', 'Restart reader']), id = created.bot.id;
    await run(['send', '--bot', id, '--text', 'First fixture turn.']);
    expect((await run(['wait', '--bot', id, '--timeout', '30'])).status).toBe('settled');
    // Establish the required precondition with a read-only witness: ready persisted
    // readers at this authority epoch, after all normal initial preparation settles.
    const reader = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
    try {
      const ready = () => reader.prepare(`SELECT count(*) AS n FROM memory_recall_contexts c JOIN memory_recall_views v USING(view_id,generation)
        WHERE v.state!='ready' OR v.authority_epoch!=(SELECT epoch FROM memory_recall_epoch WHERE id=1)`).get()!.n === 0
        && Number(reader.prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n) >= 2;
      const until = Date.now() + 5_000;
      while (!ready() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      if (!ready()) console.info('S4 precondition snapshot', JSON.stringify({
        epoch: reader.prepare('SELECT * FROM memory_recall_epoch').all(),
        views: reader.prepare('SELECT authority_epoch,state,count(*) AS n FROM memory_recall_views GROUP BY authority_epoch,state').all(),
        contexts: reader.prepare('SELECT v.authority_epoch,v.state,count(*) AS n FROM memory_recall_contexts c JOIN memory_recall_views v USING(view_id,generation) GROUP BY v.authority_epoch,v.state').all(),
      }));
      expect(ready()).toBe(true);
    } finally { reader.close(); }
    if (reconstruct) {
      // MAIN RULING 1114-RECALL-S4-FIXTURES: a real invalid persisted candidate
      // forces construction after restart; the exact same observer must catch it.
      // Corrupt offline so startup maintenance cannot race this fixture-only write.
      await fixture.stop();
      const writer = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'));
      try { writer.exec("UPDATE memory_recall_views SET digest='corrupt'"); } finally { writer.close(); }
    }
    if (crash) {
      const exited = new Promise<void>(resolve => { fixture.child.once('exit', () => resolve()); });
      fixture.child.kill('SIGKILL'); await exited;
    }
    await fixture.restart();
    expect((await run(['doctor'])).ok).toBe(true);
    const before = readFileSync(fixture.info.logPath, 'utf8');
    await run(['send', '--bot', id, '--text', 'Restart fixture turn.']);
    expect((await run(['wait', '--bot', id, '--timeout', '30'])).status).toBe('settled');
    const log = readFileSync(fixture.info.logPath, 'utf8');
    const admissions = [...log.matchAll(/fixture admission (accepted|refused)/g)].map(match => match[1]);
    console.info('S4 observed launcher restart', JSON.stringify({ crash, firstAdmittedProbe: admissions.indexOf('accepted') + 1, admissions }));
    if (reconstruct) {
      expect(log).toContain('fixture full build');
      expect(log).toContain('fixture history walk');
      expect(() => expectNoRecallRebuild(log)).toThrow();
    } else {
      expectNoRecallRebuild(before);
      expectNoRecallRebuild(log);
    }
    // Preparation can revalidate access later; the first admission itself must never fail.
    expect(log).not.toContain('MEMORY_RECALL_UNAVAILABLE');
    expect(log).toContain('fixture admission probe');
    expect(log).toContain('fixture admission accepted');
    expect(log).not.toContain('fixture admission refused');
    console.info(reconstruct ? 'S4 reconstruction positive control: build and history walk detected'
      : 'S4 launcher restart: first admitted probe=1, history walks=0, startBuild calls=0');
    const messages = await run(['messages', '--bot', id, '--limit', '10']);
    expect(messages.messages.some((message: { text?: string }) => message.text === 'Restart fixture reply.')).toBe(true);
    expect(readFileSync(fixture.fixtureTurnLogPath, 'utf8').trim().split('\n')).toHaveLength(2);
  } finally { console.info('S4 launcher log', readFileSync(fixture.info.logPath, 'utf8')); await fixture.close(); }
}, 180_000);

it('a released 1.0.18 home first starts with empty derived views and its authority intact', async () => {
  const old = await releasedSchema(), db = new DatabaseSync(join(DATA_DIR, 'fixture-old-home.db'));
  try {
    old.migrateMemorySchema(db); expect(() => old.validateMemorySchema(db)).not.toThrow();
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_recall_views'").get()).toBeUndefined();
    db.exec("INSERT INTO memory_scopes VALUES('fixture-scope','conversation','fixture-thread','[]',1)");
    db.exec("INSERT INTO memory_records VALUES('fixture-pin',1,'fixture-scope','constraint','Pinned fixture.','owner-statement','active',1,1,NULL,NULL,1)");
    migrateMemorySchema(db);
    expect(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(0);
    expect(db.prepare("SELECT owner_pinned FROM memory_records WHERE id='fixture-pin'").get()!.owner_pinned).toBe(1);
  } finally { db.close(); }
});

it('speculative preparation has no silent 64-context queue cutoff', async () => {
  const store = await fixture(34), tasks = store.bots[0].tasks!;
  for (const task of tasks) expect(admit(store, task.threadId)).toBeDefined();
  expect(Number(database().prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n)).toBeGreaterThan(64);
});
