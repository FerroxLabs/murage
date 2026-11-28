// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1024-memsearch, MAIN-RULING memint-3 (4): full search answers over the whole store within the turn deadline. The word index answers for every
// indexed record; what it has not indexed yet (the owner's fresh save, the capture backlog: pending projections) was read only by the newest-first
// recent window, which stops at RECENT_VISIT_ROWS rows and so never finishes on a large store: every search then answered partial, keyword,
// missed (the real-data gate's 109k-record copy, recall 0/3). Through the real bot tool route on a started server: a store of 2,100 older indexed
// records plus a pending backlog of 3, and a fresh owner save. Owners: this witness and server/memory/search.ts + recent.ts = q1024-memsearch.
// No command text is executed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';

let fixture: VerificationServer;
let headers: Record<string, string>;
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
const resultsPath = () => join(fixture.info.dataDir, 'memsearch-1024-results.jsonl');
const results = (): Array<Record<string, any>> =>
  existsSync(resultsPath()) ? readFileSync(resultsPath(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

beforeAll(async () => {
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  // A turn whose own line says "find it" runs the bot's memory_search for the plan file's query; any other turn saves the owner's own line
  // once (only "capture is still pending", the queue, is asked again).
  const replacement = `void (async () => {
    const env = turn.integrations?.memory?.env;
    if (!env) throw Error('fixture memory mount missing');
    const call = async (route, body) => {
      const response = await fetch(new URL(route, env.MURAGE_HARNESS_URL), { method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + saveSecret('MURAGE_MEMORY_TOKEN', env)}, body: JSON.stringify(body) });
      return { status: response.status, result: await response.json().catch(() => null) };
    };
    const out = savePath.join(process.env.MURAGE_DATA_DIR, 'memsearch-1024-results.jsonl');
    // the turn's text carries the thread so far: the LAST marker in it is this turn's own line
    const said = String(turn.text), at = marker => said.lastIndexOf(marker);
    if (at('find it') > Math.max(at('violet harbors'), at('amber kettles'))) {
      const plan = JSON.parse(saveFs.readFileSync(savePath.join(process.env.MURAGE_DATA_DIR, 'memsearch-plan.json'), 'utf8'));
      const search = await call('/api/internal/memory/search', { query: plan.query, limit: 10 });
      saveFs.appendFileSync(out, JSON.stringify({ kind: 'find', search }) + '\\n');
    } else {
      const words = at('violet harbors') > at('amber kettles') ? 'The fixture keeps violet harbors.' : 'The fixture keeps amber kettles.';
      let saved, tries = 0;
      for (;;) {
        tries++;
        saved = await call('/api/internal/memory/save', {text:words, evidence:[{quote:words}], idempotencyKey:'memsearch-1024-' + turnId.replace(/[^A-Za-z0-9_-]/g,'')});
        if (saved.status !== 409 || tries >= 120) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      saveFs.appendFileSync(out, JSON.stringify({ kind: 'save', text: words, tries, ...saved }) + '\\n');
    }
    emit({type:'item.completed',itemType:'assistant_text',origin:'engine',text:'done',threadId:turn.threadId,turnId});
    active.delete(turn.threadId);
    emit({type:'turn.completed',ok:true,threadId:turn.threadId,turnId});
  })().catch(error => { saveFs.appendFileSync(savePath.join(process.env.MURAGE_DATA_DIR, 'memsearch-1024-results.jsonl'),JSON.stringify({kind:'error',status:-1,result:{error:String(error)}}) + '\\n'); }); return;`;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    const {registerHooks} = await import('node:module');
    // (4): while the seed file exists, the next search (whatever caller) first clones the newest active record of the store into an archive of
    // 2,100 OLDER records whose words are already in the word index (receipt indexed) and a backlog of 3 records whose words are not yet (receipt
    // pending, as capture leaves them), all in the reader's view, once. Rows are copied from the real record (its evidence, details, receipt, view
    // row; a row a trigger already wrote for the copy is replaced), only the id, the text, the receipt status and the view order differ.
    // the capture backlog the field had: while the noindex file exists the word index takes no batch (projection.ts pendingProjectionRecords, and the
    // owner-save record read where a build has one), so pending projections stay pending; each search notes how many saved violet facts are pending
    globalThis.__memsearchNoIndex = () => fs.existsSync(path.join(process.env.MURAGE_DATA_DIR, 'memsearch-noindex'));
    globalThis.__memsearchPending = (db) => fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'memsearch-pending.json'), JSON.stringify({ backlogTerms: globalThis.__memsearchTerms?.() ?? 0, pending: Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts p JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version WHERE p.lexical_status='pending' AND r.kind='fact' AND r.text LIKE '%violet harbors%'").get().n) }));
    globalThis.__memsearchSeed = (db) => {
      const flag = path.join(process.env.MURAGE_DATA_DIR, 'memsearch-seed');
      if (!fs.existsSync(flag)) return;
      // the newest active fact already in a recall view (a save reaches the view a moment after it commits): until there is one, a later search seeds
      const from = db.prepare("SELECT r.id, r.version FROM memory_records r WHERE r.state='active' AND r.kind='fact' AND EXISTS (SELECT 1 FROM memory_recall_view_records v WHERE v.record_id=r.id AND v.version=r.version) ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1").get();
      if (!from) return;
      // 'heap': a backlog too large for one search to read to its end (9,000 pending copies, more than a search's whole work allowance)
      const heap = fs.readFileSync(flag, 'utf8') === 'heap';
      fs.rmSync(flag);
      try {
      const low = Number(db.prepare("SELECT min(sequence) AS s FROM memory_recall_view_records").get().s);
      const tables = [['memory_records','id','version'],['memory_evidence','record_id','record_version'],['memory_record_details','record_id','record_version'],['memory_projection_receipts','record_id','record_version'],['memory_recall_view_records','record_id','version']];
      const copies = tables.map(([table, idCol, versionCol]) => {
        const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(col => col.name);
        const pick = cols.map(col => col === idCol ? '?1' : table === 'memory_records' && col === 'text' ? '?2' : table === 'memory_projection_receipts' && col === 'lexical_status' ? '?3' : table === 'memory_recall_view_records' && col === 'sequence' ? '?4' : col);
        return db.prepare('INSERT ' + (table === 'memory_records' ? '' : 'OR REPLACE ') + 'INTO ' + table + ' (' + cols.join(',') + ') SELECT ' + pick.join(',') + ' FROM ' + table + ' WHERE ' + idCol + '=?5 AND ' + versionCol + '=?6');
      });
      const backlog = [];
      db.exec('BEGIN');
      for (let n = 0; n < (heap ? 9000 : 2103); n++) {
        const pending = heap || n >= 2100, id = (heap ? 'memsearch-heap-' : pending ? 'memsearch-backlog-' : 'memsearch-archive-') + String(n).padStart(5, '0');
        const text = heap ? 'Heap entry ' + n + ' of the store.' : pending ? 'Backlog note ' + n + ': violet harbors were logged.' : 'Archive entry ' + n + ' of the store.';
        for (const copy of copies) copy.run(id, text, pending ? 'pending' : 'indexed', low - 2200 + n, from.id, from.version);
        if (pending && !heap) backlog.push(id);
      }
      // the copies are in the reader's view (their view rows) but, like the field's backlog, not yet in the view's word list: the change rows their
      // inserts queued for the view's own reprojection are dropped, so no term row is ever written for them
      db.prepare("DELETE FROM memory_recall_changes WHERE kind='record' AND object_id LIKE 'memsearch-%'").run();
      db.exec('COMMIT');
      fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, heap ? 'memsearch-heaped.json' : 'memsearch-seeded.json'), JSON.stringify({ backlog, view: Number(db.prepare("SELECT max(n) AS n FROM (SELECT count(*) AS n FROM memory_recall_view_records GROUP BY view_id, generation)").get().n), terms: Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_terms WHERE record_id LIKE 'memsearch-backlog-%'").get().n) }));
      globalThis.__memsearchTerms = () => Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_terms WHERE record_id LIKE 'memsearch-backlog-%'").get().n);
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'memsearch-seeded.json'), JSON.stringify({ error: String(error?.stack ?? error) })); }
    };
    registerHooks({load(url, context, next) {
      if (url.endsWith('/memory/search.ts')) { const source = fs.readFileSync(new URL(url),'utf8'); const start = '  const options=withReaderRule(access,given);';
        if (source.split(start).length !== 2) throw Error('seed fixture anchor changed');
        return {format:'module-typescript',shortCircuit:true,source:source.replace(start,start+' globalThis.__memsearchSeed?.(database()); globalThis.__memsearchPending?.(database());')}; }
      if (url.endsWith('/memory/projection.ts')) { let source = fs.readFileSync(new URL(url),'utf8');
        for (const anchor of ['export function pendingProjectionRecords(db:DatabaseSync,limit=16,deletionsOnly=false) {', 'export function pendingProjectionRecord(db:DatabaseSync,id:string,version:number) {']) {
          const n = source.split(anchor).length - 1;
          if (n > 1 || (n === 0 && anchor.includes('Records('))) throw Error('noindex fixture anchor changed');
          source = source.replace(anchor, anchor + ' if(globalThis.__memsearchNoIndex?.())return [];');
        }
        return {format:'module-typescript',shortCircuit:true,source}; }
      if (!url.endsWith('/fake-late-terminal-driver.ts')) return next(url,context);
      let source = "import * as saveFs from 'node:fs'; import * as savePath from 'node:path'; import {turnSecret as saveSecret} from '../turn-credential.ts';\\n" + fs.readFileSync(new URL(url),'utf8');
      if (!source.includes(${JSON.stringify(anchor)})) throw Error('fake engine fixture anchor changed');
      return {format:'module-typescript',shortCircuit:true,source:source.replaceAll(${JSON.stringify(anchor)},${JSON.stringify(replacement)})};
    }});
    const {BUILT_IN_DRIVERS} = await import(${JSON.stringify(new URL('./drivers/builtIn.ts', import.meta.url).href)});
    const {makeLateTerminalDriver} = await import(${JSON.stringify(new URL('./testing/fake-late-terminal-driver.ts', import.meta.url).href)});
    BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
    const file = path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.memsearch = {driver:'fakeLateTerminal',environment:{FAKE_LATE_MEMORY_MCP:'1'}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 120000);

afterAll(async () => { await fixture?.close(); });

it('W-WHOLE-STORE a fresh owner save and the pending backlog are found by a FULL search over a store larger than the recent window (MAIN-RULING memint-3 (4))', async () => {
  const created = await api('POST', '/api/bots', { name: 'Memsearch store fixture', modelSelection: { instanceId: 'memsearch', model: 'late-1' } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true, autoReview: 'off', computer: 'off', browser: false, composio: false })).status).toBe(200);
  const say = async (text: string) => {
    const before = results().length;
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
    await expect.poll(() => results().length, { timeout: 60000 }).toBe(before + 1);
    await expect.poll(async () => (await api('GET', '/api/bots')).body.bots.find((entry: any) => entry.id === bot.id)?.busy === true, { timeout: 30000 }).toBe(false);
    return results()[before]!;
  };
  const first = await say('The fixture keeps amber kettles.');
  expect(first, 'setup: the first save').toMatchObject({ kind: 'save', status: 200, result: { state: 'active' } });
  // the next searches (a turn's own recall, the bot's search) seed the archive and the backlog from the first record once it is in the view
  writeFileSync(join(fixture.info.dataDir, 'memsearch-plan.json'), JSON.stringify({ query: 'violet harbors' }));
  writeFileSync(join(fixture.info.dataDir, 'memsearch-noindex'), '1');
  writeFileSync(join(fixture.info.dataDir, 'memsearch-seed'), '1');
  const seededPath = join(fixture.info.dataDir, 'memsearch-seeded.json');
  for (let tries = 0; tries < 20 && !existsSync(seededPath); tries++) await say('Please find it: what does the fixture keep?');
  expect(existsSync(seededPath), 'setup: the seed ran').toBe(true);
  expect(JSON.parse(readFileSync(seededPath, 'utf8')).error, 'setup: the seed').toBeUndefined();
  const fresh = await say('The fixture keeps violet harbors.');
  expect(fresh, 'setup: the fresh save').toMatchObject({ kind: 'save', status: 200, result: { state: 'active' } });
  const seeded = JSON.parse(readFileSync(join(fixture.info.dataDir, 'memsearch-seeded.json'), 'utf8')) as { backlog: string[]; view: number; terms: number };
  expect({ backlog: seeded.backlog.length, largerThanWindow: seeded.view > 2048, backlogTerms: seeded.terms }, 'setup: the store holds more rows than the recent window and a backlog of 3 outside the word list').toEqual({ backlog: 3, largerThanWindow: true, backlogTerms: 0 });
  // The bot asks until a search answers in full, as the real-data gate does (the helper may still be starting: a search it did not answer is
  // words only and partial by design). Each answer is paired with the server's own recall line for it (search.ts noteRecallDegraded).
  const recallLines = () => readFileSync(fixture.info.logPath, 'utf8').split('\n').filter(line => /recall caller=tool /.test(line));
  let found: Record<string, any> = {}, cause: string | null = null;
  for (const started = Date.now(); Date.now() - started < 150000;) {
    const before = recallLines().length;
    found = await say('Please find it: what does the fixture keep?');
    const line = recallLines().slice(before).at(-1);
    cause = line ? /cause=(\S+)/.exec(line)?.[1] ?? null : null;
    const result = found.search?.result ?? {};
    if (found.search?.status === 200 && !result.partial && !result.recallMode && !result.missed) break;
    // words only while the helper starts (SEMANTIC_CUTOFF, a helper error code, an empty index): ask again
    if (cause === 'MEMORY_RECALL_SCAN_LIMIT') break;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  // the condition this row is about: at the last search the fresh save and the backlog were still waiting for the word index
  expect(JSON.parse(readFileSync(join(fixture.info.dataDir, 'memsearch-pending.json'), 'utf8')), 'setup: the fresh save and the backlog of 3 are pending at the search, the backlog still outside the word list').toEqual({ backlogTerms: 0, pending: 4 });
  const result = found.search?.result ?? {};
  const hits = (result.hits ?? []).map((hit: any) => hit.id);
  expect({ status: found.search?.status, fresh: hits.includes(fresh.result.candidateId), backlog: seeded.backlog.filter(id => hits.includes(id)).length },
    'the answer holds the fresh save and the pending backlog').toEqual({ status: 200, fresh: true, backlog: 3 });
  // the helper answered this search (no helper-start cut): a partial answer now can only be the scan limit this row guards
  // (its own degraded reason, e.g. local-model-unavailable in this fixture, is an answer; a helper error or cutoff code is not)
  expect(cause === null || cause === 'MEMORY_RECALL_SCAN_LIMIT' || cause === 'local-model-unavailable', `setup: the helper answered the last search (server recall cause ${cause})`).toBe(true);
  // FULL search (the real-data gate's bar, _small/memgate.sh rig): no partial, no keyword recallMode, nothing missed
  expect({ partial: result.partial ?? false, recallMode: result.recallMode ?? null, missed: result.missed ?? false, scanLimit: cause === 'MEMORY_RECALL_SCAN_LIMIT' },
    'a full answer over the whole store').toEqual({ partial: false, recallMode: null, missed: false, scanLimit: false });
  // Row 2, honesty: a pending backlog too large to read to its end within one search is never answered as full (the walk did not finish, so a
  // readable unindexed match may be unread); a walk that claimed the end without reading it would answer full here.
  writeFileSync(join(fixture.info.dataDir, 'memsearch-seed'), 'heap');
  const heapedPath = join(fixture.info.dataDir, 'memsearch-heaped.json');
  for (let tries = 0; tries < 5 && !existsSync(heapedPath); tries++) await say('Please find it: what does the fixture keep?');
  expect(JSON.parse(readFileSync(heapedPath, 'utf8')).error, 'setup: the heap seed').toBeUndefined();
  const heaped = await say('Please find it: what does the fixture keep?');
  expect({ status: heaped.search?.status, partial: heaped.search?.result?.partial ?? false, missed: heaped.search?.result?.missed ?? false },
    'a backlog too large to read is answered partial, a match possibly missed').toEqual({ status: 200, partial: true, missed: true });
}, 400000);
