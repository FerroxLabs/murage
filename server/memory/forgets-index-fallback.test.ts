// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-g. Consumer owner: MAIN (bounded fallback and schema changes).
import { beforeEach, expect, it, vi } from 'vitest';
import { database } from '../database.ts';
import { freshDataDir } from './testing/recall-fixture.ts';
import { forgetIndexMissing, positionalWithheld } from './replay-lineage.ts';
import { buildOptionalIndexOffThread, optionalIndexReady } from './optional-index.ts';
import { TOMBSTONE_FORGETS, TOMBSTONE_FORGETS_INDEX } from './schema.ts';

beforeEach(() => freshDataDir('active'));

it('a missing forget index avoids repeated failed preparation, reads new withdrawals, and detects index creation and removal', async () => {
  const db = database(), thread = 'fallback-fixture';
  if (optionalIndexReady(db, TOMBSTONE_FORGETS_INDEX)) db.exec(`DROP INDEX ${TOMBSTONE_FORGETS_INDEX}`);
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot','text','fixture','{}')");
  insert.run(thread, 'forgotten', 1100);
  insert.run(thread, 'reply', 1200);
  const raw = db.prepare.bind(db);
  let prepares = 0, executions = 0, schemaReads = 0, inject = false;
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const indexed = sql.includes(`INDEXED BY ${TOMBSTONE_FORGETS_INDEX}`);
    if (indexed) prepares++;
    const statement = raw(sql);
    if (sql === "SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?") {
      const get = statement.get;
      statement.get = ((...args: unknown[]) => {
        schemaReads++;
        return Reflect.apply(get, statement, args);
      }) as typeof statement.get;
    }
    if (indexed) {
      const all = statement.all;
      statement.all = ((...args: unknown[]) => {
        executions++;
        if (inject) throw new Error('fixture-index-read');
        return Reflect.apply(all, statement, args);
      }) as typeof statement.all;
    }
    return statement;
  });
  const read = () => positionalWithheld(thread, ['reply']).has('reply');
  try {
    for (let n = 0; n < 3; n++) expect(read()).toBe(false);
    expect(prepares).toBe(1);
    expect(schemaReads).toBe(0);
    db.prepare("INSERT INTO memory_tombstones VALUES('fallback-forget','source',?,NULL,NULL,0,'owner-forget',1500)").run(`message:${thread}:forgotten`);
    expect(read()).toBe(true);
    expect(prepares).toBe(1);
    expect(await buildOptionalIndexOffThread(db, TOMBSTONE_FORGETS, { inline: true })).toBe(true);
    inject = true;
    expect(read).toThrow('fixture-index-read');
    inject = false;
    expect(read()).toBe(true);
    db.exec(`DROP INDEX ${TOMBSTONE_FORGETS_INDEX}`);
    expect(read()).toBe(true);
    const attempts = executions;
    expect(read()).toBe(true);
    expect(executions).toBe(attempts);
    expect(await buildOptionalIndexOffThread(db, TOMBSTONE_FORGETS, { inline: true })).toBe(true);
    expect(read()).toBe(true);
    expect(executions).toBeGreaterThan(attempts);
  } finally { spy.mockRestore(); }
});

it('an identically named table never counts as the forget index', () => {
  const db = database();
  if (optionalIndexReady(db, TOMBSTONE_FORGETS_INDEX)) db.exec(`DROP INDEX ${TOMBSTONE_FORGETS_INDEX}`);
  db.exec(`CREATE TABLE ${TOMBSTONE_FORGETS_INDEX}(id TEXT PRIMARY KEY) WITHOUT ROWID`);
  expect(db.prepare('SELECT 1 FROM pragma_index_info(?) LIMIT 1').get(TOMBSTONE_FORGETS_INDEX)).toBeDefined();
  expect(forgetIndexMissing(db)).toBe(true);
});
