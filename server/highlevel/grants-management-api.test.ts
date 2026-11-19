// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, controlResultSucceeded, type VerificationServer } from '../../scripts/control-murage.ts';
import { defaultHighLevelFamilies } from '../../shared/highlevel.ts';
const suite = describe.skipIf(process.platform === 'win32');
let fixture: VerificationServer, desktop: Record<string, string>;
const door = 'ce'.repeat(32);
const phone = { 'x-murage-companion': '1', 'x-murage-door-token': door, 'x-murage-companion-token': door,
  'x-murage-approval-device': '4b7a3f6c-1a52-4d1e-9c2e-5a0d7e41b9f3', 'x-murage-approval-class': 'app', 'x-murage-approval-key': 'B'.repeat(87) };
const evidenceDir = process.env.HLC1_EVIDENCE_DIR;
function evidence(kind: string, data: unknown) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true }); appendFileSync(join(evidenceDir, 'api.jsonl'), JSON.stringify({ kind, data }) + '\n');
}
async function api(method: string, path: string, body?: unknown, headers = desktop) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = { status: response.status, body: await response.json() as any };
  evidence('http', { method, path, ...result }); return result;
}
const grants = (level: 'read' | 'change' | 'full') => ({ grants: [{ connectionId: 'hl_fixture1', families: { ...defaultHighLevelFamilies(), contacts: level }, broaden: { contacts: true } }] });
suite('C1 real grant, review and dispatch routes', () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: door }, instrumentationSource: `
      const fs = await import('node:fs'), path = await import('node:path');
      const data = process.env.MURAGE_DATA_DIR, ask = path.join(data, 'ask'); fs.mkdirSync(ask, {recursive: true});
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL('../drivers/builtIn.ts', import.meta.url).href)});
      const { makeAskDriver } = await import(${JSON.stringify(new URL('../testing/fake-ask-driver.ts', import.meta.url).href)});
      const driver = makeAskDriver(), create = driver.create;
      driver.create = async function(input) {
        const instance = await create.call(this, input), send = instance.adapter.sendTurn;
        instance.adapter.sendTurn = async turn => {
          if (turn.integrations?.highlevel) fs.writeFileSync(path.join(ask, turn.threadId + '.json'), JSON.stringify(turn.integrations.highlevel.env), {mode: 0o600});
          return send.call(instance.adapter, turn);
        }; return instance;
      }; BUILT_IN_DRIVERS.push(driver);
      const { PHONE_JOBS_ENGINES } = await import(${JSON.stringify(new URL('../phone-jobs-engines.ts', import.meta.url).href)});
      PHONE_JOBS_ENGINES.fakeAsk = { mounts: true, where: 'isolated C1 fixture' };
      const { PrivateTokenLeaseSource } = await import(${JSON.stringify(new URL('./private-token.ts', import.meta.url).href)});
      const view = {connectionId: 'hl_fixture1', locationId: 'loc_fixture', companyId: 'co_fixture', epoch: 1, state: 'connected', scopes: ['locations.readonly', 'contacts.readonly', 'contacts.write']};
      PrivateTokenLeaseSource.prototype.ownerView = () => ({...view, confirmedAt: new Date().toISOString()});
      PrivateTokenLeaseSource.prototype.connection = async id => id === view.connectionId ? {...view} : undefined;
      PrivateTokenLeaseSource.prototype.lease = async req => ({...view, connectionEpoch: 1, leaseId: 'fixture', requestId: req.requestId, credentialVersion: 1, accessToken: 'fixture-only', providerExpiresAt: Date.now()+3600000, discardAt: Date.now()+60000});
      const { FakeHighLevel } = await import(${JSON.stringify(new URL('../testing/fake-highlevel.ts', import.meta.url).href)});
      const provider = new FakeHighLevel();
      provider.always('GET', new RegExp('^/locations/Loc12345$'), {status: 200, body: {location: {id: 'Loc12345', companyId: 'co_fixture'}, scopes: ['contacts.write']}});
      provider.always('GET', /^\\/contacts\\/contact_1$/, {status: 200, body: {contact: {id: 'contact_1', locationId: 'loc_fixture', tags: []}}});
      provider.always('POST', /^\\/contacts\\/contact_1\\/tags$/, {status: 200, body: {tags: ['fixture']}});
      provider.always('DELETE', /^\\/contacts\\/contact_1$/, {status: 200, body: {succeeded: true}});
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (!String(url).startsWith('https://services.leadconnectorhq.com/')) return realFetch(url, init);
        const result = await provider.fetch(url, init);
        fs.writeFileSync(path.join(data, 'provider.json'), JSON.stringify(provider.requests.map(r => ({method: r.method, path: r.path})))); return result;
      };
      const file = path.join(data, 'config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.instances.queues = {driver: 'fakeAsk', displayName: 'C1 fixture', environment: {FAKE_ASK_DIR: ask, FAKE_ASK_TOOLS: '1'}};
      fs.writeFileSync(file, JSON.stringify(config));
    ` });
    evidence('fixture', fixture.info);
    const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
    desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
    const doctor = await runControlMurage(['doctor', '--url', fixture.info.url]); evidence('doctor', doctor);
    expect(controlResultSucceeded('doctor', doctor)).toBe(true);
  }, 90000);
  afterAll(async () => { await fixture?.close(); if (fixture && evidenceDir) writeFileSync(join(evidenceDir, 'server.log'), readFileSync(fixture.info.logPath)); });
  it.each(['change', 'full'] as const)('%s saved through API runs only after exact desktop review and replays without a second write', async level => {
    const created = await api('POST', '/api/bots', { name: 'C1 fixture', modelSelection: { instanceId: 'queues', model: 'ask-1' } });
    expect(created.status).toBe(201); const bot = created.body.bot;
    const saved = await api('PUT', `/api/highlevel/bots/${bot.id}/access`, grants(level));
    expect(saved.status).toBe(200); expect(saved.body.access.grants[0].families.contacts).toBe(level);
    const status = await api('GET', '/api/highlevel'); expect(status.body.familyScopes.contacts.canChange).toBe(true);
    writeFileSync(join(fixture.info.dataDir, 'ask', 'hold'), '');
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { text: 'Manage fixture contact', threadId: bot.threadId, sendId: crypto.randomUUID() })).status).toBe(202);
    let env: Record<string,string> = {};
    await expect.poll(() => { try { env = JSON.parse(readFileSync(join(fixture.info.dataDir, 'ask', bot.threadId + '.json'), 'utf8')); return Boolean(env.MURAGE_CONTROL_TOKEN); } catch { return false; } }, { timeout: 20000 }).toBe(true);
    const rpc = { jsonrpc: '2.0', id: `write-${level}`, method: 'tools/call', params: { name: 'HIGHLEVEL_CONTACTS', arguments: {
      operation: level === 'full' ? 'contacts.delete' : 'contacts.tags.add', args: level === 'full' ? {contactId: 'contact_1'} : {contactId: 'contact_1', tags: ['fixture']},
    } } };
    const internal = () => api('POST', '/api/internal/highlevel/mcp', rpc, {authorization: 'Bearer ' + env.MURAGE_CONTROL_TOKEN});
    const pending = internal(); let requestId = '';
    await expect.poll(async () => {
      const rows = (await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages;
      requestId = rows.find((r: any) => r.card?.requestId?.startsWith('highlevel-'))?.card?.requestId ?? '';
      return Boolean(requestId);
    }, { timeout: 10000 }).toBe(true);
    const review = await api('GET', `/api/highlevel/reviews/${requestId.slice(10)}`); expect(review.status).toBe(200);
    expect((await api('POST', `/api/threads/${bot.threadId}/respond`, {requestId, behavior: 'allow', reviewDigest: review.body.reviewDigest})).body.outcome).toBe('allowed-once');
    const result = await pending; expect(result.body).toMatchObject({ result: {structuredContent: {outcome: 'applied'}} });
    expect(await internal()).toEqual(result);
    const calls = JSON.parse(readFileSync(join(fixture.info.dataDir, 'provider.json'), 'utf8'));
    expect(calls.filter((r: any) => r.method === (level === 'full' ? 'DELETE' : 'POST'))).toHaveLength(1);
    evidence('provider calls', calls); writeFileSync(join(fixture.info.dataDir, 'ask', 'release'), '');
    await expect.poll(async () => (await api('GET', '/api/bots?messages=0')).body.bots.find((r: any) => r.id === bot.id)?.busy, {timeout: 20000}).toBe(false);
  }, 60000);
  it('paired phone reads redacted status, saves reads and revokes, but cannot grant changes', async () => {
    const bot = (await api('POST', '/api/bots', {name: 'C1 phone', modelSelection: {instanceId: 'queues', model: 'ask-1'}})).body.bot;
    const status = await api('GET', '/api/highlevel', undefined, phone);
    expect(status.status).toBe(200); expect(status.body.redacted).toBe(true); expect(status.body.familyScopes).toBeUndefined();
    expect((await api('PUT', `/api/highlevel/bots/${bot.id}/access`, grants('read'), phone)).status).toBe(200);
    expect(await api('PUT', `/api/highlevel/bots/${bot.id}/access`, grants('change'), phone)).toMatchObject({status: 403, body: {code: 'on_computer'}});
    expect((await api('PUT', `/api/highlevel/bots/${bot.id}/access`, {grants: []}, phone)).status).toBe(200);
  });
  it('the real token-check route ignores request and location-body write-scope claims', async () => {
    const token = 'pit-fixture-not-a-real-token';
    const saved = await api('PUT', '/api/config', {highlevel: {privateToken: token}});
    expect(saved.status).toBe(200); expect(JSON.stringify(saved.body)).not.toContain(token);
    const checked = await api('POST', '/api/highlevel/token/check', {locationId: 'Loc12345', scopes: ['contacts.write', 'users.write']});
    expect(checked.status).toBe(200);
    expect(checked.body.check.scopes).toEqual(['locations.readonly']);
    expect(checked.body.familyScopes.location.present).toContain('locations.readonly');
    expect(checked.body.familyScopes.contacts.canChange).toBe(false);
    expect(checked.body.familyScopes.contacts.canFull).toBe(false);
    expect(JSON.stringify(checked.body)).not.toContain(token);
    const calls = JSON.parse(readFileSync(join(fixture.info.dataDir, 'provider.json'), 'utf8'));
    expect(calls.at(-1)).toEqual({method: 'GET', path: '/locations/Loc12345'});
    evidence('checked scope evidence', checked.body);
  });
});
