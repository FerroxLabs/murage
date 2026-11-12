// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { nextReclaimStep, ROOT_SET_RECLAIM_TABLES } from './root-set-reclaim.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { withoutDroppedTableTriggers } from './read-time-retired.ts';

it('reclaim status probes the schema once per connection/schema change, never per status poll', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reclaim-probes-'));
  const path = join(dir, 'fixture.db');
  const db = new DatabaseSync(path), peer = new DatabaseSync(path);
  const prepare = db.prepare.bind(db);
  let probes = 0;
  db.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (/sqlite_schema/.test(sql)) for (const method of ['get', 'all'] as const) {
      const original = statement[method];
      Object.defineProperty(statement, method, { value: (...args: unknown[]) => { probes++; return Reflect.apply(original, statement, args); } });
    }
    return statement;
  };
  try {
    db.exec('PRAGMA auto_vacuum=INCREMENTAL; CREATE TABLE kept(id INTEGER)');
    for (let i = 0; i < 100; i++) {
      expect(nextReclaimStep(db).kind).toBe('done');
      db.exec('BEGIN');
      expect(withoutDroppedTableTriggers(db, 'CREATE TEMP TRIGGER example AFTER INSERT ON main.memory_root_sets BEGIN SELECT 1; END;')).toBe('');
      db.exec('COMMIT');
    }
    expect(probes).toBe(1);
    // Changes on another connection must invalidate a cached absence.
    const table = ROOT_SET_RECLAIM_TABLES[0];
    peer.exec(`CREATE TABLE ${table}(id INTEGER); INSERT INTO ${table} VALUES(1)`);
    expect(nextReclaimStep(db)).toEqual({ kind: 'clear', name: table });
    expect(probes).toBe(2);
    // Data changes need no schema read, but still change the next action.
    peer.exec(`DELETE FROM ${table}`);
    expect(nextReclaimStep(db)).toEqual({ kind: 'drop-table', name: table });
    expect(probes).toBe(2);
    peer.exec(`DROP TABLE ${table}`);
    expect(nextReclaimStep(db).kind).toMatch(/done|shrink/);
    expect(probes).toBe(3);
    // A transaction's speculative schema must never poison the durable cache.
    db.exec(`BEGIN; CREATE TABLE ${table}(id INTEGER)`);
    expect(nextReclaimStep(db).kind).toBe('drop-table');
    db.exec('ROLLBACK; CREATE TABLE unrelated(id INTEGER)');
    expect(nextReclaimStep(db).kind).toMatch(/done|shrink/);
  } finally { peer.close(); db.close(); removeTempDirSync(dir); }
});
