// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-g. Consumer owner: MAIN (bounded warm slices).
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import * as io from './io-budget.ts';

it('reuses compilation across synchronous proof passes while each pass keeps its own freshness identity', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE fixture(value);INSERT INTO fixture VALUES(1)');
  const raw = db.prepare.bind(db); let compiles = 0;
  db.prepare = ((sql: string) => { if(sql === 'SELECT value FROM fixture') compiles++; return raw(sql); }) as typeof db.prepare;
  const stop = io.instrumentDatabase(db, new io.IoBudget({ read: () => ({at:0,fsWriteBlocks:0,cpuMicros:0}), systemOverloaded: () => null, log: () => {} }), {bytes:false});
  const compiledPass = (io as unknown as {withPreparedStatementReuse?: <T>(work: () => T) => T}).withPreparedStatementReuse ?? (<T>(work: () => T) => work());
  try {
    const passes: number[] = [], values: unknown[] = [];
    compiledPass(() => {
      expect(io.statementReusePassId()).toBe(0);
      for(let n=1;n<=3;n++) {
        io.withStatementReuse(() => {passes.push(io.statementReusePassId());values.push(db.prepare('SELECT value FROM fixture').get()!.value);});
        db.prepare('UPDATE fixture SET value=?').run(n+1);
      }
    });
    expect(values).toEqual([1,2,3]);
    expect(passes.every(id=>id>0)).toBe(true);
    expect(new Set(passes).size).toBe(3);
    expect(compiles).toBe(1);
    io.withStatementReuse(() => {expect(db.prepare('SELECT value FROM fixture').get()!.value).toBe(4);});
    expect(compiles).toBe(2);
    expect(io.statementReusePassId()).toBe(0);
    expect(io.inStatementReusePass()).toBe(false);
  } finally {stop();db.close();}
});
