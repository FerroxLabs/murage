// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMSWEEP-1024 G/H (MAIN-RULING memory G/H), through the shipped HTTP door on a started server. The field state is reproduced, not mocked
// away: the owner forgets a memory and the revoke walk stays in flight, so its pending window covers the bot's scope. In the owner's own
// typed turn the engine then calls POST /api/internal/memory/{save,search,get,propose-correction} with the turn's own memory credential:
// a memory saved active is found, read and corrected. A routine run (not the owner's typed line) keeps every pending window.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const resultsPath = () => join(fixture.info.dataDir, 'memsweep-1024-read.jsonl');
const results = (): Array<{ turn: string; op: string; status: number; hit?: boolean; result: any }> =>
  existsSync(resultsPath()) ? readFileSync(resultsPath(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

beforeAll(async () => {
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  // the engine's script, chosen by the words of the turn; only "capture is still pending" (409: the queue, not this fix) is asked again
  const replacement = `void (async () => {
    const env = turn.integrations?.memory?.env;
    const file = savePath.join(process.env.MURAGE_DATA_DIR, 'memsweep-1024-read.jsonl');
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
      if (name === 'grey') { const words = 'The fixture keeps grey ledgers.'; const out = await call('propose-correction', {id:green(), version:1, replacement:words, evidence:[{quote:words}], idempotencyKey:key('fix')}); log({op:'correct', ...out}); }
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

it('W-READ in the owner\'s own typed turn the bot finds, reads and corrects a memory saved active while a revoke walk is in flight; a routine run stays strict', async () => {
  const created = await api('POST', '/api/bots', { name: 'Memsweep read fixture', modelSelection: { instanceId: 'memsweep', model: 'late-1' } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true, autoReview: 'off', computer: 'off', browser: false, composio: false })).status).toBe(200);
  const turnRows = async (turn: string) => {
    try { await expect.poll(() => results().some(row => row.turn === turn && row.op === 'done'), { timeout: 90000 }).toBe(true); }
    catch (error) { throw new Error(`setup: the ${turn} turn's engine script did not finish; rows=${JSON.stringify(results())}; log=${readFileSync(fixture.info.logPath, 'utf8').split('\n').slice(-25).join(' | ')}`, { cause: error }); }
    const rows = results().filter(row => row.turn === turn);
    return (op: string) => { const row = rows.find(entry => entry.op === op); return row ? { status: row.status, hit: row.hit, result: row.result } : rows.find(entry => entry.op === 'error') ?? null; };
  };
  const say = async (turn: string, text: string) => {
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
    const rows = await turnRows(turn);
    await expect.poll(async () => (await api('GET', '/api/bots')).body.bots.find((entry: any) => entry.id === bot.id)?.busy === true, { timeout: 30000 }).toBe(false);
    return rows;
  };
  // setup: two memories saved with no revoke anywhere (true on every sha); the bot can find the second one
  const red = await say('red', 'The fixture keeps red binders.');
  expect(red('save'), 'setup: the first save').toMatchObject({ status: 200, result: { state: 'active' } });
  const green = await say('green', 'The fixture keeps green ledgers.');
  expect(green('save'), 'setup: the second save').toMatchObject({ status: 200, result: { state: 'active' } });
  const greenId = green('save')!.result.candidateId;
  // the owner forgets the FIRST one; the walk that follows stays in flight and its pending window covers the bot's scope
  writeFileSync(join(fixture.info.dataDir, 'memsweep-park'), '');
  expect((await api('POST', '/api/memory/action', { action: 'forget', kind: 'record', id: red('save')!.result.candidateId })).status, 'setup: the owner forgets the first memory').toBe(200);
  const pendingWindows = () => {
    const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
    try { db.exec('PRAGMA busy_timeout=5000'); return Number((db.prepare('SELECT count(*) AS n FROM memory_deny_pending_scope').get() as { n: number }).n); }
    finally { db.close(); }
  };
  expect(pendingWindows(), 'setup: the forget left a pending window (the walk is in flight)').toBeGreaterThan(0);
  // the owner's next typed line: the turn's own memory tools look for and read the memory that was never forgotten
  const found = await say('find', 'What do you remember about the ledgers?');
  expect.soft(found('search'), 'G memory_search finds an active memory while a revoke walk is in flight').toMatchObject({ status: 200, hit: true });
  expect.soft(found('get'), 'G memory_get reads an active memory while a revoke walk is in flight').toMatchObject({ status: 200, hit: true, result: { text: 'The fixture keeps green ledgers.' } });
  // a routine run is not the owner's typed line: its memory tools keep every pending window (strict before and after this change;
  // it runs before the correction below, while the memory it looks for is still the active one)
  const routine = await api('POST', '/api/routines', { botId: bot.id, name: 'Memsweep routine', prompt: 'Routine fixture: The fixture keeps blue folders.', enabled: false, schedule: { type: 'interval', everyMinutes: 60, anchorAt: Date.now() } });
  expect(routine.status).toBe(201);
  expect((await api('POST', `/api/routines/${routine.body.routine.id}/run`, {})).status).toBe(201);
  const blue = await turnRows('blue');
  expect.soft(blue('save')?.status, 'a routine run\'s save while the walk is in flight is not stored').not.toBe(200);
  expect.soft(blue('search'), 'a routine run\'s memory_search keeps the pending window').toMatchObject({ hit: false });
  expect.soft(blue('get'), 'a routine run\'s memory_get keeps the pending window').toMatchObject({ hit: false });
  expect(pendingWindows(), 'the walk was still in flight for the routine run').toBeGreaterThan(0);
  // the owner's next typed line corrects it: the bot's proposal is accepted for the target it could read
  const grey = await say('grey', 'Correction: The fixture keeps grey ledgers.');
  expect.soft(grey('correct'), 'H memory_propose_correction is accepted while a revoke walk is in flight').toMatchObject({ status: 200, result: { record: { id: greenId, version: 1 } } });
  expect(pendingWindows(), 'the walk was in flight for every call above').toBeGreaterThan(0);
}, 400000);
