// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMSWEEP-1024 (ASTRA-MEMAUDIT 30), through the shipped HTTP doors on a started server: the bot saves a memory in the owner's turn, the
// owner edits and pins it, and the bot corrects it in the owner's typed turn (POST /api/internal/memory/propose-correction: a pinned
// target is not replaced by the route itself but by the approval of the registered memory request, authority.ts approveCorrection).
// The fact the correction replaced is handed back to the index as replaced.
// The engine script and the (unused) revoke park hooks are the ones of memsweep-owner-read-pending-1024-api.test.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
const resultsPath = () => join(fixture.info.dataDir, 'memsweep-1024-target.jsonl');
const results = (): Array<{ turn: string; op: string; status: number; hit?: boolean; result: any }> =>
  existsSync(resultsPath()) ? readFileSync(resultsPath(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

beforeAll(async () => {
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  // the engine's script, chosen by the words of the turn; only "capture is still pending" (409: the queue, not this fix) is asked again
  const replacement = `void (async () => {
    const env = turn.integrations?.memory?.env;
    const file = savePath.join(process.env.MURAGE_DATA_DIR, 'memsweep-1024-target.jsonl');
    const said = String(turn.text);
    // newest line first: the turn's text carries the conversation's earlier lines around the new one
    const name = said.includes('blue folders') ? 'blue' : said.includes('grey ledgers') ? 'grey' : said.includes('remember about') ? 'find' : said.includes('green ledgers') ? 'green' : said.includes('red binders') ? 'red' : 'other';
    const log = row => saveFs.appendFileSync(file, JSON.stringify({turn:name, ...row}) + '\\n');
    const rows = () => saveFs.existsSync(file) ? saveFs.readFileSync(file,'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    try {
      if (!env) throw Error('fixture memory mount missing');
      const call = async (path, body) => {
        for (let tries = 1;; tries++) {
          const response = await fetch(new URL('/api/internal/memory/' + path, env.MURAGE_HARNESS_URL), {
            method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + saveSecret('MURAGE_MEMORY_TOKEN', env)}, body: JSON.stringify(body)});
          const result = await response.json().catch(() => null);
          if (response.status !== 409 || tries >= 280) return {status: response.status, result};
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      };
      const key = op => 'memsweep-1024-' + op + '-' + turnId.replace(/[^A-Za-z0-9_-]/g,'');
      const save = async words => { const out = await call('save', {text:words, evidence:[{quote:words}], idempotencyKey:key('save')}); log({op:'save', ...out}); return out; };
      // the bot looks for a memory by its words: asked again for a few seconds (the index is filled by the worker), then the answer stands
      const find = async (query, id, rounds) => {
        let out, hit = false;
        for (let n = 0; n < rounds && !hit; n++) {
          if (n) await new Promise(resolve => setTimeout(resolve, 250));
          out = await call('search', {query});
          hit = out.status === 200 && Array.isArray(out.result?.hits) && out.result.hits.some(row => row.id === id);
        }
        log({op:'search', status:out.status, hit, result:{hits:out.result?.hits?.length ?? null, degradedReason:out.result?.degradedReason ?? null, error:out.result?.error ?? null}});
      };
      const read = async id => { const out = await call('get', {handles:[{id, version:1}]}); log({op:'get', status:out.status, hit:out.status === 200 && out.result?.records?.[0]?.id === id, result:{text:out.result?.records?.[0]?.text ?? null, error:out.result?.error ?? null}}); };
      const green = () => rows().find(row => row.turn === 'green' && row.op === 'save')?.result?.candidateId;
      if (name === 'red') await save('The fixture keeps red binders.');
      if (name === 'green') await save('The fixture keeps green ledgers.');
      if (name === 'find') { await find('green ledgers', green(), 80); await read(green()); }
      if (name === 'grey') { const words = 'The fixture keeps grey ledgers.'; const out = await call('propose-correction', {id:green(), version:2, replacement:words, evidence:[{quote:words}], idempotencyKey:key('fix')}); log({op:'correct', ...out}); }
      if (name === 'blue') { await save('The fixture keeps blue folders.'); await find('green ledgers', green(), 40); await read(green()); }
    } catch (error) { log({op:'error', status:-1, result:{error:String(error)}}); }
    log({op:'done', status:0, result:null});
    emit({type:'item.completed',itemType:'assistant_text',origin:'engine',text:'memory script done',threadId:turn.threadId,turnId});
    active.delete(turn.threadId);
    emit({type:'turn.completed',ok:true,threadId:turn.threadId,turnId});
  })(); return;`;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    const {registerHooks} = await import('node:module');
    // the revoke walk in flight: while the park file exists no runner, drain or marker slice advances it (the field's deferred walk)
    globalThis.__memsweepPark = () => fs.existsSync(path.join(process.env.MURAGE_DATA_DIR, 'memsweep-park'));
    const patch = (url, pairs) => { let source = fs.readFileSync(new URL(url),'utf8'); for (const [anchor, add] of pairs) { if (source.split(anchor).length !== 2) throw Error('revoke park fixture anchor changed: ' + anchor.slice(0, 60)); source = source.replace(anchor, anchor + add); } return {format:'module-typescript',shortCircuit:true,source}; };
    registerHooks({load(url, context, next) {
      if (url.endsWith('/memory/revoke-marker.ts')) return patch(url, [['function detailedSlice(db: DatabaseSync, rows: number, ms: number, late: LateBuild | null, maxChanges: number, opts: MarkerSliceOptions, prune: boolean): MarkerSliceOutcome {', " if(globalThis.__memsweepPark())return {outcome:'idle'};"]]);
      if (url.endsWith('/memory/memory-revocation.ts')) return patch(url, [
        ['export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions, resume = next !== undefined): void {', ' if(globalThis.__memsweepPark())return;'],
        ['export function drainRevokeMarkerBounded(db: DatabaseSync, budget: { rows: number; ms: number } = SEND_FENCE_DRAIN, options: { background?: boolean } = {}): boolean {', ' if(globalThis.__memsweepPark())return false;'],
      ]);
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
    cfg.instances.memsweep = {driver:'fakeLateTerminal',environment:{FAKE_LATE_MEMORY_MCP:'1'}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 120000);

afterAll(async () => { await fixture?.close(); });

it('W-TARGET the fact an approved correction replaced leaves the index', async () => {
  const created = await api('POST', '/api/bots', { name: 'Memsweep target fixture', modelSelection: { instanceId: 'memsweep', model: 'late-1' } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true, autoReview: 'off', computer: 'off', browser: false, composio: false })).status).toBe(200);
  const say = async (turn: string, text: string) => {
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
    try { await expect.poll(() => results().some(row => row.turn === turn && row.op === 'done'), { timeout: 90000 }).toBe(true); }
    catch (error) { throw new Error(`setup: the ${turn} turn's engine script did not finish; rows=${JSON.stringify(results())}`, { cause: error }); }
    await expect.poll(async () => (await api('GET', '/api/bots')).body.bots.find((entry: any) => entry.id === bot.id)?.busy === true, { timeout: 30000 }).toBe(false);
    return results().filter(row => row.turn === turn);
  };
  const store = <T,>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'));
    try { db.exec('PRAGMA busy_timeout=10000'); return run(db); } finally { db.close(); }
  };
  const state = (id: string, version: number) => store(db => (db.prepare('SELECT state FROM memory_records WHERE id=? AND version=?').get(id, version) as { state: string } | undefined)?.state);
  // setup (true on every sha): a saved memory the owner has edited (version 2 is in the index) and pinned, so the bot's correction waits for the owner
  const green = (await say('green', 'The fixture keeps green ledgers.')).find(row => row.op === 'save');
  expect(green, 'setup: the save').toMatchObject({ status: 200, result: { state: 'active' } });
  const greenId = green!.result.candidateId as string;
  const edited = await api('POST', '/api/memory/action', { action: 'correct', id: greenId, version: 1, text: 'The fixture keeps green ledgers on the shelf.' });
  expect(edited.status, `setup: the owner edits it: ${JSON.stringify(edited.body)}`).toBe(200);
  const pinned = await api('POST', '/api/memory/action', { action: 'pin', id: greenId, version: 2, pinned: true });
  expect(pinned.status, `setup: the owner pins it: ${JSON.stringify(pinned.body)}`).toBe(200);
  await expect.poll(() => store(db => Number((db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE record_id=? AND record_version=2 AND lexical_status IN ('pending','indexed')").get(greenId) as { n: number }).n)), { timeout: 30000 }).toBe(1);
  // the probe only records what the store is told: which receipts are handed back to the index as no longer current
  store(db => db.exec("CREATE TABLE memsweep_probe(id TEXT,version INTEGER); CREATE TRIGGER memsweep_archive_probe AFTER UPDATE OF lexical_status ON memory_projection_receipts WHEN NEW.lexical_status='pending-archive' BEGIN INSERT INTO memsweep_probe VALUES(NEW.record_id,NEW.record_version); END"));
  // the owner's typed line: the bot's correction of the pinned memory is approved under the bot's level (the registered memory request)
  const grey = (await say('grey', 'Correction: The fixture keeps grey ledgers.')).find(row => row.op === 'correct');
  expect(grey, `setup: the correction is accepted: ${JSON.stringify(grey)}`).toMatchObject({ status: 200, result: { state: 'active', record: { id: greenId, version: 2 } } });
  expect([state(greenId, 2), state(grey!.result.candidateId, 1)], 'setup: the correction replaced the fact').toEqual(['superseded', 'active']);
  expect(store(db => db.prepare('SELECT id,version FROM memsweep_probe WHERE id=?').all(greenId)), 'the replaced fact (the correction target) leaves the index').toEqual([{ id: greenId, version: 2 }]);
}, 400000);
