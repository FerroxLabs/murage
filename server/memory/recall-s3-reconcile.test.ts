// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s3 (reconciliation and roster certificates).
// Consumer owner: recall-scope (S4 background hydration); recall-s3 owns these regressions.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, databaseGeneration } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { Store } from '../store.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import * as policy from './policy.ts';
import { assertMemoryAccess, ensureScope, memoryAccess, persistMemoryRoster, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { prepareRecallContextSync, stopRecallViewMaintenance } from './recall-view.ts';
import { sqlWork } from './testing/sql-work.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });
const epoch = () => Number(database().prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch);
function fixture() {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', section: 'Team' }], groups: [{ id: 'room', threadId: 'room-thread', memberIds: ['reader'] }] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin('reader', 'direct', 'generation');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'generation', depth: 0, kind: 'memory', skillAuthoring: false });
  const issue = () => memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  prepareRecallContextSync('reader', 'direct', roster);
  return { roster, issue };
}
it('unchanged startup reconciliation preserves epoch and writes no rows', () => {
  const f = fixture(), before = epoch();
  closeDatabase(); const db = database();
  const measured = sqlWork(db, () => reconcileMemoryRoster(f.roster, { unlessUnchanged: true }));
  expect(epoch()).toBe(before); expect(measured.work.changed).toBe(0);
  expect([...measured.work.sqls.keys()].some(sql => /^(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(false);
  // S3 preserves durable authority; S4 alone may hydrate the cold cache.
  expect(() => f.issue()).toThrow('MEMORY_RECALL_UNAVAILABLE');
});
it('unchanged reconciliation preserves a valid workspace binding with duplicate legacy owners', () => {
  const f = fixture(), db = database();
  const original = db.prepare("SELECT scope_id FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()!.scope_id;
  db.prepare("INSERT INTO memory_scopes SELECT 'duplicate-workspace',kind,owner_key,audience,revision FROM memory_scopes WHERE id=?").run(original);
  const before = epoch();
  expect(sqlWork(db, () => reconcileMemoryRoster(f.roster)).work.changed).toBe(0);
  expect(epoch()).toBe(before);
  expect(db.prepare("SELECT scope_id FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()!.scope_id).toBe(original);
});
it('same-process repeated reconciliation also writes nothing', () => {
  const f = fixture(), before = epoch();
  expect(sqlWork(database(), () => reconcileMemoryRoster(f.roster)).work.changed).toBe(0);
  expect(epoch()).toBe(before);
});
for (const fault of ['pending binding', 'changed grant', 'missing scope', 'malformed intent', 'noncanonical intent', 'open team change'] as const) {
  it(`${fault} still moves the epoch despite the same roster fingerprint`, () => {
    const f = fixture(), old = f.issue(), db = database();
    if (fault === 'pending binding') db.exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'");
    if (fault === 'changed grant') db.exec("UPDATE memory_scope_bindings SET revision=revision+1 WHERE id='memory-roster-policy'");
    if (fault === 'missing scope') db.exec("DELETE FROM memory_scopes WHERE kind='room' AND owner_key='room'");
    if (fault === 'malformed intent') db.exec("UPDATE memory_scope_bindings SET intent='{}' WHERE id='memory-roster-policy'");
    if (fault === 'noncanonical intent') db.exec("UPDATE memory_scope_bindings SET intent=' '||intent WHERE id='memory-roster-policy'");
    if (fault === 'open team change') db.exec("INSERT INTO team_identities(team_id,label,created_at,updated_at,op) VALUES('team','Team',1,1,'rename')");
    const before = epoch();
    reconcileMemoryRoster(f.roster, { unlessUnchanged: true });
    expect(epoch()).toBeGreaterThan(before);
    expect(() => assertMemoryAccess(old)).toThrow();
    expect(db.prepare("SELECT 1 FROM memory_scopes WHERE kind='room' AND owner_key='room'").get()).toBeDefined();
  });
}
it('a real sharing removal still invalidates an old view and removes its room', () => {
  const f = fixture(), old = f.issue(), scope = ensureScope('room', 'room'), before = epoch();
  expect(() => assertMemoryAccess(old, scope)).not.toThrow();
  f.roster.groups[0].memberIds = []; f.roster.memoryRosterRevision!++;
  reconcileMemoryRoster(f.roster);
  expect(epoch()).toBeGreaterThan(before); expect(() => assertMemoryAccess(old, scope)).toThrow();
  prepareRecallContextSync('reader', 'direct', f.roster);
  expect(() => assertMemoryAccess(f.issue(), scope)).toThrow('MEMORY_SCOPE_DENIED');
});
for (const crash of ['before file', 'after file'] as const) it(`restart after roster save crash ${crash} never admits the old ready view`, () => {
  const f = fixture(), old = f.issue(), before = epoch();
  const next = structuredClone(f.roster); next.groups[0].memberIds = []; next.memoryRosterRevision!++;
  let durable = f.roster;
  expect(() => persistMemoryRoster(next, () => { if (crash === 'after file') durable = next; throw new Error('fixture crash'); })).toThrow('fixture crash');
  expect(epoch()).toBeGreaterThan(before);
  expect(database().prepare("SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.state).toBe('pending');
  closeDatabase(); database();
  expect(() => f.issue()).toThrow();
  const atRestart = epoch(); reconcileMemoryRoster(durable, { unlessUnchanged: true });
  expect(epoch()).toBeGreaterThan(atRestart); expect(() => assertMemoryAccess(old)).toThrow();
  expect(() => f.issue()).toThrow();
});
it('crash inside reconciliation rolls back grant, scopes and epoch together', () => {
  const f = fixture(), db = database(), before = epoch();
  const intent = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()!.intent;
  const next = structuredClone(f.roster); next.bots.push({ id: 'new-reader', threadId: 'new-direct' });
  db.exec("CREATE TEMP TRIGGER fixture_crash BEFORE UPDATE ON memory_scope_bindings WHEN NEW.id='memory-roster-policy' BEGIN SELECT RAISE(ABORT,'fixture crash'); END");
  expect(() => reconcileMemoryRoster(next)).toThrow('fixture crash');
  expect(epoch()).toBe(before);
  expect(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()!.intent).toBe(intent);
  expect(db.prepare("SELECT 1 FROM memory_scopes WHERE owner_key='new-reader'").get()).toBeUndefined();
  closeDatabase(); database(); reconcileMemoryRoster(f.roster);
  expect(epoch()).toBe(before); expect(() => f.issue()).toThrow();
});
function storeFixture() {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  store.createBot({ name: 'Reader' }, { seedMessages: false });
  store.finishSharingBoot(); stopRecallViewMaintenance();
  return store;
}
function finish<T>(steps: Generator<void, T>): T { for (;;) { const item = steps.next(); if (item.done) return item.value; } }
it('certificate is absent until the yielding complete policy comparison publishes, with no durable writes', () => {
  const store = storeFixture();
  expect(store.recallRosterCertificate()).toBeUndefined();
  const proof = store.certifyRecallRosterSteps();
  expect(proof.next().done).toBe(false); expect(store.recallRosterCertificate()).toBeUndefined();
  const measured = sqlWork(database(), () => finish(proof));
  expect(measured.result).toEqual({ databaseGeneration: databaseGeneration(), epoch: epoch(), rosterRevision: store.memoryRosterRevision });
  expect(store.recallRosterCertificate()).toBe(measured.result); expect(measured.work.changed).toBe(0);
});
for (const race of ['epoch', 'roster revision', 'database generation', 'missing epoch', 'pending binding', 'open team change'] as const) it(`certificate fences ${race} at every suspended step including final publication`, () => {
  const store = storeFixture();
  const count = (() => { const proof = store.certifyRecallRosterSteps(); let n = 0; while (!proof.next().done) n++; return n; })();
  expect(count).toBeGreaterThan(1);
  for (let boundary = 1; boundary <= count; boundary++) {
    const proof = store.certifyRecallRosterSteps();
    for (let n = 0; n < boundary; n++) expect(proof.next().done).toBe(false);
    const db = database();
    if (race === 'epoch') db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1');
    if (race === 'roster revision') (store as unknown as { memoryRosterCounter: number }).memoryRosterCounter++;
    if (race === 'database generation') { closeDatabase(); database(); }
    if (race === 'missing epoch') db.exec('DELETE FROM memory_recall_epoch WHERE id=1');
    if (race === 'pending binding') db.exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'");
    if (race === 'open team change') db.exec("INSERT OR REPLACE INTO team_identities(team_id,label,created_at,updated_at,op) VALUES('team','Team',1,1,'rename')");
    expect(finish(proof)).toBeUndefined(); expect(store.recallRosterCertificate()).toBeUndefined();
    if (race === 'missing epoch') database().exec('INSERT INTO memory_recall_epoch(id,epoch,projection_floor) VALUES(1,1000,0)');
    if (race === 'pending binding') reconcileMemoryRoster(store);
    if (race === 'open team change') database().exec('DELETE FROM team_identities');
  }
}, 180_000);
it('a certificate proves sharing and role facts, never the fingerprint prefix alone', () => {
  const store = storeFixture();
  finish(store.certifyRecallRosterSteps()); expect(store.recallRosterCertificate()).toBeDefined();
  const bot = store.bots[0];
  for (const patch of [{ individual: true }, { sharedWith: { mode: 'all' as const, teams: [] } }, { partitionedAt: 1 }]) {
    Object.assign(bot, patch);
    expect(finish(store.certifyRecallRosterSteps())).toBeUndefined();
    expect(store.recallRosterCertificate()).toBeUndefined();
    reconcileMemoryRoster(store);
  }
});
it('crash during certificate computation persists nothing and never certifies after restart', () => {
  const store = storeFixture(), proof = store.certifyRecallRosterSteps(), before = epoch();
  expect(proof.next().done).toBe(false);
  closeDatabase(); database();
  expect(store.recallRosterCertificate()).toBeUndefined(); expect(finish(proof)).toBeUndefined();
  reconcileMemoryRoster(store); expect(epoch()).toBe(before);
  expect(finish(store.certifyRecallRosterSteps())).toBeDefined();
});
it('boot and structural publications schedule certification off the caller path', async () => {
  const store = storeFixture();
  for (let n = 0; n < 200 && !store.recallRosterCertificate(); n++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(store.recallRosterCertificate()).toBeDefined();
  store.createBot({ name: 'Other' }, { seedMessages: false }); stopRecallViewMaintenance();
  expect(store.recallRosterCertificate()).toBeUndefined();
  for (let n = 0; n < 200 && !store.recallRosterCertificate(); n++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(store.recallRosterCertificate()?.rosterRevision).toBe(store.memoryRosterRevision);
});

// MAIN RULING 2026-11-17T19:46Z: old handles never survive an epoch; live readers revalidate.
it('a reconciled epoch refuses the old handle even after a live replacement is ready', () => {
  const f = fixture(), old = f.issue();
  database().exec("UPDATE memory_scope_bindings SET revision=revision+1 WHERE id='memory-roster-policy'");
  reconcileMemoryRoster(f.roster);
  expect(() => assertMemoryAccess(f.issue())).not.toThrow();
  expect(() => assertMemoryAccess(old)).toThrow();
  expect(policy.lineageReaderAudience(old).view).toEqual(f.issue().view);
  expect(() => assertMemoryAccess(old)).toThrow();
});
it('a revalidated live reader continues at the new epoch and must revalidate again at the next', () => {
  const f = fixture(), old = f.issue(), scope = ensureScope('bot', 'reader');
  database().exec("UPDATE memory_scope_bindings SET revision=revision+1 WHERE id='memory-roster-policy'");
  reconcileMemoryRoster(f.roster);
  expect(typeof policy.revalidateMemoryAccess).toBe('function');
  const live = policy.revalidateMemoryAccess(old);
  expect(live).not.toBe(old);
  expect(() => assertMemoryAccess(live)).not.toThrow();
  expect(() => assertMemoryAccess(live, scope)).not.toThrow();
  expect(() => assertMemoryAccess(old)).toThrow();
  database().exec("UPDATE memory_scope_bindings SET revision=revision+1 WHERE id='memory-roster-policy'");
  reconcileMemoryRoster(f.roster);
  expect(() => assertMemoryAccess(live)).toThrow();
  expect(() => assertMemoryAccess(policy.revalidateMemoryAccess(live), scope)).not.toThrow();
});
it('revalidation records the intersection and never grants a newly added scope', () => {
  const f = fixture(), old = f.issue(), db = database();
  const scope = ensureScope('project', 'new-project');
  db.prepare("INSERT INTO memory_scope_bindings VALUES('new-grant',?,'bot','reader',0,'granted','{}')").run(scope);
  prepareRecallContextSync('reader', 'direct', f.roster);
  expect(typeof policy.revalidateMemoryAccess).toBe('function');
  const live = policy.revalidateMemoryAccess(old);
  expect(() => assertMemoryAccess(live)).not.toThrow();
  expect(live.scopeIds).not.toContain(scope);
  expect(() => assertMemoryAccess(live, scope)).toThrow('MEMORY_SCOPE_DENIED');
  expect(() => assertMemoryAccess(f.issue(), scope)).not.toThrow();
});
it('revalidation refuses a reader removed by the new epoch and cannot revive a dead claim', () => {
  const f = fixture(), registry = new InternalCapabilities();
  registry.begin('reader', 'room-thread', 'room-generation');
  const token = registry.mint({ botId: 'reader', threadId: 'room-thread', generation: 'room-generation', depth: 0, kind: 'memory', skillAuthoring: false });
  prepareRecallContextSync('reader', 'room-thread', f.roster);
  const old = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => f.roster);
  f.roster.groups[0].memberIds = []; f.roster.memoryRosterRevision!++;
  reconcileMemoryRoster(f.roster);
  expect(typeof policy.revalidateMemoryAccess).toBe('function');
  expect(() => policy.revalidateMemoryAccess(old)).toThrow();
  registry.revokeAll();
  expect(() => policy.revalidateMemoryAccess(old)).toThrow('MEMORY_UNAUTHORIZED');
});

for (const watermark of ['policy_revision', 'deletion_epoch'] as const) it(`revalidation cannot bridge a changed ${watermark}`, () => {
  const f = fixture(), old = f.issue();
  database().exec(`UPDATE memory_meta SET ${watermark}=${watermark}+1 WHERE id=1`);
  prepareRecallContextSync('reader', 'direct', f.roster);
  expect(() => policy.revalidateMemoryAccess(old)).toThrow('MEMORY_CONTEXT_REVOKED');
  expect(() => policy.revalidateMemoryAccess({ ...old })).toThrow('MEMORY_UNAUTHORIZED');
});

it('successive revalidation never regains a withdrawn scope after it is regranted', () => {
  const f = fixture(), db = database(), scope = ensureScope('project', 'fixture-project');
  db.prepare("INSERT INTO memory_scope_bindings VALUES('fixture-grant',?,'bot','reader',0,'granted','{}')").run(scope);
  prepareRecallContextSync('reader', 'direct', f.roster);
  const old = f.issue();
  expect(() => assertMemoryAccess(old, scope)).not.toThrow();
  db.exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='fixture-grant'");
  prepareRecallContextSync('reader', 'direct', f.roster);
  const narrowed = policy.revalidateMemoryAccess(old);
  expect(() => assertMemoryAccess(narrowed, scope)).toThrow('MEMORY_SCOPE_DENIED');
  db.exec("UPDATE memory_scope_bindings SET state='granted' WHERE id='fixture-grant'");
  prepareRecallContextSync('reader', 'direct', f.roster);
  const live = policy.revalidateMemoryAccess(narrowed);
  expect(() => assertMemoryAccess(live)).not.toThrow();
  expect(live.scopeIds).not.toContain(scope);
  expect(() => assertMemoryAccess(live, scope)).toThrow('MEMORY_SCOPE_DENIED');
  expect(() => assertMemoryAccess(f.issue(), scope)).not.toThrow();
  expect(() => assertMemoryAccess(policy.revalidateMemoryAccess(old), scope)).toThrow('MEMORY_SCOPE_DENIED');
});
it('S2 a revalidated live room reader continues its proven retained session', async () => {
  const { setupProofFixture, receipts, proofModule } = await import('./session-proof-fixture.ts');
  const { LineageAllowance } = await import('./lineage-allowance.ts');
  const f = setupProofFixture('room-thread'), proof = await proofModule();
  await receipts(f, 1);
  expect(proof.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: true })).toEqual({ kind: 'resume' });
  database().exec("UPDATE memory_scope_bindings SET revision=revision+1 WHERE id='memory-roster-policy'");
  reconcileMemoryRoster(f.roster);
  expect(() => assertMemoryAccess(f.access)).toThrow();
  const live = policy.revalidateMemoryAccess(f.access);
  expect(proof.proveRetainedSession(LineageAllowance.tool(), f.key, { access: live, disclosed: true })).toEqual({ kind: 'resume' });
});

it('revalidation constrains lineage and a cached retained footprint to the recorded intersection', async () => {
  const { setupProofFixture, receipts, proofModule } = await import('./session-proof-fixture.ts');
  const { LineageAllowance } = await import('./lineage-allowance.ts');
  const { refsLookup } = await import('./deny-read.ts');
  const f = setupProofFixture('room-thread'), proof = await proofModule(), db = database();
  const [bundleId] = await receipts(f, 1);
  expect(proof.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: true })).toEqual({ kind: 'resume' });
  const scope = ensureScope('project', 'fixture-new-project');
  db.prepare("INSERT INTO memory_scope_bindings VALUES('fixture-new-grant',?,'room','room',0,'granted','{}')").run(scope);
  prepareRecallContextSync('reader', 'room-thread', f.roster);
  const current = f.issue(), live = policy.revalidateMemoryAccess(f.access);
  const lsn = Number(db.prepare("SELECT max(value) AS n FROM memory_lineage_lsn_meta WHERE key IN ('policy_bump_lsn','epoch_bump_lsn')").get()!.n);
  const refs = [{ kind: 'receipt' as const, bundleId, lsn, scopeIds: [scope] }];
  expect(refsLookup(db, refs, { audience: { ...policy.lineageReaderAudience(current), owner: false } }).state).toBe('shown');
  expect(refsLookup(db, refs, { audience: { ...policy.lineageReaderAudience(live), owner: false } })).toMatchObject({ state: 'withheld', reason: 'footprint' });
  // A durable prior checkpoint can already name the current full view; that shortcut cannot override this handle's narrower grant.
  // The checkpoint is the v2 envelope {v:2,s,dg} (DESIGN-B5-PROOF F1): only its scope list is rewritten, the proved deny generation stays.
  db.prepare("UPDATE memory_session_checks SET recall_epoch=?,view_id=?,view_generation=?,view_digest=?,footprint=json_set(footprint,'$.s',json(?)) WHERE thread_id=? AND driver_instance=? AND native_session=?")
    .run(epoch(), current.view.viewId, current.view.generation, current.view.digest, JSON.stringify([scope]), f.key.threadId, f.key.driverInstance, f.key.nativeSession);
  expect(JSON.parse(String(db.prepare('SELECT footprint FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=?').get(f.key.threadId, f.key.driverInstance, f.key.nativeSession)!.footprint))).toMatchObject({ v: 2, s: [scope] });
  expect(proof.proveRetainedSession(LineageAllowance.tool(), f.key, { access: current, disclosed: true })).toEqual({ kind: 'resume' });
  expect(proof.proveRetainedSession(LineageAllowance.tool(), f.key, { access: live, disclosed: true })).toMatchObject({ kind: 'fresh', reason: 'scope-left-view' });
  db.prepare("UPDATE memory_session_checks SET footprint=json_set(footprint,'$.s',json(?)) WHERE thread_id=? AND driver_instance=? AND native_session=?")
    .run(JSON.stringify('wide'), f.key.threadId, f.key.driverInstance, f.key.nativeSession);
  expect(proof.proveRetainedSession(LineageAllowance.tool(), f.key, { access: live, disclosed: true })).toMatchObject({ kind: 'fresh', reason: 'footprint-wide', cause: 'checking' });
  const { freezeLineageReader } = await import('./lineage-write.ts');
  const room = ensureScope('room', 'room'), scopeCeiling = [room];
  const frozen = freezeLineageReader({ audience: { ...policy.lineageReaderAudience(current), owner: false, scopeCeiling } });
  scopeCeiling.push(scope);
  expect(refsLookup(db, refs, frozen)).toMatchObject({ state: 'withheld', reason: 'footprint' });
  const ownRefs = [{ ...refs[0], scopeIds: [room] }];
  const narrowed = freezeLineageReader({ audience: { ...policy.lineageReaderAudience(live), owner: false } });
  expect(refsLookup(db, ownRefs, narrowed).state).toBe('shown');
  db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1');
  expect(refsLookup(db, ownRefs, narrowed).state).not.toBe('shown');
});

it('revalidation separates grant identities for cursors, replay caches and turn footprints', async () => {
  const { sealMemoryCursor, openMemoryCursor } = await import('./cursor.ts');
  const { accessStamp } = await import('./lineage-footprint.ts');
  const { readerAudience } = await import('./disclosures.ts');
  const { LineageAllowance } = await import('./lineage-allowance.ts');
  const f = fixture(), old = f.issue(), db = database(), scope = ensureScope('project', 'fixture-cursor-project');
  db.prepare("INSERT INTO memory_scope_bindings VALUES('fixture-cursor-grant',?,'bot','reader',0,'granted','{}')").run(scope);
  prepareRecallContextSync('reader', 'direct', f.roster);
  const current = f.issue(), live = policy.revalidateMemoryAccess(old), again = policy.revalidateMemoryAccess(old);
  expect(typeof live.scopeDigest).toBe('string');
  expect(accessStamp(live)).not.toBe(accessStamp(current));
  expect(accessStamp(again)).toBe(accessStamp(live));
  const cursor = sealMemoryCursor('["fixture",1]', live, false);
  expect(openMemoryCursor(cursor, again, false)).toBe('["fixture",1]');
  expect(() => openMemoryCursor(cursor, current, false)).toThrow('INVALID_MEMORY_CURSOR');
  expect(readerAudience(LineageAllowance.tool(), live).cacheKey).not.toBe(readerAudience(LineageAllowance.tool(), current).cacheKey);
  expect(readerAudience(LineageAllowance.tool(), again).cacheKey).toBe(readerAudience(LineageAllowance.tool(), live).cacheKey);
});
it('revalidation omits pins outside its ceiling even after the full view pin cache is warm', async () => {
  const { buildMemoryBundle } = await import('./bundle.ts');
  const { LineageAllowance } = await import('./lineage-allowance.ts');
  const { setMemoryMode } = await import('./repository.ts');
  const { OWNER_PIN } = await import('./schema.ts');
  setMemoryMode('active');
  const f = fixture(), old = f.issue(), db = database(), scope = ensureScope('project', 'fixture-pin-project');
  db.prepare("INSERT INTO memory_scope_bindings VALUES('fixture-pin-grant',?,'bot','reader',0,'granted','{}')").run(scope);
  db.prepare("INSERT INTO memory_records VALUES('fixture-new-pin',1,?,'constraint','A newly granted owner constraint.','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  db.exec(OWNER_PIN.sql);
  db.exec("UPDATE memory_records SET owner_pinned=1 WHERE id='fixture-new-pin'");
  prepareRecallContextSync('reader', 'direct', f.roster);
  const current = f.issue(), live = policy.revalidateMemoryAccess(old);
  const empty = { async search() { return { hits: [], vectorRows: 0 }; } };
  const full = await buildMemoryBundle('', current, empty, { allowance: LineageAllowance.tool(1_000_000_000) });
  expect(full.pinned.map(pin => pin.id)).toContain('fixture-new-pin');
  const narrowed = await buildMemoryBundle('', live, empty, { allowance: LineageAllowance.tool(1_000_000_000) });
  expect(narrowed.pinned).toEqual([]);
  expect(narrowed.text).not.toContain('A newly granted owner constraint.');
  const { MemoryDispatchReceipt } = await import('./dispatch.ts');
  const { assertMemoryBundle } = await import('./bundle.ts');
  const receipt = new MemoryDispatchReceipt(full, current, 'engine');
  db.exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='fixture-pin-grant'");
  prepareRecallContextSync('reader', 'direct', f.roster);
  const withdrawn = policy.revalidateMemoryAccess(current);
  expect(() => receipt.assertCurrent()).toThrow();
  expect(() => assertMemoryBundle(full, withdrawn)).toThrow('MEMORY_BUNDLE_UNTRUSTED');
});

it('S2 a live receipt revalidates its frame at writes and refuses a removed reader', async () => {
  const { setupProofFixture, receipts, proofModule } = await import('./session-proof-fixture.ts');
  const { buildMemoryBundle } = await import('./bundle.ts');
  const { MemoryDispatchReceipt } = await import('./dispatch.ts');
  const { LineageAllowance } = await import('./lineage-allowance.ts');
  const f = setupProofFixture('room-thread'), proof = await proofModule();
  await receipts(f, 1);
  expect(proof.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: true })).toEqual({ kind: 'resume' });
  const bundle = await buildMemoryBundle('', f.access, { async search() { return { hits: [], vectorRows: 0 }; } }, { allowance: LineageAllowance.tool() });
  const receipt = new MemoryDispatchReceipt(bundle, f.access, f.key.driverInstance);
  receipt.retains(f.key.nativeSession, { access: f.access, disclosed: true });
  const move = () => { database().exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1'); prepareRecallContextSync('reader', 'room-thread', f.roster); };
  move();
  expect(() => receipt.assertCurrent()).not.toThrow();
  expect(receipt.access).not.toBe(f.access);
  expect(() => assertMemoryAccess(receipt.access)).not.toThrow();
  expect(() => assertMemoryAccess(f.access)).toThrow();
  move(); expect(() => receipt.accepted()).not.toThrow();
  move(); expect(receipt.steerable()).toBe(true);
  f.roster.groups[0].memberIds = []; f.roster.memoryRosterRevision!++;
  reconcileMemoryRoster(f.roster);
  expect(() => receipt.assertCurrent()).toThrow();
  expect(() => receipt.accepted()).toThrow();
  expect(receipt.steerable()).toBe(false);
});

it('revalidation trusts certified view rows rather than poisoned compatibility snapshots', async () => {
  const { poisonRecallScopeArraysForTest } = await import('./recall-view.ts');
  const f = fixture(), old = f.issue(), db = database(), scope = ensureScope('project', 'fixture-poison-project');
  db.prepare("INSERT INTO memory_scope_bindings VALUES('fixture-poison-grant',?,'bot','reader',0,'granted','{}')").run(scope);
  prepareRecallContextSync('reader', 'direct', f.roster);
  const fresh = f.issue();
  // Keep frozen indexed properties intact; poison the compatibility filter without violating Proxy invariants.
  const poison = (ids: readonly string[]) => Object.assign([...ids], { filter: () => [scope] });
  poisonRecallScopeArraysForTest(old, poison(old.scopeIds));
  poisonRecallScopeArraysForTest(fresh, poison(fresh.scopeIds));
  const live = policy.revalidateMemoryAccess(old);
  expect(() => assertMemoryAccess(live, scope)).toThrow('MEMORY_SCOPE_DENIED');
  expect(() => assertMemoryAccess(live, ensureScope('bot', 'reader'))).not.toThrow();
  expect(live.scopeIds).not.toContain(scope);
});

it('relabelled durable metadata cannot replace the cached epoch certificate', () => {
  const f = fixture(), old = f.issue(), db = database();
  db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1; UPDATE memory_recall_views SET authority_epoch=(SELECT epoch FROM memory_recall_epoch WHERE id=1)');
  expect(() => f.issue()).toThrow();
  expect(() => assertMemoryAccess(old)).toThrow();
  prepareRecallContextSync('reader', 'direct', f.roster);
  expect(() => assertMemoryAccess(f.issue())).not.toThrow();
  expect(() => assertMemoryAccess(old)).toThrow();
});
it('a foreign epoch change cannot ride a scope memo in the same synchronous pass', async () => {
  const { spawnSync } = await import('node:child_process');
  const f = fixture(), old = f.issue(), db = database();
  const file = String(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')!.file);
  policy.inMemoryAccessPass(() => {
    expect(() => assertMemoryAccess(old)).not.toThrow();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1; UPDATE memory_recall_views SET authority_epoch=(SELECT epoch FROM memory_recall_epoch WHERE id=1)');db.close();", file], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(() => assertMemoryAccess(old)).toThrow();
  });
});

// Producer owner: recall-s1s2g (receipt validation); consumer owner: recall-privacy-close-b-n6 (bounded live checks).
for (const foreignChange of [false, true]) it(`receipt source validation shares one live pass (foreign epoch change=${foreignChange})`, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { setupProofFixture, receipts } = await import('./session-proof-fixture.ts');
  const { WritetimeFixture } = await import('./testing/writetime-fixture.ts');
  const { assertMemoryDisclosureCurrent } = await import('./disclosures.ts');
  const f = setupProofFixture('room-thread'), db = database(), scope = ensureScope('conversation', 'room-thread');
  const refs = Array.from({length:16}, (_, n) => {
    new WritetimeFixture(db).owner('room-thread', `receipt-line-${n}`, n+10).source(`receipt-source-${n}`, scope, {thread:'room-thread', message:`receipt-line-${n}`});
    return {id:`receipt-source-${n}`,revision:1};
  });
  const [id] = await receipts(f, 1);
  db.prepare('UPDATE memory_disclosures SET source_versions=? WHERE bundle_id=?').run(JSON.stringify(refs), id);
  const foreign = new DatabaseSync(String(db.prepare('PRAGMA database_list').get()!.file));
  const prepare = db.prepare; let sourceReads = 0;
  db.prepare = function(sql: string) {
    const statement = prepare.call(db, sql);
    if (!foreignChange || !sql.startsWith('SELECT scope_id,state,revision FROM memory_sources')) return statement;
    return new Proxy(statement, {get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'get') return (...args: unknown[]) => {
        const row = value.apply(target, args);
        if (++sourceReads === 3) foreign.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1');
        return row;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    }});
  };
  try {
    if (foreignChange) {
      expect(() => assertMemoryDisclosureCurrent(id, f.access)).toThrow('MEMORY_CONTEXT_REVOKED');
      expect(sourceReads).toBe(3);
    } else {
      const measured = sqlWork(db, () => assertMemoryDisclosureCurrent(id, f.access));
      const validations = [...measured.work.sqls].filter(([sql]) => sql.includes('AS projection_floor')).reduce((n, [, count]) => n+count, 0);
      expect(validations).toBe(2); // one initial check and one for the shared source scope
      expect(measured.work.sqls.get('SELECT scope_id,state,revision FROM memory_sources WHERE id=?')).toBe(16);
      expect(sourceReads).toBe(0);
    }
  } finally { db.prepare = prepare; foreign.close(); }
});
