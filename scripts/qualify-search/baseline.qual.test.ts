// SPDX-License-Identifier: AGPL-3.0-or-later
// Run this file on a b4dc27ea9 git archive with ONLY this harness overlaid.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { DATA_DIR } from '../../server/config.ts';
import { closeDatabase, database } from '../../server/database.ts';
import * as search from '../../server/message-search-index.ts';
import { searchMessagesWithMeta } from '../../server/message-db.ts';
import { stopWalMaintenance } from '../../server/wal-maintenance.ts';
import { clone, manifest, needles, completeParity, shadowBytes } from './copy-tools.ts';

it('legacy reference on the actual base', { tags: ['qual'] }, async () => {
  expect(process.env.MURAGE_QUAL_BASE_SHA, 'base archive identity').toMatch(/^b4dc27ea9/);
  const source = process.env.MURAGE_QUAL_COPY_SOURCE;
  const before = source ? manifest(source) : undefined;
  if (source) clone(source, DATA_DIR);
  const at = performance.now(), db = database(), openMs = performance.now() - at;
  try {
    if (!source) {
      const n = process.env.MURAGE_QUAL_SMOKE === '1' ? 120 : 103_000;
      let randomSeed = 0x1019;
      const random = () => { randomSeed = (Math.imul(randomSeed,1664525)+1013904223) >>> 0; return randomSeed / 0x100000000; };
      const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'user','text',?,?)");
      for (let offset = 0; offset < n; offset += 1000) {
        db.exec('BEGIN IMMEDIATE');
        for (let i = offset; i < Math.min(n, offset + 1000); i++) {
          const p = random(), length = p < .001 ? 65536 : p < .011 ? 4096 : p < .5 ? 80 : 81 + Math.floor(random() * 80);
          const text = ('synthetic canary ' + i + ' ' + Math.floor(random() * 1e9).toString(36) + ' ').padEnd(length, ' abcdefghijklmnopqrstuvwxyz');
          const thread = i < Math.min(4000,n/2) ? 'drop-' + (i < Math.min(2000,n/4) ? 0 : 1) : 'seed-' + i % 398;
          insert.run(thread,'seed-'+i,i+1,text,JSON.stringify({id:'seed-'+i,at:i+1,role:'user',kind:'text',text}));
        }
        db.exec('COMMIT');
      }
    }
    search.backfillMessageSearchIndex(db);
    const n = Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n);
    const raw = { base: 'b4dc27ea9', n, openMs, textBytes: Number(db.prepare("SELECT SUM(octet_length(text)) AS n FROM messages WHERE kind='text'").get()!.n), shadowBytes: shadowBytes(db),
      sourceHash: source ? JSON.stringify(before) : null,
      parity: source ? completeParity(db, needles(db), db, search.trigramQuery, searchMessagesWithMeta) : undefined };
    const file = join(process.env.MURAGE_QUAL_EVIDENCE ?? 'evidence/r4', source ? 'q3-base.json' : 'q1-legacy.json');
    mkdirSync(resolve(file,'..'),{recursive:true}); writeFileSync(file,JSON.stringify({schema:1,raw,pass:{legacy:true}},null,2)+'\n',{mode:0o600});
    expect(JSON.parse(readFileSync(file,'utf8')).raw.shadowBytes).toBeGreaterThan(0);
  } finally {
    closeDatabase(); await stopWalMaintenance();
    if (source) expect(manifest(source), 'original copy unchanged at base').toEqual(before);
  }
});
