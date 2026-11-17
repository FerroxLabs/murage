// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../../scripts/control-murage.ts';
import { defaultHighLevelFamilies } from '../../shared/highlevel.ts';
import { raiseLevel } from '../testing/raise-level.ts';

let fixture: VerificationServer;
let desktop: Record<string, string>;
const commands: unknown[] = [];
const evidenceDir = process.env.GNL_MOUNT_EVIDENCE_DIR ?? 'evidence/gnl-r4/workflow';
async function api(method: string, path: string, body?: unknown, headers = desktop) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = { status: response.status, body: await response.json() as any };
  if (!path.includes('secret')) commands.push({ method, path, requestBody: body, ...result });
  return result;
}
beforeAll(async () => {
  try { fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const data = process.env.MURAGE_DATA_DIR, ask = path.join(data, 'ask'); fs.mkdirSync(ask, {recursive: true});
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL('../drivers/builtIn.ts', import.meta.url).href)});
    const { makeAskDriver } = await import(${JSON.stringify(new URL('../testing/fake-ask-driver.ts', import.meta.url).href)});
    BUILT_IN_DRIVERS.push(makeAskDriver());
    const { PHONE_JOBS_ENGINES } = await import(${JSON.stringify(new URL('../phone-jobs-engines.ts', import.meta.url).href)});
    PHONE_JOBS_ENGINES.fakeAsk = { mounts: true, where: 'isolated H1 turn-level fixture' };
    const { PrivateTokenLeaseSource } = await import(${JSON.stringify(new URL('./private-token.ts', import.meta.url).href)});
    const view = {connectionId: 'hl_fixture1', locationId: 'loc_fixture', companyId: 'co_fixture', epoch: 1, state: 'connected'};
    PrivateTokenLeaseSource.prototype.ownerView = () => ({...view, confirmedAt: new Date().toISOString()});
    PrivateTokenLeaseSource.prototype.connection = async id => id === view.connectionId ? {...view} : undefined;
    const file = path.join(data, 'config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.instances.queues = {driver: 'fakeAsk', displayName: 'H1 fixture', environment: {FAKE_ASK_DIR: ask, FAKE_ASK_TOOLS: '1'}};
    fs.writeFileSync(file, JSON.stringify(config));
    const { registerHooks } = await import('node:module');
    registerHooks({load(url, context, next) {
      if (!url.endsWith('/server/index.ts')) return next(url, context);
      let source = fs.readFileSync(new URL(url), 'utf8');
      // Supply a linked synthetic channel person before admission, using the real principal/thread binding APIs.
      const threadAnchor = 'const threadId = opts?.threadId ?? defaultThreadId(profile);';
      if (!source.includes(threadAnchor)) throw Error('H1 guest admission anchor moved');
      source = source.replace(threadAnchor, "if (profile.name.includes('other-person')) { const id = observeVerifiedHuman({platform: 'slack', authorityId: 'h1-fixture', connectionId: 'h1-fixture', userId: profile.id}); linkHumanBinding(ownerMemoryTicket(), {bindingId: id, expectedRevision: 1, as: 'person'}); const guestTask = h1HumanTask(store, profile.id, resolveHumanBinding(id)); opts = {...opts, threadId: guestTask.threadId, automationSource: 'channel', notOwnerAudience: true}; } " + threadAnchor);
      // Corrupt only the saved grant, modelling old/malformed persisted data. All permission resolution and mounting run unchanged.
      const grantAnchor = 'const highlevelEngine =';
      const observeAnchor = 'if (highlevelAdmission && highlevelEngine && await highlevel.mountsFor(';
      if (!source.includes(grantAnchor) || !source.includes(observeAnchor)) throw Error('H1 fixture anchor moved');
      source = source.replace(grantAnchor, "const storedAccess = store.bot(bot.id)?.highlevelAccess; if (storedAccess && bot.name.startsWith('H1 ')) { if (bot.name.endsWith('malformed-deny')) storedAccess.denyRules = ['not-a-rule']; else { storedAccess.grants[0].operations = {contacts: []}; } } " + grantAnchor);
      source = source.replace(observeAnchor, "fs.appendFileSync(path.join(data, 'mount-levels.jsonl'), JSON.stringify({threadId, level: highlevelLevel, origin: decisionNoLimitsOrigin(dispatchProvenance)})+String.fromCharCode(10));" + observeAnchor);
      // The observer uses only fixture-local fs/path/data bindings.
      source = "import {humanTask as h1HumanTask} from './human-principals.ts'; import * as fs from 'node:fs'; import * as path from 'node:path'; const data = process.env.MURAGE_DATA_DIR;" + source;
      return {format: 'module-typescript', shortCircuit: true, source};
    }});
  ` });
  } catch (error) {
    mkdirSync(evidenceDir, { recursive: true });
    const log = String(error).match(/see (.*\.log)/)?.[1];
    if (log && existsSync(log)) writeFileSync(join(evidenceDir, 'startup.log'), readFileSync(log));
    throw error;
  }
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
  commands.push({ doctor: await runControlMurage(['doctor', '--url', fixture.info.url]) });
}, 120000);
afterAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  if (fixture) {
    writeFileSync(join(evidenceDir, 'workflow.json'), JSON.stringify({ fixture: fixture.info, commands }, null, 2));
    writeFileSync(join(evidenceDir, 'server.log'), readFileSync(fixture.info.logPath));
  }
  await fixture?.close();
});

it.each(['malformed-deny', 'empty-operations'] as const)('H1 actual turns use task authority for %s access', async restriction => {
  for (const kind of ['task-no-limits', 'task-ask', 'guest', 'other-person'] as const) {
    const created = await api('POST', '/api/bots', { name: `H1 ${kind} ${restriction}`, modelSelection: { instanceId: 'queues', model: 'ask-1' } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect((await api('PATCH', `/api/bots/${bot.id}`, { settingsScope: 'defaults', autoApprove: false, fullAccess: false, noLimits: false, computer: 'off', browser: false, autoReview: 'off' })).status).toBe(200);
    if (kind !== 'task-no-limits') expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true }, { conversations: false })).status).toBe(200);
    const noLimits = kind !== 'task-ask';
    expect((await api('PATCH', `/api/bots/${bot.id}/tasks/${bot.threadId}`, { autoApprove: noLimits, fullAccess: noLimits, noLimits, ...(noLimits ? { acknowledgeNoLimits: true } : {}) })).status).toBe(200);
    const saved = await api('PUT', `/api/highlevel/bots/${bot.id}/access`, { grants: [{ connectionId: 'hl_fixture1', families: Object.fromEntries(Object.keys(defaultHighLevelFamilies()).map(family => [family, family === 'contacts' ? 'change' : 'off'])), broaden: { contacts: true } }] });
    expect(saved.status).toBe(200);
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `H1 ${kind} ${restriction}`, sendId: crypto.randomUUID() }, kind === 'guest' ? {} : desktop)).status).toBe(202);
    let row: any;
    await expect.poll(() => {
      const file = join(fixture.info.dataDir, 'ask', 'dump.jsonl');
      if (!existsSync(file)) return false;
      row = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(item => String(item.text).includes(`H1 ${kind} ${restriction}`) && !item.steer);
      return Boolean(row);
    }, { timeout: 30000 }).toBe(true);
    const levels = readFileSync(join(fixture.info.dataDir, 'mount-levels.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(item => item.threadId === row.threadId);
    const waited = await runControlMurage(['wait', '--bot', bot.id, '--timeout', '10', '--url', fixture.info.url]);
    const messages = await api('GET', `/api/threads/${row.threadId}/messages?limit=100`);
    commands.push({ kind, restriction, levels, turn: row, waited, messages });
    expect(messages.status).toBe(200);
    expect(levels).toEqual([{ threadId: row.threadId, level: kind === 'task-no-limits' ? 'unlimited' : 'ask', origin: kind === 'guest' || kind === 'other-person' ? 'other-human' : 'owner' }]);
    expect(row.highlevel === true).toBe(kind === 'task-no-limits');
    if (kind === 'other-person') expect(row.threadId).not.toBe(bot.threadId);
    expect(waited).toMatchObject({ status: 'settled' });
  }
}, 120000);
