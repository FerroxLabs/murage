// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-g. Consumer owner: MAIN (native preparation work).
import { DatabaseSync } from '../sqlite-open.ts';
import { expect, it, vi } from 'vitest';
import { database } from '../database.ts';
import { buildOptionalIndexOffThread } from './optional-index.ts';
import { TOMBSTONE_FORGETS } from './schema.ts';
import { lineageWarmStep } from './lineage-warm.ts';
import { r14Surface } from './testing/turnstart-r14-surface.ts';

it('one real warmer slice compiles each repeated statement once while executing the full confirmation', async () => {
  const s=r14Surface(), raw=DatabaseSync.prototype.prepare;
  let tracked: object | undefined, measuring=false;
  const counts=new Map<string,number>();
  const spy=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this: DatabaseSync,sql: string) {
    if(measuring&&this===tracked)counts.set(sql,(counts.get(sql)??0)+1);
    return raw.call(this,sql);
  });
  try {
    const [thread]=s.fixture('plain',{lines:12});
    expect(await buildOptionalIndexOffThread(database(),TOMBSTONE_FORGETS,{inline:true})).toBe(true);
    s.send(thread!);s.dispatch(thread!);
    tracked=database();measuring=true;
    expect(lineageWarmStep(25)).toBe(true);
    measuring=false;
    expect(s.record(thread!)!.lastConfirm).not.toBeNull();
    expect(s.record(thread!)!.lastConfirm!.order).toEqual(['E2','E1']);
    expect(s.record(thread!)!.lastConfirm!.passes.map(pass=>pass.room)).toEqual(['least','most']);
    expect(counts.size).toBeGreaterThan(0);
    expect(Math.max(...counts.values())).toBe(1);
  } finally {measuring=false;spy.mockRestore();s.setLimits(null);}
});
