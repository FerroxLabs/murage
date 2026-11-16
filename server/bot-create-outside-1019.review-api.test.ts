import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
let fixture: VerificationServer, headers: Record<string, string>;
const evidence = 'botcreate-review-fixture-evidence';
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(fixture.info.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() as any };
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { dumpLog: true, portRange: { from: 48900, span: 300 }, instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.mkdirSync(path.join(process.env.HOME, '.fuigo'), {recursive:true});
    fs.writeFileSync(path.join(process.env.HOME, '.fuigo', 'auth.json'), '{}');
    config.instances.caller = { driver: 'fuigoAgent', displayName: 'Held routine fixture', environment: { FAKE_ACP_MODE: 'delegate-staged-review', FAKE_ACP_MCP_READY: '1', FAKE_BOTCREATE_TARGET_FILE: path.join(process.env.MURAGE_DATA_DIR, 'review-target.json'), FAKE_BOTCREATE_GATE: path.join(process.env.MURAGE_DATA_DIR, 'finish-caller') }, config: { cli: ${JSON.stringify(new URL('./testing/fake-acp-cli.ts', import.meta.url).pathname)}, fullAuto: true } };
    fs.writeFileSync(file, JSON.stringify(config));
    const { ClaudeDriver } = await import(${JSON.stringify(new URL('./drivers/claude.ts', import.meta.url).href)});
    const create = ClaudeDriver.create.bind(ClaudeDriver);
    ClaudeDriver.create = async spec => {
      const instance = await create(spec), sendTurn = instance.adapter.sendTurn.bind(instance.adapter);
      instance.adapter.sendTurn = async turn => {
        fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR, 'review-admission.jsonl'), JSON.stringify({ threadId: turn.threadId, askLevel: turn.askLevel === true, routeAsks: turn.routeAsks === true, stopLine: turn.stopLine === true }) + '\\n');
        return sendTurn(turn);
      };
      return instance;
    };

    const { Store } = await import(${JSON.stringify(new URL('./store.ts', import.meta.url).href)});
    const store = new Store(() => ({ instanceId: 'verification', model: 'claude-sonnet-5' }));
    const target = store.createBot({ name: 'Staged B', section: 'Studio' }, { seedMessages: false, staged: { rev: 1, at: Date.now(), generation: 'fixture-original', reason: 'outside', byThreadId: 'fixture-original-thread', byBotId: 'fixture-original-bot', intended: { autoApprove: true, fullAccess: false, noLimits: false, lead: false }, heldWork: [] } });
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'review-target.json'), JSON.stringify({ id: target.id }));
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret, 'content-type': 'application/json' };
}, 150_000);
afterAll(async () => { if (fixture) { mkdirSync(evidence, { recursive: true }); copyFileSync(fixture.info.logPath, join(evidence, 'server.log')); await fixture.close(); } });
it('review HIGH exact workflow: idle Ask routine T delegates to staged Auto B; activation runs B at Ask', async () => {
  const made = await api('POST', '/api/bots', { name: 'A', section: 'Studio', modelSelection: { instanceId: 'caller', model: 'fake-model' } });
  expect(made.status).toBe(201); const caller = made.body.bot;
  expect((await api('PATCH', `/api/bots/${caller.id}`, { chiefOfStaff: true, chiefScope: 'section', computer: 'off', browser: false, composio: false })).status).toBe(200);
  const created = await api('POST', '/api/routines', { name: 'Idle Ask routine', prompt: 'SEED_ROUTINE_REVIEW', botId: caller.id, enabled: false, permissionMode: 'ask', schedule: { type: 'interval', everyMinutes: 30, anchorAt: Date.now() } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const routineId = created.body.routine.id;
  expect((await api('POST', `/api/routines/${routineId}/run`, {})).status).toBe(201);
  await expect.poll(async () => (await api('GET', '/api/routines')).body.runs.find((r: any) => r.routineId === routineId)?.status, { timeout: 30_000 }).toBe('completed');
  const routine = (await api('GET', '/api/routines')).body.routines.find((r: any) => r.id === routineId);
  expect(routine.threadId).toBeTruthy();
  const targetId = JSON.parse(readFileSync(join(fixture.info.dataDir, 'review-target.json'), 'utf8')).id;
  const bots = () => JSON.parse(readFileSync(join(fixture.info.dataDir, 'bots.json'), 'utf8')) as any[];
  expect(bots().find(b => b.id === targetId).staged.intended.autoApprove).toBe(true);
  expect((await api('POST', `/api/bots/${caller.id}/messages`, { text: 'Hand Run task to staged B.', threadId: routine.threadId })).status).toBe(202);
  await expect.poll(() => bots().find(b => b.id === targetId)?.staged?.heldWork.length, { timeout: 30_000 }).toBe(1);
  const held = bots().find(b => b.id === targetId).staged.heldWork[0];
  expect(held.peer.routineAuthority).toEqual({ permissionMode: 'ask', triggerSource: 'manual' });
  writeFileSync(join(fixture.info.dataDir, 'finish-caller'), '1');
  const callerWait = await runControlMurage(['wait', '--bot', caller.id, '--timeout', '15', '--url', fixture.info.url], { env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir } });
  const review = await api('GET', `/api/bots/${targetId}/review`);
  const activated = await api('POST', `/api/bots/${targetId}/review`, { action: 'activate', seen: { renderer: 'bot-review@1', digest: review.body.digest } });
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  expect(bots().find(b => b.id === targetId).autoApprove).toBe(true);
  const targetThread = bots().find(b => b.id === targetId).threadId;
  const workerAdmission = () => {
    try { return readFileSync(join(fixture.info.dataDir, 'review-admission.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(turn => turn.threadId === targetThread); }
    catch { return undefined; }
  };
  await expect.poll(workerAdmission, { timeout: 30_000 }).toBeDefined();
  expect(workerAdmission()).toEqual({ threadId: targetThread, askLevel: true, routeAsks: true, stopLine: false });
  writeFileSync(join(fixture.info.dataDir, 'finish-caller'), '1');
  const env = { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir };
  const wait = await runControlMurage(['wait', '--bot', targetId, '--timeout', '15', '--url', fixture.info.url], { env });
  const messages = await runControlMurage(['messages', '--bot', targetId, '--limit', '15', '--url', fixture.info.url], { env });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'routine-review.json'), JSON.stringify({ held, callerWait, activated: activated.status, intended: 'auto', actual: 'ask', providerAdmission: workerAdmission(), wait, messages, fixture: fixture.info }, null, 2));
}, 120_000);
