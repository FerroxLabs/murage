// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { closeSealed, openTestIndex, put } from './testing/open-index.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import type { DatabaseSync } from 'node:sqlite';
import type {IndexWalWriter} from './index-wal.ts';
import {MEMW_W_MERGE_BYTES} from './index-wal.ts';

// Measure the complete per-turn lifecycle, including the worker's subsequent
// maintenance. Bounding only upsert hid a forced whole-index merge per turn.
async function rolloverBytes(history: number) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-rollover-cost-'));
  const index = await openTestIndex(join(dir, 'index.db'));
  const db = (index as unknown as { db: DatabaseSync }).db;
  try {
    for (let at = 0; at < history; at += 100) await put(index,Array.from({ length: Math.min(100, history - at) }, (_, n) => ({
      id: `source:${at + n}`, version: 1, scopeId: 'fixture', deleted: false, ageKey: at + n + 1,
      text: Array.from({ length: 60 }, (_, j) => `word${j}record${at + n}`).join(' '),
    })));
    // Establish the same fully merged history through bounded checked writes;
    // a raw optimize can itself cross the new 28 MiB safety ceiling.
    const writer=(index as unknown as {writer:IndexWalWriter}).writer;
    for(let step=0;;step++){
      if(step>10000)throw new Error('setup merge did not finish');
      let changes=0;
      writer.write("merge",MEMW_W_MERGE_BYTES,()=>{
        const before=Number(db.prepare("SELECT total_changes() AS n").get()!.n);
        db.exec(`INSERT INTO lexical(lexical,rank) VALUES('merge',${step===0?-8:8})`);
        changes=Number(db.prepare("SELECT total_changes() AS n").get()!.n)-before;
      });
      await writer.check();await index.sealAndTruncate();
      if(changes<2)break;
    }
    const checkpoint = (version: number) => ({ id: 'checkpoint:fixture', version, scopeId: 'fixture', text: `Working evidence ${version}`, deleted: false, ageKey: history + version });
    await put(index,[checkpoint(1)]);
    await index.sealAndTruncate();
    const before = index.ioBytes();
    for (let turn = 1; turn <= 12; turn++) {
      await put(index,[{ ...checkpoint(turn), deleted: true, rolled: true }, checkpoint(turn + 1)]);
      let steps = 0;
      index.ioBytes(); // Sample before SQLite can reuse an automatically checkpointed WAL.
      while (true) {
        const step = await index.purgeRolledCheckpoints(); index.ioBytes();
        if (step.done) break;
        if (++steps > 10000) throw new Error('maintenance did not finish');
      }
    }
    const bytes = index.ioBytes() - before;
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE id='checkpoint:fixture'").get()?.n).toBe(1);
    expect(index.search('word7record7', [{ id: 'source:7', version: 1 }], null, 'unused').hits).toHaveLength(1);
    return bytes;
  } finally { await closeSealed(index); removeTempDirSync(dir); }
}

it('twelve checkpoint rollovers write changed rows, independent of 100x unrelated history', async () => {
  const small = await rolloverBytes(100), large = await rolloverBytes(10000);
  console.log(JSON.stringify({ small, large, turns: 12 }));
  expect(large).toBeLessThan(3 * 1024 * 1024);
  expect(large).toBeLessThan(small * 4);
}, 120000);
