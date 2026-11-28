// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN-RULING memory G/H (q1024-memsearch), through the shipped HTTP door on a started server. The field state is reproduced as in
// memsweep-owner-save-pending-1024-api.test.ts: the owner forgets a memory and the revoke walk stays in flight, so its pending window
// covers the bot's scope. The owner's next line is saved active in the owner's own turn. In the owner's next direct turn the engine
// then calls POST /api/internal/memory/search, /get and /propose-correction with the turn's own memory credential. Before the fix
// those reads used the strict view: the saved memory was not found (G) and the correction target read threw MEMORY_REPLAY_LIMIT (H).
// No command text is executed.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const resultsPath = () => join(fixture.info.dataDir, 'memsearch-1024-results.jsonl');
const results = (): Array<Record<string, any>> =>
  existsSync(resultsPath()) ? readFileSync(resultsPath(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

beforeAll(async () => {
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  // A turn whose text names "look it up" runs the reads of the plan file (the record the test names); any other turn saves the owner's
  // own line once (only "capture is still pending", the queue, is asked again).
  const replacement = `void (async () => {
    const env = turn.integrations?.memory?.env;
    if (!env) throw Error('fixture memory mount missing');
    const call = async (route, body) => {
      const response = await fetch(new URL(route, env.MURAGE_HARNESS_URL), { method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + saveSecret('MURAGE_MEMORY_TOKEN', env)}, body: JSON.stringify(body) });
      return { status: response.status, result: await response.json().catch(() => null) };
    };
    const out = savePath.join(process.env.MURAGE_DATA_DIR, 'memsearch-1024-results.jsonl');
    if (String(turn.text).includes('just answer')) {
      saveFs.appendFileSync(out, JSON.stringify({ kind: 'answer', memory: String(turn.system ?? '') + '\\n' + JSON.stringify(turn.memoryContext ?? null) + '\\n' + String(turn.text ?? '') }) + '\\n');
    } else if (String(turn.text).includes('look it up')) {
      const plan = JSON.parse(saveFs.readFileSync(savePath.join(process.env.MURAGE_DATA_DIR, 'memsearch-plan.json'), 'utf8'));
      const search = await call('/api/internal/memory/search', { query: plan.query, limit: 5 });
      const get = await call('/api/internal/memory/get', { handles: [{ id: plan.id, version: plan.version }] });
      // only "capture is still pending" (the queue, not this fix) is asked again, as for the save
      let correction;
      for (let tries = 0; tries < 120; tries++) { correction = await call('/api/internal/memory/propose-correction', { id: plan.id, version: plan.version, replacement: plan.correction, evidence: [{ quote: plan.quote }], idempotencyKey: 'memsearch-1024-fix-' + turnId.replace(/[^A-Za-z0-9_-]/g,'') }); if (correction.status !== 409) break; await new Promise(resolve => setTimeout(resolve, 250)); }
      saveFs.appendFileSync(out, JSON.stringify({ kind: 'reads', search, get, correction }) + '\\n');
    } else {
      const words = String(turn.text).includes('amber kettles') ? 'The fixture keeps amber kettles.' : String(turn.text).includes('green ledgers') ? 'The fixture keeps green ledgers.' : 'The fixture keeps red binders.';
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
    // the revoke walk in flight: while the park file exists no runner, drain or marker slice advances it (the field's deferred walk)
    globalThis.__memsearchPark = () => fs.existsSync(path.join(process.env.MURAGE_DATA_DIR, 'memsearch-park'));
    // J: while the starve file exists a turn's recall search has no time at all (the hydration limit the field log names), so it is cut
    globalThis.__memsearchStarve = () => fs.existsSync(path.join(process.env.MURAGE_DATA_DIR, 'memsearch-starve'));
    const starve = 'const hydrationLimitMs=caller==="tool"?TOOL_HYDRATION_LIMIT_MS:HYDRATION_LIMIT_MS;';
    const patch = (url, pairs) => { let source = fs.readFileSync(new URL(url),'utf8'); for (const [anchor, add] of pairs) { if (source.split(anchor).length !== 2) throw Error('revoke park fixture anchor changed: ' + anchor.slice(0, 60)); source = source.replace(anchor, anchor + add); } return {format:'module-typescript',shortCircuit:true,source}; };
    registerHooks({load(url, context, next) {
      if (url.endsWith('/memory/search.ts')) { const source = fs.readFileSync(new URL(url),'utf8'); if (source.split(starve).length !== 2) throw Error('starve fixture anchor changed'); return {format:'module-typescript',shortCircuit:true,source:source.replace(starve,'const hydrationLimitMs=globalThis.__memsearchStarve()&&caller!=="tool"?0:caller==="tool"?TOOL_HYDRATION_LIMIT_MS:HYDRATION_LIMIT_MS;')}; }
      if (url.endsWith('/memory/revoke-marker.ts')) return patch(url, [['function detailedSlice(db: DatabaseSync, rows: number, ms: number, late: LateBuild | null, maxChanges: number, opts: MarkerSliceOptions, prune: boolean): MarkerSliceOutcome {', " if(globalThis.__memsearchPark())return {outcome:'idle'};"]]);
      if (url.endsWith('/memory/memory-revocation.ts')) return patch(url, [
        ['export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions, resume = next !== undefined): void {', ' if(globalThis.__memsearchPark())return;'],
        ['export function drainRevokeMarkerBounded(db: DatabaseSync, budget: { rows: number; ms: number } = SEND_FENCE_DRAIN, options: { background?: boolean } = {}): boolean {', ' if(globalThis.__memsearchPark())return false;'],
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
    cfg.instances.memsearch = {driver:'fakeLateTerminal',environment:{FAKE_LATE_MEMORY_MCP:'1'}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 120000);

afterAll(async () => { await fixture?.close(); });

it('W-SETTLED-READ in the owner\'s own turn a memory saved active is found by memory_search and memory_get and is a correction target while a revoke walk is in flight', async () => {
  const created = await api('POST', '/api/bots', { name: 'Memsearch fixture', modelSelection: { instanceId: 'memsearch', model: 'late-1' } });
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
  // setup: one memory saved with no revoke anywhere, then forgotten by the owner with the walk left in flight
  const first = await say('The fixture keeps red binders.');
  expect(first, 'setup: the first save').toMatchObject({ kind: 'save', status: 200, result: { state: 'active' } });
  // setup: the owner's next line is saved active in the owner's own turn, before the forget, so this setup needs no other fix (the
  // save made while a walk is in flight is MEMSWEEP-1024 E, witnessed in memsweep-owner-save-pending-1024-api); what follows reads it
  // while the forget's walk is in flight and its pending window covers the bot's scope
  const second = await say('The fixture keeps green ledgers.');
  expect(second, 'setup: the second save').toMatchObject({ kind: 'save', status: 200, result: { state: 'active', pendingReview: false } });
  writeFileSync(join(fixture.info.dataDir, 'memsearch-park'), '');
  expect((await api('POST', '/api/memory/action', { action: 'forget', kind: 'record', id: first.result.candidateId })).status, 'setup: the owner forgets the first memory').toBe(200);
  const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    expect(Number((db.prepare('SELECT count(*) AS n FROM memory_deny_pending_scope').get() as { n: number }).n), 'setup: the forget left a pending window (the walk is in flight)').toBeGreaterThan(0);
  } finally { db.close(); }
  const id = second.result.candidateId as string;
  writeFileSync(join(fixture.info.dataDir, 'memsearch-plan.json'), JSON.stringify({ query: 'green ledgers', id, version: 1, correction: 'The fixture keeps blue ledgers now.', quote: 'It keeps blue ledgers now.' }));
  // the owner's next direct turn looks it up, with the walk still in flight
  const reads = await say('Please look it up: what does the fixture keep? It keeps blue ledgers now.');
  expect(reads.kind, 'setup: the reads ran').toBe('reads');
  expect(existsSync(join(fixture.info.dataDir, 'memsearch-park')), 'the walk is still parked').toBe(true);
  // G: memory_search finds it
  expect({ status: reads.search.status, found: (reads.search.result?.hits ?? []).some((hit: any) => hit.id === id) }, 'memory_search in the owner\'s own turn').toEqual({ status: 200, found: true });
  // G: memory_get reads it
  expect({ status: reads.get.status, ids: (reads.get.result?.records ?? []).map((record: any) => record.id) }, 'memory_get in the owner\'s own turn').toEqual({ status: 200, ids: [id] });
  // H: it is a correction target (no MEMORY_REPLAY_LIMIT on the target read)
  expect({ status: reads.correction.status, error: reads.correction.result?.error }, 'memory_propose_correction in the owner\'s own turn').toEqual({ status: 200, error: undefined });
  // the forgotten memory stays forgotten for the owner too: memory_search never answers it
  expect((reads.search.result?.hits ?? []).filter((hit: any) => hit.id === first.result.candidateId || String(hit.text).includes('red binders')), 'the forgotten memory among the hits').toEqual([]);
}, 240000);

it('W-RECALL-LOG the dispatch log says recall=full only when the turn\'s recall answered in full; a recall cut by its limit is logged empty or partial with its reason', async () => {
  const bot = (await api('GET', '/api/bots')).body.bots.find((entry: any) => entry.name === 'Memsearch fixture');
  expect(bot, 'setup: the bot of the first row').toBeTruthy();
  rmSync(join(fixture.info.dataDir, 'memsearch-park'), { force: true });
  const dispatched = async (text: string) => {
    const before = results().length, logFrom = readFileSync(fixture.info.logPath, 'utf8').length;
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
    await expect.poll(() => results().length, { timeout: 60000 }).toBe(before + 1);
    await expect.poll(async () => (await api('GET', '/api/bots')).body.bots.find((entry: any) => entry.id === bot.id)?.busy === true, { timeout: 30000 }).toBe(false);
    return readFileSync(fixture.info.logPath, 'utf8').slice(logFrom).split('\n').flatMap(line => line.match(/turn dispatch recall=(.*?) thread=/)?.[1] ?? []);
  };
  // control: with time to search, no recall limit is named (the line says full, or names what else was missing: this container has no
  // local embedding model, so it names local-model-unavailable, which is what happened)
  expect(await dispatched('Please just answer: what about the green ledgers?'), 'a turn whose recall had its time').toEqual([expect.not.stringContaining('MEMORY_RECALL_')]);
  // the field case: the turn's recall is cut by its limit and answers nothing; the line must not say full
  writeFileSync(join(fixture.info.dataDir, 'memsearch-starve'), '');
  try {
    const lines = await dispatched('Please just answer again: what about the green ledgers?');
    expect(lines, 'a turn whose recall was cut by its limit').toEqual([expect.stringMatching(/^(empty|partial) reason=MEMORY_RECALL_[A-Z_]+$/)]);
  } finally { rmSync(join(fixture.info.dataDir, 'memsearch-starve'), { force: true }); }
}, 180000);

it('W-RECALL-LOG-ROOM a room turn\'s dispatch log says recall=full only when its recall answered in full; a cut recall is logged empty or partial with its reason', async () => {
  const created = await api('POST', '/api/bots', { name: 'Memsearch room fixture', modelSelection: { instanceId: 'memsearch', model: 'late-1' } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true, autoReview: 'off', computer: 'off', browser: false, composio: false })).status).toBe(200);
  const room = (await api('POST', '/api/groups', { name: 'Memsearch room', memberIds: [bot.id], setup: { bulletin: '', defaultResponder: { kind: 'member', botId: bot.id } } })).body.group as { id: string; threadId: string };
  expect(room?.threadId, 'setup: the room with the bot').toBeTruthy();
  rmSync(join(fixture.info.dataDir, 'memsearch-park'), { force: true });
  const dispatched = async (text: string) => {
    const before = results().length, logFrom = readFileSync(fixture.info.logPath, 'utf8').length;
    expect((await api('POST', `/api/groups/${room.id}/messages`, { text })).status).toBe(202);
    await expect.poll(() => results().length, { timeout: 60000 }).toBe(before + 1);
    await expect.poll(async () => { const state = (await api('GET', '/api/bots?messages=0')).body.groups.find((group: any) => group.id === room.id); return Boolean(state?.working || state?.busyBotId); }, { timeout: 30000 }).toBe(false);
    return readFileSync(fixture.info.logPath, 'utf8').slice(logFrom).split('\n').flatMap(line => line.match(new RegExp(`turn dispatch recall=(.*?) thread=${room.threadId}`))?.[1] ?? []);
  };
  // control: a room turn whose recall had its time names no recall limit
  expect(await dispatched('Please just answer in the room: what about the green ledgers?'), 'a room turn whose recall had its time').toEqual([expect.not.stringContaining('MEMORY_RECALL_')]);
  writeFileSync(join(fixture.info.dataDir, 'memsearch-starve'), '');
  try {
    const lines = await dispatched('Please just answer in the room again: what about the green ledgers?');
    expect(lines, 'a room turn whose recall was cut by its limit').toEqual([expect.stringMatching(/^(empty|partial) reason=MEMORY_RECALL_[A-Z_]+$/)]);
  } finally { rmSync(join(fixture.info.dataDir, 'memsearch-starve'), { force: true }); }
}, 180000);
