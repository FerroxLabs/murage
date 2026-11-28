// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1024-memsearch, ASTRA :9229 (2f052a2145): the final synchronous read of a search (search.ts, q1024-memsearch D) cut the ranked list to
// `limit` BEFORE it read each record again, so a record withdrawn while the loop was released took a slot and a readable record below it was
// dropped: a memory_search with limit 1 answered nothing although a readable match stood. Through the real bot tool route on a started server
// (the fixture of memsearch-recall-under-capture-1024-api, on its own server). Owners: this witness and server/memory/search.ts = q1024-memsearch.
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
    if (String(turn.text).includes('find it')) {
      const plan = JSON.parse(saveFs.readFileSync(savePath.join(process.env.MURAGE_DATA_DIR, 'memsearch-plan.json'), 'utf8'));
      const search = await call('/api/internal/memory/search', { query: plan.query, limit: 1 });
      saveFs.appendFileSync(out, JSON.stringify({ kind: 'find', search }) + '\\n');
    } else if (String(turn.text).includes('just answer')) {
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
    // :9229: while the withdraw file exists, the first record the final pass of a search would answer is withdrawn just before that pass
    // (an owner's forget landing while the loop was released between ranking and answering), once: whatever ranks first; the hook names what it
    // withdrew and how many candidates stood
    globalThis.__memsearchWithdrawTop = (caller, candidates, db) => {
      const flag = path.join(process.env.MURAGE_DATA_DIR, 'memsearch-withdraw');
      // only the bot's memory_search (the turn's own recall runs first and is not this row)
      if (caller !== 'tool' || !fs.existsSync(flag)) return;
      const ranked = candidates;
      if (!ranked.length) return;
      fs.rmSync(flag);
      db.prepare("UPDATE memory_records SET state='deleted' WHERE id=? AND version=?").run(ranked[0].id, ranked[0].version);
      fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'memsearch-withdrawn.json'), JSON.stringify({ id: ranked[0].id, candidates: ranked.length, before: candidates.indexOf(ranked[0]) }));
    };
    const patch = (url, pairs) => { let source = fs.readFileSync(new URL(url),'utf8'); for (const [anchor, add] of pairs) { if (source.split(anchor).length !== 2) throw Error('revoke park fixture anchor changed: ' + anchor.slice(0, 60)); source = source.replace(anchor, anchor + add); } return {format:'module-typescript',shortCircuit:true,source}; };
    registerHooks({load(url, context, next) {
      if (url.endsWith('/memory/search.ts')) { const source = fs.readFileSync(new URL(url),'utf8'); const final = '  const selected=inMemoryAccessPass(';
        if (source.split(final).length !== 2) throw Error('withdraw fixture anchor changed');
        return {format:'module-typescript',shortCircuit:true,source:source.replace(final,'  globalThis.__memsearchWithdrawTop?.(caller,hits.filter(hit=>hit.pinned||optional.has(hit)),database());\\n'+final)}; }
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

it('W-WITHDRAWN-SLOT a record withdrawn before the final read never takes the slot of a readable match (ASTRA :9229, memory_search limit 1)', async () => {
  const created = await api('POST', '/api/bots', { name: 'Memsearch slot fixture', modelSelection: { instanceId: 'memsearch', model: 'late-1' } });
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
  const second = await say('The fixture keeps green ledgers.');
  expect(second, 'setup: the second save').toMatchObject({ kind: 'save', status: 200, result: { state: 'active' } });
  const ids = [first.result.candidateId, second.result.candidateId];
  writeFileSync(join(fixture.info.dataDir, 'memsearch-plan.json'), JSON.stringify({ query: 'fixture keeps' }));
  // control: with nothing withdrawn, a limit-1 search answers one match
  const quiet = await say('Please find it: what does the fixture keep?');
  expect({ status: quiet.search?.status, hits: (quiet.search?.result?.hits ?? []).length }, 'setup: the control search').toEqual({ status: 200, hits: 1 });
  // the row: whatever ranks first is withdrawn just before the final pass; both saved records match, so a readable match always stands below it
  writeFileSync(join(fixture.info.dataDir, 'memsearch-withdraw'), '1');
  const found = await say('Please find it again: what does the fixture keep?');
  const withdrawn = JSON.parse(readFileSync(join(fixture.info.dataDir, 'memsearch-withdrawn.json'), 'utf8')) as { id: string; candidates: number };
  // the hook ran on this search, with at least one saved record ranked besides the one it withdrew
  expect({ ranked: withdrawn.candidates >= 2, savedStands: ids.some(id => id !== withdrawn.id) }, 'setup: the hook withdrew the first of several candidates').toEqual({ ranked: true, savedStands: true });
  const hits = (found.search?.result?.hits ?? []).map((hit: any) => hit.id);
  expect({ status: found.search?.status, answered: hits.length, withdrawnAnswered: hits.includes(withdrawn.id) }, 'the limit-1 answer after the top record was withdrawn').toEqual({ status: 200, answered: 1, withdrawnAnswered: false });
}, 240000);
