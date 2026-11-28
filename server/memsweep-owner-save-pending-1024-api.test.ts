// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMSWEEP-1024, through the shipped HTTP door on a started server. The field state is reproduced, not mocked away: the owner forgets a
// memory and the revoke walk stays in flight (on a real store thousands of revoke jobs stay open for hours after start-up while
// background work is deferred), so its pending window covers the bot's scope. The owner then writes a new line and the engine calls
// POST /api/internal/memory/save with the turn's own memory credential, quoting that line. No command text is executed.
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
const resultsPath = () => join(fixture.info.dataDir, 'memsweep-1024-results.jsonl');
const results = (): Array<{ text: string; status: number; tries: number; result: any }> =>
  existsSync(resultsPath()) ? readFileSync(resultsPath(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

beforeAll(async () => {
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  // the engine saves the owner's own line once; only "capture is still pending" (the queue, not this fix) is asked again
  const replacement = `void (async () => {
    const env = turn.integrations?.memory?.env;
    if (!env) throw Error('fixture memory mount missing');
    // the owner's own line of this turn, word for word (turn.text carries the turn's framing around it)
    // (the third turn cites the bot's own earlier reply instead: a line the owner did not write)
    const words = String(turn.text).includes('own earlier reply') ? 'save HTTP 200' : String(turn.text).includes('green ledgers') ? 'The fixture keeps green ledgers.' : 'The fixture keeps red binders.';
    let response, result, tries = 0;
    for (;;) {
      tries++;
      response = await fetch(new URL('/api/internal/memory/save', env.MURAGE_HARNESS_URL), {
        method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + saveSecret('MURAGE_MEMORY_TOKEN', env)},
        body: JSON.stringify({text:words, evidence:[{quote:words}], idempotencyKey:'memsweep-1024-' + turnId.replace(/[^A-Za-z0-9_-]/g,'')})
      });
      result = await response.json().catch(() => null);
      if (response.status !== 409 || tries >= 120) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    saveFs.appendFileSync(savePath.join(process.env.MURAGE_DATA_DIR, 'memsweep-1024-results.jsonl'), JSON.stringify({text:words, status:response.status, tries, result}) + '\\n');
    emit({type:'item.completed',itemType:'assistant_text',origin:'engine',text:'save HTTP ' + response.status,threadId:turn.threadId,turnId});
    active.delete(turn.threadId);
    emit({type:'turn.completed',ok:true,threadId:turn.threadId,turnId});
  })().catch(error => { saveFs.appendFileSync(savePath.join(process.env.MURAGE_DATA_DIR, 'memsweep-1024-results.jsonl'),JSON.stringify({text:'',status:-1,tries:0,result:{error:String(error)}}) + '\\n'); }); return;`;
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

it('W-PENDING the owner\'s new words are saved in the owner\'s own turn while a revoke walk is still in flight', async () => {
  const created = await api('POST', '/api/bots', { name: 'Memsweep fixture', modelSelection: { instanceId: 'memsweep', model: 'late-1' } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true, autoReview: 'off', computer: 'off', browser: false, composio: false })).status).toBe(200);
  const say = async (text: string) => {
    const before = results().length;
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
    await expect.poll(() => results().length, { timeout: 60000 }).toBe(before + 1);
    await expect.poll(async () => (await api('GET', '/api/bots')).body.bots.find((entry: any) => entry.id === bot.id)?.busy === true, { timeout: 30000 }).toBe(false);
    return results()[before];
  };
  // setup: one memory saved with no revoke anywhere (true before and after the fix)
  const first = await say('The fixture keeps red binders.');
  expect(first, 'setup: the first save').toMatchObject({ status: 200, result: { state: 'active' } });
  // the owner forgets it; the walk that follows stays in flight
  writeFileSync(join(fixture.info.dataDir, 'memsweep-park'), '');
  const forgotten = await api('POST', '/api/memory/action', { action: 'forget', kind: 'record', id: first.result.candidateId });
  expect(forgotten.status, 'setup: the owner forgets the first memory').toBe(200);
  const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const windows = Number((db.prepare('SELECT count(*) AS n FROM memory_deny_pending_scope').get() as { n: number }).n);
    expect(windows, 'setup: the forget left a pending window (the walk is in flight)').toBeGreaterThan(0);
  } finally { db.close(); }
  // the owner's next line, saved by the engine in the owner's own turn
  const second = await say('The fixture keeps green ledgers.');
  expect(second, 'the save made while the revoke walk is in flight').toMatchObject({ status: 200, result: { state: 'active', pendingReview: false } });
  // the settled view is for the owner's own words only: a line the bot wrote may restate what is being forgotten, so a save
  // resting on it is still refused until the walk has finished (the rule before and after this fix)
  const third = await say('Please save your own earlier reply as a memory.');
  expect({ status: third.status, error: third.result?.error }, "a save resting on the bot's own line while the walk is in flight").toEqual({ status: 500, error: 'MEMORY_EVIDENCE_UNAVAILABLE' });
  // and it is the forgotten one that stays forgotten: the walk still owes its marks, the tombstone already answers
  const after = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
  try {
    after.exec('PRAGMA busy_timeout=5000');
    expect(Number((after.prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(first.result.candidateId) as { n: number }).n), 'the forgotten memory keeps its tombstone').toBeGreaterThan(0);
    expect(String((after.prepare('SELECT state FROM memory_records WHERE id=? AND version=1').get(second.result.candidateId) as { state: string }).state)).toBe('active');
  } finally { after.close(); }
}, 180000);
