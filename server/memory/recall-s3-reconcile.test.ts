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
