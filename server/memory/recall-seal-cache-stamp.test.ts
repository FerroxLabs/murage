// Cache repair consumer: r2-thread-seal-y; lineage validation producer: recall-scope.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { closeDatabase, connectionId, database } from '../database.ts';
import { databaseStamp, lineageTriggersInstalled, prepareLineageCache } from './replay-lineage.ts';
import { freshDataDir } from './testing/recall-fixture.ts';

vi.hoisted(() => vi.resetModules());

vi.mock('node:crypto', async original => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => actual.randomUUID().replace(/^./, 'e') };
});
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

it('failed trigger setup keeps an e-prefixed connection on the per-write fallback', () => {
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql.includes('CREATE TEMP TABLE IF NOT EXISTS lineage_epoch')) throw new Error('fixture deferred trigger setup');
    return exec.call(this, sql);
  });
  freshDataDir('active');
  const db = database();
  expect(connectionId(db)).toMatch(/^e/);
  expect(lineageTriggersInstalled()).toBe(false);
  expect(() => prepareLineageCache()).not.toThrow();
  const before = databaseStamp();
  db.exec('CREATE TEMP TABLE fixture_change(n INTEGER); INSERT INTO fixture_change VALUES(1)');
  expect(databaseStamp()).not.toBe(before);
  expect(() => prepareLineageCache()).not.toThrow();
});
