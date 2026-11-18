// SPDX-License-Identifier: AGPL-3.0-or-later
// Meter producer owner: recall-fixg-qi. Consumers: recall-classc-j, MAIN (qualification).
import { beforeEach, expect, it } from 'vitest';
import { database } from '../database.ts';
import { freshDataDir } from './testing/recall-fixture.ts';
import { sqlWork } from './testing/sql-work.ts';

beforeEach(() => freshDataDir('active'));

it('counts executions of already prepared and bound statements as well as later statements', () => {
  const db = database(), early = db.prepare('SELECT 1 AS value');
  const cached = [early.get.bind(early), early.all.bind(early), () => [...early.iterate()], early.run.bind(early)];
  for (const execute of cached) {
    const first = sqlWork<unknown>(db, execute);
    const second = sqlWork(db, () => db.prepare('SELECT 2 AS value').get());
    expect(first.work.statements).toBe(1);
    expect(second.work.statements).toBe(1);
  }
});
