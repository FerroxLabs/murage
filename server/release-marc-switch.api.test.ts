// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';
const evidence = process.env.RELEASE_GATE_EVIDENCE ?? 'marc-fixture-evidence';
let fixture: VerificationServer, headers: Record<string, string> = {};
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(fixture.info.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() as any };
}
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')); cfg.noLimitsTermsVersion = 2;
    cfg.instances.verification.environment = { ...cfg.instances.verification.environment,
      // Keep the establishing reply text-only. A missing-input tool event
      // correctly taints a session under NOLIMITS-MEANS-IT r4 C2/M5.
      FAKE_CLAUDE_TEXT_ONLY: '1', FAKE_CLAUDE_PERM_TOOL: 'Bash', FAKE_CLAUDE_PERM_INPUT: JSON.stringify({command:"ssh host 'cmd'"}) };
    fs.writeFileSync(file, JSON.stringify(cfg));
  ` });
  const proof = await api('GET', '/api/desktop-secret');
  headers = { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.body.secret };
}, 150_000);
afterAll(async () => {
  if (!fixture) return;
  try {
    mkdirSync(evidence + '/switch', { recursive: true });
    copyFileSync(fixture.info.logPath, evidence + '/switch/server.log');
  } finally { await fixture.close(); }
});
it('switching an existing conversation to No limits updates that conversation', async () => {
  const instances = (await api('GET', '/api/instances')).body.instances;
  const instance = instances.find((i: any) => i.instanceId === 'verification');
  const model = instance.models.options[0].id;
  const made = await api('POST', '/api/bots', { name: 'Marc switch', modelSelection: { instanceId: 'verification', model } });
  expect(made.status).toBe(201); const bot = made.body.bot;
  expect((await api('PATCH', `/api/bots/${bot.id}`, { browser: false, computer: 'off', composio: false })).status).toBe(200);
  // A real fake-engine turn establishes this exact conversation before changing its level.
  expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'Say fixture ready.' })).status).toBe(202);
  await expect.poll(async () => (await api('GET', `/api/bots/${bot.id}`)).body.bot.busy, { timeout: 30_000 }).toBe(false);
  const raised = await raiseLevel(api, bot.id, { autoApprove: true, fullAccess: true, noLimits: true, acknowledgeNoLimits: true, acknowledgeFullAccess: true, acknowledgeLocalAuto: true });
  expect(raised.status, JSON.stringify(raised.body)).toBe(200);
  const observed = (await api('GET', `/api/bots/${bot.id}`)).body.bot;
  // The next turn uses the actual driver permission prompt transport. Its
  // shell command is only a fake tool payload and is never executed.
  expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: '__fixture_permission_tool__' })).status).toBe(202);
  let transcript: any[] = [], cards: any[] = [];
  const deadline = Date.now() + 30_000;
  do {
    transcript = (await api('GET', `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages;
    cards = transcript.filter(m => m.kind === 'options' && m.card?.requestId && !m.card.answered);
    if (cards.length || transcript.some(m => /permission: (allowed|ran without asking|denied|failed)/.test(m.text ?? ''))) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  // Deny unexpected cards only to settle the fixture; retain them as failures.
  for (const row of cards) await api('POST', `/api/threads/${bot.threadId}/respond`, { requestId: row.card.requestId, behavior: 'deny' });
  const commands = [
    ['wait', '--bot', bot.id, '--timeout', '15', '--url', fixture.info.url],
    ['messages', '--bot', bot.id, '--limit', '15', '--url', fixture.info.url],
  ];
  const env = { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir };
  const [wait, messages] = await Promise.all(commands.map(args => runControlMurage(args, { env })));
  mkdirSync(evidence + '/switch', { recursive: true });
  writeFileSync(evidence + '/switch/observation.json', JSON.stringify({ fixture: fixture.info, observed, levelChange: raised, transcript, cards, commands, wait, messages }, null, 2));
  expect(observed).toMatchObject({ autoApprove: true, fullAccess: true, noLimits: true });
  const task = observed.tasks.find((t: any) => t.threadId === bot.threadId);
  expect(task).toBeDefined();
  // Undefined task flags inherit the bot's current level; explicit old flags must not survive.
  expect(task.autoApprove ?? observed.autoApprove).toBe(true);
  expect(task.fullAccess ?? observed.fullAccess).toBe(true);
  expect(task.noLimits ?? observed.noLimits).toBe(true);
  expect(cards).toHaveLength(0);
  expect(transcript.some(m => /permission: (allowed|ran without asking)/.test(m.text ?? ''))).toBe(true);
}, 100_000);
