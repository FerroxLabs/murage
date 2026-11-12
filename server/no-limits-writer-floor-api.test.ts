// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated, fake-only HTTP proof. No command text is executed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';

let fixture: VerificationServer;
let headers: Record<string, string>;
const evidence = new URL('../evidence/writer-floor/raw/api/', import.meta.url);
mkdirSync(evidence, { recursive: true });
const commands: unknown[] = [];
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  commands.push({ method, path, body, status: response.status, result });
  return { status: response.status, body: result as any };
}

beforeAll(async () => {
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  const replacement = `void (async () => {
    const env = turn.integrations?.memory?.env;
    if (!env) throw Error('fixture memory mount missing');
    floorMarks.markTurnOutside(turn.threadId, 'web page');
    let response, result; const attempts = [];
    // Message capture is asynchronous. Retry only its documented pending
    // response; a writer-floor refusal must surface immediately.
    for (let attempt = 0; attempt < 100; attempt++) {
      response = await fetch(new URL('/api/internal/memory/save', env.MURAGE_HARNESS_URL), {
        method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + floorSecret('MURAGE_MEMORY_TOKEN', env)},
        body: JSON.stringify({text:'The fixture uses blue folders.', evidence:[{quote:'The fixture uses blue folders.'}], idempotencyKey:'writer-floor-save'})
      });
      result = await response.json(); attempts.push({status:response.status,result});
      if (response.status !== 409 || !String(result.error).includes('Source capture is still pending')) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    floorFs.writeFileSync(floorPath.join(process.env.MURAGE_DATA_DIR, 'writer-floor-result.json'), JSON.stringify({status:response.status, result, attempts, outside:floorMarks.turnOutsideRead(turn.threadId)}));
    emit({type:'item.completed',itemType:'assistant_text',origin:'engine',text:'writer floor HTTP ' + response.status,threadId:turn.threadId,turnId});
    active.delete(turn.threadId);
    emit({type:'turn.completed',ok:true,threadId:turn.threadId,turnId});
  })().catch(error => { floorFs.writeFileSync(floorPath.join(process.env.MURAGE_DATA_DIR, 'writer-floor-result.json'),JSON.stringify({error:String(error)})); }); return;`;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    const {registerHooks} = await import('node:module');
    registerHooks({load(url, context, next) {
      if (url.endsWith('/decision/implementation.ts')) {
        const anchor = 'export function readTurnPolicy(identity:T.TurnIdentity):T.TurnPolicy|undefined{';
        const source = fs.readFileSync(new URL(url),'utf8');
        if (!source.includes(anchor)) throw Error('turn-policy fixture anchor changed');
        // Simulate the stored policy being unavailable after a restart. Keep
        // the real capability, admission provenance, routes and decision gate.
        return {format:'module-typescript',shortCircuit:true,source:source.replace(anchor,anchor + "return undefined;")};
      }
      if (url.endsWith('/email/external-marks.ts')) return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace('COVERED_DRIVERS.has(driverKind)','(driverKind === "fakeLateTerminal" || COVERED_DRIVERS.has(driverKind))')};
      if (!url.endsWith('/fake-late-terminal-driver.ts')) return next(url,context);
      let source = "import * as floorMarks from '../email/external-marks.ts'; import * as floorFs from 'node:fs'; import * as floorPath from 'node:path'; import {turnSecret as floorSecret} from '../turn-credential.ts';\\n" + fs.readFileSync(new URL(url),'utf8');
      if (!source.includes(${JSON.stringify(anchor)})) throw Error('fake engine fixture anchor changed');
      return {format:'module-typescript',shortCircuit:true,source:source.replaceAll(${JSON.stringify(anchor)},${JSON.stringify(replacement)})};
    }});
    const {BUILT_IN_DRIVERS} = await import(${JSON.stringify(new URL('./drivers/builtIn.ts', import.meta.url).href)});
    const {makeLateTerminalDriver} = await import(${JSON.stringify(new URL('./testing/fake-late-terminal-driver.ts', import.meta.url).href)});
    BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
    const file = path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.writerFloor = {driver:'fakeLateTerminal',environment:{FAKE_LATE_MEMORY_MCP:'1'}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  writeFileSync(new URL('launch.json', evidence), JSON.stringify(fixture.info, null, 2));
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 120000);

afterAll(async () => {
  try {
    writeFileSync(new URL('commands.json', evidence), JSON.stringify(commands, null, 2));
    if (fixture) writeFileSync(new URL('server.log', evidence), readFileSync(fixture.info.logPath));
  } finally { await fixture?.close(); }
});

it('S2 marked owner memory_save returns 200 without a turn policy, card or refusal', async () => {
  const doctor = await runControlMurage(['doctor', '--url', fixture.info.url], { env: { MURAGE_DATA_DIR: fixture.info.dataDir } });
  writeFileSync(new URL('doctor.json', evidence), JSON.stringify(doctor, null, 2));
  expect(doctor).toMatchObject({ ok: true });
  const created = await api('POST', '/api/bots', { name: 'Writer floor fixture', modelSelection: { instanceId: 'writerFloor', model: 'late-1' } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true, autoReview: 'off', computer: 'off', browser: false, composio: false })).status).toBe(200);
  expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'The fixture uses blue folders.' })).status).toBe(202);
  const resultPath = join(fixture.info.dataDir, 'writer-floor-result.json');
  await expect.poll(() => existsSync(resultPath), { timeout: 30000 }).toBe(true);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  writeFileSync(new URL('result.json', evidence), JSON.stringify(result, null, 2));
  const messages = await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`);
  const decisions = await api('GET', '/api/decisions?limit=100');
  writeFileSync(new URL('state.json', evidence), JSON.stringify({ messages, decisions }, null, 2));
  expect(result).toMatchObject({ status: 200, outside: expect.stringContaining('web page') });
  expect(result.result).toMatchObject({ state: 'active', pendingReview: false });
  expect(messages.body.messages.filter((message: any) => message.card?.requestId)).toHaveLength(0);
  expect(decisions.body.decisions.filter((decision: any) => decision.threadId === bot.threadId && decision.decision === 'card-shown')).toHaveLength(0);
}, 60000);
