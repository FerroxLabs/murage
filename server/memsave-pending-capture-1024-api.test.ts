// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMSAVE-1024, through the shipped HTTP door on a started server. The field state is reproduced, not mocked away: the memory
// worker never gets to claim a job (as under BG_DEFERRED), so every capture stays queued. The fake engine then calls
// POST /api/internal/memory/save ONCE with the turn's own memory credential, quoting the owner's line. No command text is executed.
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

beforeAll(async () => {
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  const replacement = `void (async () => {
    const env = turn.integrations?.memory?.env;
    if (!env) throw Error('fixture memory mount missing');
    const response = await fetch(new URL('/api/internal/memory/save', env.MURAGE_HARNESS_URL), {
      method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + saveSecret('MURAGE_MEMORY_TOKEN', env)},
      body: JSON.stringify({text:'The fixture uses blue folders.', evidence:[{quote:'The fixture uses blue folders.'}], idempotencyKey:'memsave-1024'})
    });
    const result = await response.json();
    saveFs.writeFileSync(savePath.join(process.env.MURAGE_DATA_DIR, 'memsave-1024-result.json'), JSON.stringify({status:response.status, result}));
    emit({type:'item.completed',itemType:'assistant_text',origin:'engine',text:'save HTTP ' + response.status,threadId:turn.threadId,turnId});
    active.delete(turn.threadId);
    emit({type:'turn.completed',ok:true,threadId:turn.threadId,turnId});
  })().catch(error => { saveFs.writeFileSync(savePath.join(process.env.MURAGE_DATA_DIR, 'memsave-1024-result.json'),JSON.stringify({error:String(error)})); }); return;`;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    const {registerHooks} = await import('node:module');
    registerHooks({load(url, context, next) {
      if (url.endsWith('/memory/worker-controller.ts')) {
        // the starved worker: its every claim of queued work finds no room, as the field log shows for capture (BG_DEFERRED)
        const source = fs.readFileSync(new URL(url),'utf8'), claim = 'claimMemoryJob(this.owner';
        if (source.split(claim).length - 1 < 5) throw Error('worker claim fixture anchor changed');
        return {format:'module-typescript',shortCircuit:true,source:source.replaceAll(claim,'((..._starved:unknown[])=>null)(this.owner')};
      }
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
    cfg.instances.memsave = {driver:'fakeLateTerminal',environment:{FAKE_LATE_MEMORY_MCP:'1'}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 120000);

afterAll(async () => { await fixture?.close(); });

it('W-HTTP one memory save over HTTP is saved while the capture worker is starved, and the cited capture is completed', async () => {
  const created = await api('POST', '/api/bots', { name: 'Memsave fixture', modelSelection: { instanceId: 'memsave', model: 'late-1' } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true, autoReview: 'off', computer: 'off', browser: false, composio: false })).status).toBe(200);
  expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'The fixture uses blue folders.' })).status).toBe(202);
  const resultPath = join(fixture.info.dataDir, 'memsave-1024-result.json');
  await expect.poll(() => existsSync(resultPath), { timeout: 30000 }).toBe(true);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  expect(result).toMatchObject({ status: 200, result: { state: 'active', pendingReview: false } });
  const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
  try {
    const cited = db.prepare("SELECT j.status FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.kind='fact' JOIN memory_jobs j ON j.source_id=e.source_id AND j.source_revision=e.source_revision AND j.stage='capture'").all();
    expect(cited).toEqual([{ status: 'complete' }]);
  } finally { db.close(); }
}, 60000);
