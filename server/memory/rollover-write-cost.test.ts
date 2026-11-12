// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MemoryIndex } from './index.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import type { DatabaseSync } from 'node:sqlite';

// Measure the complete per-turn lifecycle, including the worker's subsequent
// maintenance. Bounding only upsert hid a forced whole-index merge per turn.
function rolloverBytes(history: number) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-rollover-cost-'));
  const index = new MemoryIndex(join(dir, 'index.db'));
  const db = (index as unknown as { db: DatabaseSync }).db;
  try {
    for (let at = 0; at < history; at += 100) index.upsert(Array.from({ length: Math.min(100, history - at) }, (_, n) => ({
      id: `source:${at + n}`, version: 1, scopeId: 'fixture', deleted: false, ageKey: at + n + 1,
      text: Array.from({ length: 60 }, (_, j) => `word${j}record${at + n}`).join(' '),
    })));
    db.exec("INSERT INTO lexical(lexical) VALUES('optimize')");
    const checkpoint = (version: number) => ({ id: 'checkpoint:fixture', version, scopeId: 'fixture', text: `Working evidence ${version}`, deleted: false, ageKey: history + version });
    index.upsert([checkpoint(1)]);
    index.checkpointNow();
    const before = index.ioBytes();
    for (let turn = 1; turn <= 12; turn++) {
      index.upsert([{ ...checkpoint(turn), deleted: true, rolled: true }, checkpoint(turn + 1)]);
      let steps = 0;
      index.ioBytes(); // Sample before SQLite can reuse an automatically checkpointed WAL.
      while (true) {
        const step = index.purgeRolledCheckpoints(); index.ioBytes();
        if (step.done) break;
        if (++steps > 10000) throw new Error('maintenance did not finish');
      }
    }
    const bytes = index.ioBytes() - before;
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE id='checkpoint:fixture'").get()?.n).toBe(1);
    expect(index.search('word7record7', [{ id: 'source:7', version: 1 }], null, 'unused').hits).toHaveLength(1);
    return bytes;
  } finally { index.close(); removeTempDirSync(dir); }
}

it('twelve checkpoint rollovers write changed rows, independent of 100x unrelated history', () => {
  const small = rolloverBytes(100), large = rolloverBytes(10000);
  console.log(JSON.stringify({ small, large, turns: 12 }));
  expect(large).toBeLessThan(3 * 1024 * 1024);
  expect(large).toBeLessThan(small * 4);
}, 120000);
