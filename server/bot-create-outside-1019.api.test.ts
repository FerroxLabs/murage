import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => { const res = await fetch(fixture.info.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: res.status, body: await res.json() as any }; };
beforeAll(async () => {
  const cli = fileURLToPath(new URL('./testing/fake-acp-cli.ts', import.meta.url));
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 48500, span: 400 }, instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.noLimitsTermsVersion = 2;
    fs.mkdirSync(path.join(process.env.HOME, '.fuigo'), {recursive:true});
    fs.writeFileSync(path.join(process.env.HOME, '.fuigo', 'auth.json'), '{}');
    config.instances.creator = { driver: 'fuigoAgent', displayName: 'Bot creation fixture', environment: { FAKE_ACP_MODE: 'create-peer', FAKE_ACP_MCP_READY: '1', FAKE_BOTCREATE_TWO: '1', FAKE_BOTCREATE_NAME: 'Susan', FAKE_BOTCREATE_GATE: path.join(process.env.MURAGE_DATA_DIR, 'finish-create') }, config: { cli: ${JSON.stringify(cli)}, fullAuto: true } };
    config.instances.creatorAsk = { ...config.instances.creator, environment: { ...config.instances.creator.environment, FAKE_BOTCREATE_TWO: '0', FAKE_BOTCREATE_NAME: 'Reply helper', FAKE_BOTCREATE_TOOL: 'ask_bot', FAKE_BOTCREATE_GATE: path.join(process.env.MURAGE_DATA_DIR, 'finish-ask') } };
    config.instances.creatorGroup = { ...config.instances.creatorAsk, environment: { ...config.instances.creatorAsk.environment, FAKE_BOTCREATE_NAME: 'Room helper', FAKE_BOTCREATE_GATE: path.join(process.env.MURAGE_DATA_DIR, 'finish-group') } };
    config.instances.creatorReview = { ...config.instances.creatorAsk, environment: { ...config.instances.creatorAsk.environment, FAKE_BOTCREATE_NAME: 'Review helper', FAKE_BOTCREATE_OUTSIDE: '1', FAKE_BOTCREATE_GATE: path.join(process.env.MURAGE_DATA_DIR, 'finish-review') } };
    fs.writeFileSync(file, JSON.stringify(config));
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret, 'content-type': 'application/json' };
}, 150_000);
afterAll(async () => { if (fixture) { mkdirSync('botcreate-fixture-evidence', {recursive:true}); copyFileSync(fixture.info.logPath, 'botcreate-fixture-evidence/server.log'); await fixture.close(); } });
it.each([['creator', 'Susan', 'finish-create', 2], ['creatorAsk', 'Reply helper', 'finish-ask', 1]] as const)('isolated server %s: held receipt stays clean, activates and dispatches all work', async (instanceId, name, gate, count) => {
  const instances = (await api('GET', '/api/instances')).body.instances;
  const creator = instances.find((i: any) => i.instanceId === instanceId); expect(creator).toBeDefined();
  const made = await api('POST', '/api/bots', { name: 'Studio lead ' + instanceId, section: 'Studio ' + instanceId, modelSelection: { instanceId, model: "fake-model" } }); expect(made.status, JSON.stringify(made.body)).toBe(201);
  const chief = made.body.bot;
  expect((await api('PATCH', `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: 'section', computer: 'off', browser: false, composio: false })).status).toBe(200);
  expect((await api('POST', `/api/bots/${chief.id}/messages`, { text: 'Create Susan.' })).status).toBe(202);
  const bots = () => JSON.parse(readFileSync(join(fixture.info.dataDir, 'bots.json'), 'utf8')) as any[];
  try { await expect.poll(() => bots().find(b => b.name === name)?.staged?.reason, { timeout: 20_000 }).toBe('turn-open'); } catch (error) { console.info('FIXTURE_MESSAGES', JSON.stringify((await api('GET', `/api/threads/${chief.threadId}/messages?limit=200`)).body)); throw error; }
  await expect.poll(() => bots().find(b => b.name === name)?.staged?.heldWork.length, { timeout: 20_000 }).toBe(count);
  const susan = bots().find(b => b.name === name);
  const blocked = await api('POST', `/api/bots/${susan.id}/messages`, { text: 'Should wait.' }); expect(blocked.status).toBe(409);
  writeFileSync(join(fixture.info.dataDir, gate), '1');
  const env = { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir };
  const wait = await runControlMurage(['wait', '--bot', chief.id, '--timeout', '15', '--url', fixture.info.url], {env});
  const messages = await runControlMurage(['messages', '--bot', chief.id, '--limit', '15', '--url', fixture.info.url], {env});
  const observation = {trace:'SUSAN-a', expected:'ACTIVE', observed:bots().find(b=>b.id===susan.id), blocked:blocked.status, wait, messages, fixture:fixture.info};
  mkdirSync('botcreate-fixture-evidence', {recursive:true}); writeFileSync(`botcreate-fixture-evidence/${instanceId}.json`, JSON.stringify(observation,null,2));
  console.info('SUSAN_A_OBSERVATION', JSON.stringify(observation));
  expect(bots().find(b => b.id === susan.id)?.staged ?? null).toBeNull();
  expect((await api('GET', `/api/bots/${susan.id}`)).status).toBe(200);
  await expect.poll(async () => { const result = await api('GET', `/api/threads/${chief.threadId}/messages?limit=200`); return result.body.messages.filter((m: any) => m.copyOf && m.from?.botId === susan.id).length; }, { timeout: 30_000 }).toBe(count);
  console.info('BOTCREATE_FIXTURE', JSON.stringify({ result: 'ACTIVE', name: 'Susan', blocked: blocked.status, logPath: fixture.info.logPath }));
}, 120_000);

it('group add waits for activation and then uses the current room', async () => {
  const made = await api('POST', '/api/bots', { name: 'Room lead', section: 'Room', modelSelection: { instanceId: 'creatorGroup', model: 'fake-model' } });
  const chief = made.body.bot;
  expect((await api('PATCH', `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: 'section', computer: 'off', browser: false, composio: false })).status).toBe(200);
  expect((await api('POST', `/api/bots/${chief.id}/messages`, { text: 'Create a room helper.' })).status).toBe(202);
  const bots = () => JSON.parse(readFileSync(join(fixture.info.dataDir, 'bots.json'), 'utf8')) as any[];
  await expect.poll(() => bots().find(b => b.name === 'Room helper')?.staged?.heldWork.length, {timeout:20_000}).toBe(1);
  const helper = bots().find(b => b.name === 'Room helper');
  const madeGroup = await api('POST', '/api/groups', {name:'Room for review', memberIds:[chief.id,helper.id]});
  expect(madeGroup.status).toBe(201);
  expect(madeGroup.body.group.memberIds).toEqual([chief.id]);
  expect(bots().find(b=>b.id===helper.id).staged.heldWork.map((w:any)=>w.kind)).toEqual(['ask','group-add']);
  writeFileSync(join(fixture.info.dataDir, 'finish-group'), '1');
  await expect.poll(async () => (await api('GET', '/api/bots?messages=0')).body.groups.find((g:any)=>g.id===madeGroup.body.group.id)?.memberIds, {timeout:20_000}).toContain(helper.id);
}, 60_000);

it('owner review after the caller ended releases held peer work without another caller turn', async () => {
  const made = await api('POST', '/api/bots', { name: 'Review lead', section: 'Review team', modelSelection: { instanceId: 'creatorReview', model: 'fake-model' } });
  const chief = made.body.bot;
  expect((await api('PATCH', `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: 'section', computer: 'off', browser: false, composio: false })).status).toBe(200);
  expect((await api('POST', `/api/bots/${chief.id}/messages`, { text: 'Create a helper.' })).status).toBe(202);
  const bots = () => JSON.parse(readFileSync(join(fixture.info.dataDir, 'bots.json'), 'utf8')) as any[];
  await expect.poll(() => bots().find(b => b.name === 'Review helper')?.staged?.heldWork.length, { timeout: 20_000 }).toBe(1);
  const helper = bots().find(b => b.name === 'Review helper');
  writeFileSync(join(fixture.info.dataDir, 'finish-review'), '1');
  const env = { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir };
  const wait = await runControlMurage(['wait', '--bot', chief.id, '--timeout', '15', '--url', fixture.info.url], { env });
  await expect.poll(() => bots().find(b => b.id === helper.id)?.staged?.reason, { timeout: 20_000 }).toBe('outside');
  const review = await api('GET', `/api/bots/${helper.id}/review`);
  const activated = await api('POST', `/api/bots/${helper.id}/review`, { action: 'activate', seen: { renderer: 'bot-review@1', digest: review.body.digest } });
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  await expect.poll(async () => (await api('GET', `/api/threads/${chief.threadId}/messages?limit=200`)).body.messages.filter((m: any) => m.copyOf && m.from?.botId === helper.id).length, { timeout: 30_000 }).toBe(1);
  const messages = await runControlMurage(['messages', '--bot', chief.id, '--limit', '30', '--url', fixture.info.url], { env });
  mkdirSync('botcreate-fixture-evidence', { recursive: true });
  writeFileSync('botcreate-fixture-evidence/owner-review.json', JSON.stringify({ wait, review, activated, messages, fixture: fixture.info }, null, 2));
}, 90_000);
