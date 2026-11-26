import { evidencePath } from '../evidence-path.mjs';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { searchMessagesWithMeta } from '../../server/message-db.ts';
import { closeDatabase } from '../../server/database.ts';
import { stopWalMaintenance } from '../../server/wal-maintenance.ts';
import { clone, digest, manifest, needles, completeParity } from './copy-tools.ts';
import { DATA_DIR, Report, beginRebuild, failBar, boundSample, capture, database, deleteThread, healthy, hooks, integrity,
  observer, pause, residue, sameBound, search, seed, send, smoke, state, stats, stop, until } from './support.ts';
import { runPrivateCases } from './private-cases.ts';

const leg = process.env.MURAGE_QUAL;
afterEach(stop);
it.runIf(leg === 'q3-copy')('Q3 fresh copy gate, read-only original', { tags: ['qual'] }, async () => {
  const report = new Report('q3-copy');
  const source = process.env.MURAGE_QUAL_COPY_SOURCE;
  // An explicit RC copy path is mandatory at full size. Smoke always constructs
  // its own original under the fixture root, ignoring external data paths.
  expect(smoke || !!source, 'RC copy source required').toBe(true);
  const original = smoke ? join(process.env.MURAGE_QUAL_FIXTURE_ROOT!, 'synthetic-original') : source!;
  if (smoke) {
    const db = database(); seed(db, 64);
    db.prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots','forgotten') WHERE rowid%7=0").run();
    await search.stopSearchIndex(); closeDatabase(); await stopWalMaintenance();
    clone(DATA_DIR, original);
  }
  const before = manifest(original), sourceHash = digest(JSON.stringify(before));
  report.raw.sourceHash = sourceHash; report.raw.sourceFiles = Object.keys(before).length;
  const trace = capture();
  try {
    // DATA_DIR is always the harness-owned fresh directory, never the source.
    clone(original, DATA_DIR);
    const at = performance.now(), db = database(), openMs = performance.now() - at;
    await search.stopSearchIndex();
    const samples = needles(db), n = Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n);
    const originalMax = Number(db.prepare('SELECT MAX(rowid) AS n FROM messages').get()!.n);
    let baseline: { raw: { openMs: number; sourceHash: string; parity: unknown } };
    if (smoke) {
      // A separate legacy FTS shadow supplies actual MATCH+LIKE candidates on
      // synthetic rows. It is never substituted for the base in a full run.
      const reference = observer(join(process.env.MURAGE_QUAL_FIXTURE_ROOT!, 'reference.db'));
      try {
        reference.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(t,tokenize='trigram',content='',contentless_delete=1,detail=none)");
        for (const row of db.prepare("SELECT rowid,text FROM messages WHERE kind='text'").iterate()) reference.prepare('INSERT INTO messages_fts(rowid,t) VALUES(?,?)').run(row.rowid,row.text);
        const pairs = completeParity(db,samples,reference,search.trigramQuery,searchMessagesWithMeta);
        baseline = {raw:{openMs,sourceHash:JSON.stringify(before),parity:pairs}};
      } finally { reference.close(); }
    } else {
      expect(process.env.MURAGE_QUAL_COPY_REFERENCE, 'base-copy report required').toBeTruthy();
      baseline = JSON.parse(readFileSync(process.env.MURAGE_QUAL_COPY_REFERENCE!, 'utf8'));
    }
    const buildAt = performance.now(); const rebuildStart = await beginRebuild(db);
    report.raw.rebuildStart = rebuildStart;
    report.bar('rebuild', rebuildStart.builtCursor !== undefined && rebuildStart.indexedRows === 0);
    const firstSendMs=send(49_999); hooks.halted = false;
    const duringBuild: number[] = [firstSendMs];
    while (!healthy(db) && performance.now() - buildAt < 30 * 60_000) { duringBuild.push(send(50_000 + duringBuild.length)); await pause(smoke ? 20 : 500); }
    await until(() => healthy(db), 'Q3-build');
    const rebuildMs = performance.now() - buildAt;
    // Parity must be checked before adding test sends: restrict the returned
    // sets to the original rows (rowids above the original maximum are sends).
    const index = observer();
    let actual: ReturnType<typeof completeParity>;
    try {
      if (failBar === 'parity') index.prepare('DELETE FROM messages_fts WHERE rowid<=?').run(originalMax);
      actual = completeParity(db,samples,index,search.trigramQuery,searchMessagesWithMeta,originalMax);
    } finally { index.close(); }
    report.bar('open', openMs <= baseline.raw.openMs + 20 && baseline.raw.sourceHash === JSON.stringify(before));
    report.bar('rebuild-owner', duringBuild.length > 0 && duringBuild.every(ms => ms <= 20));
    report.bar('parity', actual.length === 50 && JSON.stringify(actual) === JSON.stringify(baseline.raw.parity));
    for (let i=0;i<20;i++)send(60_000+i);
    const bound=boundSample(trace,70_000);
    const referenceBound = process.env.MURAGE_QUAL_1K_BOUND ? JSON.parse(readFileSync(process.env.MURAGE_QUAL_1K_BOUND,'utf8')) : smoke ? bound : [];
    report.bar('turn-bound', sameBound(bound,referenceBound));
    const commits = Array.from({length:100},(_,i)=>send(80_000+i));
    report.bar('owner-p99', stats(commits).p99! < 20);
    const row = db.prepare('SELECT thread_id,COUNT(*) AS n FROM messages GROUP BY thread_id ORDER BY n DESC LIMIT 1').get()!;
    // Unique non-ASCII trigrams added only to the disposable copy provide a
    // residue oracle without writing private words to a log or report.
    const marker='\ue191\ue192\ue193';
    db.exec('BEGIN IMMEDIATE');
    const inserted=db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,'qual-residue',1,'user','text',?,'{}')").run(row.thread_id,marker);
    search.syncMessageSearchRow(db,Number(inserted.lastInsertRowid),marker);db.exec('COMMIT');
    await until(()=>healthy(db),'Q3-marker');
    deleteThread(String(row.thread_id));
    await until(()=>{if(!healthy(db))return false;const a=observer();try{return state(a,'debt')===undefined;}finally{a.close();}},'Q3-drop',300_000);
    report.bar('drop',residue(marker)&&integrity(join(DATA_DIR,'messages.db'))&&integrity(join(DATA_DIR,'search.db')));
    const privateCases = smoke ? await runPrivateCases(undefined, DATA_DIR, sourceHash, true) : await runPrivateCases(process.env.MURAGE_QUAL_PRIVATE_CASES, DATA_DIR, sourceHash, false);
    report.raw.privateCases=privateCases;
    report.bar('private-cases',privateCases.length===4&&privateCases.every(c=>c.pass));
    report.raw = Object.assign(report.raw,{n,openMs,baseOpenMs:baseline.raw.openMs,rebuildMs,rowsPerSecond:n/(rebuildMs/1000),duringBuild:stats(duringBuild),parity:actual,bound,owner:stats(commits),droppedRows:Number(row.n)});
  } finally {
    hooks.event=null; trace.restore();
    report.bar('original-unchanged',JSON.stringify(manifest(original))===JSON.stringify(before));
    // A failing intermediate assertion still leaves a text-free source audit.
    writeFileSync(evidencePath('q3-source-audit.json', process.env.MURAGE_QUAL_EVIDENCE ?? evidencePath('evidence/r4')),JSON.stringify({before:sourceHash,after:digest(JSON.stringify(manifest(original))),unchanged:report.pass['original-unchanged']})+'\n',{mode:0o600});
  }
  report.finish();
});