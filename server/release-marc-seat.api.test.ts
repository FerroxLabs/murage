// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Acceptance input: FIELD-REPORT-MARC-1111.md item 1. No product mocks.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';
const evidence = process.env.RELEASE_GATE_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'murage-seat-evidence-'));
let fixture: VerificationServer, headers: Record<string, string> = {};
let observedThread: string | undefined;
let level: 'ask' | 'auto' | 'full' | 'no-limits' = 'no-limits';
const flagsFor = (value: typeof level) => ({ autoApprove: value !== 'ask', fullAccess: value === 'full' || value === 'no-limits', noLimits: value === 'no-limits' });
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(fixture.info.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() as any };
}
beforeEach(async () => {
  observedThread = undefined;
  const cli = fileURLToPath(new URL('./testing/fake-acp-cli.ts', import.meta.url));
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')); cfg.noLimitsTermsVersion = 2;
    cfg.instances.verification.environment = { ...cfg.instances.verification.environment, FAKE_CLAUDE_TEXT_ONLY: '1' };
    fs.mkdirSync(path.join(process.env.HOME, '.fuigo'), {recursive:true});
    fs.writeFileSync(path.join(process.env.HOME, '.fuigo', 'auth.json'), '{}');
    cfg.instances.creator = {driver:'fuigoAgent', displayName:'Inert creator', environment:{
      FAKE_ACP_MODE:'create-peer', FAKE_ACP_MCP_READY:'1', FAKE_BOTCREATE_TWO:'0',
      FAKE_BOTCREATE_NAME:'Marc fixture seat', FAKE_BOTCREATE_GATE:path.join(process.env.MURAGE_DATA_DIR,'finish-create')
    }, config:{cli:${JSON.stringify(cli)},fullAuto:true}};
    fs.writeFileSync(file, JSON.stringify(cfg));
  ` });
  const proof = await api('GET', '/api/desktop-secret');
  headers = { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.body.secret };
}, 150_000);
afterEach(async ({ task }) => {
  if (!fixture) return;
  try {
    mkdirSync(evidence + '/seat/' + level, { recursive: true });
    copyFileSync(fixture.info.logPath, evidence + '/seat/' + level + '/server.log');
    if (task.result?.state === 'fail') {
      console.error(readFileSync(fixture.info.logPath, 'utf8'));
      console.error(JSON.stringify((await api('GET', `/api/bots?messages=0`)).body));
      if (observedThread) console.error(JSON.stringify((await api('GET', `/api/threads/${observedThread}/messages?limit=100`)).body));
    }
  } finally { await fixture.close(); }
});
async function createSeat(value: typeof level, idleRoutine = false) {
  level = value;
  const made = await api('POST', '/api/bots', { name: 'Marc fixture chief', section: 'Fixture', modelSelection: { instanceId: idleRoutine ? 'verification' : 'creator', model: idleRoutine ? 'claude-sonnet-5' : 'fake-model' } });
  expect(made.status).toBe(201); const chief = made.body.bot;
  expect((await api('PATCH', `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: 'section', browser: false, computer: 'off', composio: false })).status).toBe(200);
  let sourceThread = chief.threadId;
  if (idleRoutine) {
    const created = await api('POST', '/api/routines', { name: 'Idle Ask seat fixture', prompt: 'Seed routine conversation.', botId: chief.id, enabled: false, permissionMode: 'ask', schedule: { type: 'interval', everyMinutes: 30, anchorAt: Date.now() } });
    expect(created.status).toBe(201); const routineId = created.body.routine.id;
    expect((await api('POST', `/api/routines/${routineId}/run`, {})).status).toBe(201);
    await expect.poll(async () => (await api('GET', '/api/routines')).body.runs.find((r: any) => r.routineId === routineId)?.status, { timeout: 30_000 }).toBe('completed');
    sourceThread = (await api('GET', '/api/routines')).body.routines.find((r: any) => r.id === routineId).threadId;
    // Routine completion is published before the turn releases its settings hold.
    await expect.poll(async () => {
      const changed = await api('PATCH', `/api/bots/${chief.id}/tasks/${sourceThread}`, { modelSelection: { instanceId: 'creator', model: 'fake-model' } });
      if (changed.status === 409) expect(changed.body.error).toBe('Stop this thread before changing its settings');
      return changed.status;
    }, { timeout: 30_000 }).toBe(200);
  }
  const flags = flagsFor(level);
  observedThread = sourceThread;
  const raised = flags.fullAccess
    ? await raiseLevel(api, chief.id, { ...flags, acknowledgeNoLimits: true, acknowledgeFullAccess: true, acknowledgeLocalAuto: true })
    : await api('PATCH', `/api/bots/${chief.id}`, { ...flags, acknowledgeLocalAuto: true });
  expect(raised.status, JSON.stringify(raised.body)).toBe(200);
  if (idleRoutine) {
    expect((await api('PATCH', `/api/bots/${chief.id}/tasks/${sourceThread}`, { ...flags, acknowledgeNoLimits: true, acknowledgeFullAccess: true, acknowledgeLocalAuto: true })).status).toBe(200);
    const stored = JSON.parse(readFileSync(join(fixture.info.dataDir, 'bots.json'), 'utf8')).find((b: any) => b.id === chief.id).tasks.find((t: any) => t.threadId === sourceThread);
    expect(stored).toMatchObject(flagsFor('no-limits'));
  }
  expect((await api('POST', `/api/bots/${chief.id}/messages`, { text: 'Create Marc fixture seat.', threadId: sourceThread })).status).toBe(202);
  if (value === 'ask' || idleRoutine) {
    // Ask requires the owner's actual approval before the specialist exists.
    let answer: { requestId: string; behavior: 'allow'; stateRevision: number } | undefined;
    await expect.poll(async () => {
      const transcript = await api('GET', `/api/threads/${sourceThread}/messages?limit=100`);
      const cards = transcript.body.messages.filter((row: any) => (row.card?.requestHandle || row.card?.requestId) && row.card.answered === undefined);
      expect(cards.length).toBeLessThanOrEqual(1);
      const card = cards[0]?.card;
      if (card) {
        expect(card.kind).toBe('own-write');
        expect(card.writer.tool).toBe('create_bot');
        expect(JSON.stringify(card)).toContain('Marc fixture seat');
        answer = { requestId: card.requestId, behavior: 'allow', stateRevision: card.writer.stateRevision };
      }
      return answer;
    }, { timeout: 30_000 }).toBeDefined();
    expect((await api('POST', `/api/threads/${sourceThread}/respond`, answer)).status).toBe(200);
  }
  const bots = () => JSON.parse(readFileSync(join(fixture.info.dataDir, 'bots.json'), 'utf8')) as any[];
  await expect.poll(() => bots().some(b => b.name === 'Marc fixture seat'), { timeout: 30_000 }).toBe(true);
  writeFileSync(join(fixture.info.dataDir, 'finish-create'), '1');
  await expect.poll(() => bots().find(b => b.name === 'Marc fixture seat')?.staged ?? null, { timeout: 30_000 }).toBeNull();
  const seat = bots().find(b => b.name === 'Marc fixture seat');
  const sourceMessages = await api('GET', `/api/threads/${sourceThread}/messages?limit=100`);
  const commands = [
    ['wait', '--bot', chief.id, '--timeout', '15', '--url', fixture.info.url],
    ['messages', '--bot', chief.id, '--limit', '15', '--url', fixture.info.url],
  ];
  const env = { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir };
  const [wait, messages] = await Promise.all(commands.map(args => runControlMurage(args, { env })));
  mkdirSync(evidence + '/seat/' + level, { recursive: true });
  writeFileSync(evidence + '/seat/' + level + (idleRoutine ? '/idle-routine-observation.json' : '/observation.json'), JSON.stringify({ fixture: fixture.info, seat, sourceThread, sourceMessages, commands, wait, messages }, null, 2));
  return seat;
}
it('a seat created by a No limits chief starts at No limits after activation', async () => {
  const stored = await createSeat('no-limits');
  // MAIN RULING 1115-DIGEST-ADOPTED S7: activation exposes inherited
  // permissions through the canonical API; storage retains implicit provenance.
  expect(stored.permissionExplicit ?? false).toBe(false);
  expect(stored.tasks).toHaveLength(1);
  expect(stored.tasks[0].permissionExplicit).toBe(false);
  const observed = await api('GET', `/api/bots/${stored.id}`);
  expect(observed.status).toBe(200);
  const seat = observed.body.bot;
  expect(seat).toMatchObject({ autoApprove: true, fullAccess: true, noLimits: true });
  expect(seat.tasks).toHaveLength(1);
  expect(seat.tasks[0]).toMatchObject({ autoApprove: true, fullAccess: true, noLimits: true });
  expect(seat).toMatchObject({ computer: 'off', composio: false });
  writeFileSync(evidence + '/seat/no-limits/activation.json', JSON.stringify({ stored, observed: seat }, null, 2));
}, 100_000);

it.each(['ask', 'auto', 'full'] as const)('a chief at %s passes only that level to its activated seat', async value => {
  const seat = await createSeat(value);
  expect(seat).toMatchObject(flagsFor(value));
  expect(seat.tasks).toHaveLength(1);
  expect(seat.tasks[0]).toMatchObject(flagsFor(value));
  expect(seat).toMatchObject({ computer: 'off', composio: false });
}, 100_000);

it('an owner in an idle Ask routine inherits Ask despite stored No limits task flags', async () => {
  const seat = await createSeat('no-limits', true);
  expect(seat).toMatchObject(flagsFor('ask'));
  expect(seat.tasks).toHaveLength(1);
  expect(seat.tasks[0]).toMatchObject(flagsFor('ask'));
}, 120_000);
