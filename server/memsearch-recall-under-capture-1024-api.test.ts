// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1024-memsearch cause D through the real turn path on a started server (the fixture is the one of memsearch-owner-settled-read-1024-api,
// on its own server, so the history this row writes never meets that file's parked revoke walk). Every captured message bumps
// memory_meta.data_revision (capture.ts). Before the fix the turn's recall read every accepted record again each time the revision moved
// while the loop was released, up to three rounds, then answered nothing: under a live session the owner's turn ran without its memory.
// Owners: this witness and server/memory/search.ts recall = q1024-memsearch; capture writers = their own lanes (read only here).
// No command text is executed.
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

it('W-RECALL-UNDER-CAPTURE the owner\'s turn recalls a saved memory while capture keeps moving data_revision (cause D, through the real turn)', async () => {
  const created = await api('POST', '/api/bots', { name: 'Memsearch capture fixture', modelSelection: { instanceId: 'memsearch', model: 'late-1' } });
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
  const revision = () => {
    const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
    try { db.exec('PRAGMA busy_timeout=5000'); return Number((db.prepare('SELECT data_revision AS n FROM memory_meta WHERE id=1').get() as { n: number }).n); } finally { db.close(); }
  };
  const saved = await say('The fixture keeps amber kettles.');
  expect(saved, 'setup: the save').toMatchObject({ kind: 'save', status: 200, result: { state: 'active' } });
  // setup: a real owner has history. 400 more owner records that match the same words are written in the bot's scope as capture writes
  // its records (jobs.ts: record + pending projection receipt of the index generation in use); the search reads them as it reads any
  // capture backlog not yet indexed (search.ts pending scan), as in the field (23,074 captures pending). With one record the search never releases the loop between accepting and answering; with a history it does.
  const seeder = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'));
  try {
    seeder.exec('PRAGMA busy_timeout=5000');
    const scope = (seeder.prepare('SELECT scope_id AS s FROM memory_records WHERE id=?').get(saved.result.candidateId) as { s: string }).s;
    const generation = Number((seeder.prepare('SELECT max(index_generation) AS g FROM memory_projection_receipts WHERE record_id=?').get(saved.result.candidateId) as { g: number }).g);
    const now = Date.now();
    const record = seeder.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)");
    const receipt = seeder.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,?,'pending','pending',NULL)");
    seeder.exec('BEGIN IMMEDIATE');
    for (let n = 0; n < 400; n++) { const id = `memsearch-d-${String(n).padStart(4, '0')}`; record.run(id, scope, `The fixture keeps amber kettles in kitchen box ${n}.`, now, now); receipt.run(id, generation); }
    seeder.exec('UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1; COMMIT');
  } finally { seeder.close(); }
  try {
  // control: with nothing writing, the owner's turn carries the history. The saved line itself is in the thread transcript, so only
  // the history's own words ("kitchen box N", never typed in the thread) prove what recall brought into what the engine is sent.
  const quiet = await say('Please just answer: what does the fixture keep in the kitchen?');
  expect(quiet.memory, 'setup: the quiet turn\'s recall carries the saved history').toMatch(/amber kettles in kitchen box \d+/);
  // the field case: capture writes all through the turn; the turn's recall must still carry it
  // (a writer on its own connection bumps memory_meta.data_revision every 5 ms from the moment the line is accepted, as capture does for every captured message,
  // capture.ts; nothing else about the turn is changed)
  const from = revision();
  const writer = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'));
  writer.exec('PRAGMA busy_timeout=5000');
  const bump = writer.prepare('UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1');
  // (base 7f13281e8d: the turn does not reach the engine at all within the minute; that and a turn sent without the history are the
  // same failure, so both are judged by the one assertion below)
  const before = results().length;
  let busy: Record<string, any> | undefined, storm: ReturnType<typeof setInterval> | undefined;
  try {
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'Please just answer again: what does the fixture keep in the kitchen?' })).status).toBe(202);
    storm = setInterval(() => { bump.run(); }, 5);
    for (const until = Date.now() + 60000; Date.now() < until && !(busy = results()[before]);) await new Promise(resolve => setTimeout(resolve, 250));
  } finally { clearInterval(storm); writer.close(); }
  expect(revision() - from, 'setup: data_revision moved all through the turn').toBeGreaterThan(20);
  expect({ answered: busy?.kind, recalled: /amber kettles in kitchen box \d+/.test(String(busy?.memory)) }, 'the turn\'s recall while capture writes').toEqual({ answered: 'answer', recalled: true });
  } finally {
    // the history leaves with the row: its projection backlog would keep the worker from the capture the next rows' saves wait for
    const cleaner = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'));
    try {
      cleaner.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; DELETE FROM memory_projection_receipts WHERE record_id LIKE 'memsearch-d-%'; UPDATE memory_records SET state='deleted' WHERE id LIKE 'memsearch-d-%'; UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1; COMMIT");
    } finally { cleaner.close(); }
  }
}, 240000);
