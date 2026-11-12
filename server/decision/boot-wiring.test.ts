// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { launchVerificationServer, type VerificationServer } from '../../scripts/control-murage.ts';
import { foldScopes } from '../../shared/fold-scopes.ts';

const target = existsSync('/work/docs/verification/README.md') ? '/work/docs/verification/README.md' : resolve('docs/verification/README.md');
let fixture: VerificationServer;
let headers: Record<string, string>;
const evidence: unknown[] = [];
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(fixture.info.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value;
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.MURAGE_GATE_TAP = '1';
    process.env.FAKE_CLAUDE_PERM_TOOL = 'Bash';
    // The fake returns a decision only; it never executes this command.
    process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({ command: ${JSON.stringify('rm -f ')} + ${JSON.stringify(target)} });
    const { RoutineManager } = await import(${JSON.stringify(new URL('../routines.ts', import.meta.url).href)});
    const listRoutines = RoutineManager.prototype.listRoutines;
    RoutineManager.prototype.listRoutines = function (...args) {
      if (new Error().stack?.includes('decisionEngineApproval')) {
        console.error('approval read retained routine history');
        throw new Error('approval read retained routine history');
      }
      return listRoutines.apply(this, args);
    };
  ` });
  const { secret } = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret };
}, 120000);
afterAll(async () => {
  if (process.env.ASKCARDS_EVIDENCE_DIR && fixture) {
    mkdirSync(process.env.ASKCARDS_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.ASKCARDS_EVIDENCE_DIR, 'boot-server.log'), readFileSync(fixture.info.logPath));
    writeFileSync(join(process.env.ASKCARDS_EVIDENCE_DIR, 'boot-results.json'), JSON.stringify({ fixture: fixture.info, evidence }, null, 2));
  }
  await fixture?.close();
});
it.skipIf(process.platform === 'win32')('production routine Ask card names its routine without reading retained run health', async () => {
  const { bot } = await api('POST', '/api/bots', {});
  await api('PATCH', `/api/bots/${bot.id}`, { autoApprove: false, fullAccess: false, computer: 'off', browser: false, composio: false, autoReview: 'off' });
  const { routine } = await api('POST', '/api/routines', {
    name: 'Synthetic approval routine', prompt: '__fixture_permission_tool__', botId: bot.id,
    enabled: false, permissionMode: 'ask', runOn: 'ember', timeoutMinutes: 5,
    schedule: { type: 'interval', everyMinutes: 30, anchorAt: Date.now() },
  });
  const started = await api('POST', `/api/routines/${routine.id}/run`, {});
  let run: any;
  await expect.poll(async () => {
    run = (await api('GET', '/api/routines')).runs.find((row: any) => row.id === started.run.id);
    return run?.threadId;
  }, { timeout: 10000 }).toBeTruthy();
  let message: any;
  await expect.poll(async () => {
    message = (await api('GET', `/api/threads/${run.threadId}/messages`)).messages.find((row: any) => row.kind === 'options' && row.card?.requestId);
    return message?.card?.grantRequest?.routine;
  }, { timeout: 20000 }).toMatchObject({ routineId: routine.id, routineName: routine.name });
  evidence.push({ routine, run, message });
  expect(readFileSync(fixture.info.logPath, 'utf8')).not.toContain('approval read retained routine history');
  await api('POST', `/api/threads/${run.threadId}/respond`, { requestId: message.card.requestId, behavior: 'deny' });
});
it.skipIf(process.platform === 'win32').each(['allow', 'task', 'deny'] as const)('production boot: Ask returns a card with 1.0.18 choices and delivers %s', async choice => {
  let { bot } = await api('POST', '/api/bots', {});
  await api('PATCH', `/api/bots/${bot.id}`, { autoApprove: false, fullAccess: false, computer: 'off', browser: false, composio: false, autoReview: 'off' });
  bot = (await api('GET', `/api/bots/${bot.id}`)).bot;
  await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: '__fixture_permission_tool__' });
  let message: any;
  let decision: any;
  await expect.poll(async () => {
    const events = readFileSync(join(fixture.info.dataDir, 'decision-gate.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const registered = events.find(event => event.threadId === bot.threadId && event.type === 'registered');
    const decided = events.find(event => event.requestKey === registered?.requestKey && event.type === 'decided');
    if (!decided) return undefined;
    decision = decided;
    return true;
  }, { timeout: 20000 }).toBe(true);
  evidence.push({ choice, decision, messages: (await api('GET', `/api/threads/${bot.threadId}/messages`)).messages });
  expect(decision.kind).toBe('card');
  await expect.poll(async () => {
    message = (await api('GET', `/api/threads/${bot.threadId}/messages`)).messages.find((row: any) => row.kind === 'options' && row.card?.tool === 'Bash' && row.card?.requestId);
    return !!message;
  }, { timeout: 10000 }).toBe(true);
  evidence.push({ choice, message });
  expect(readFileSync(fixture.info.logPath, 'utf8')).toContain('[decision] engine approval builder installed');
  const card = message.card;
  // 1.0.18 stores Allow/Deny; the task choice is rendered from the scoped key.
  expect(card.options).toEqual(['Allow', 'Deny']);
  expect(card.title).toBe('Approval needed');
  expect(card.taskAllowKey).toBe(`stop:delete:${dirname(realpathSync(target)).replaceAll('\\', '/')}`);
  expect(foldScopes(card.cardClass, card).some(row => row.scope === 'task' && row.keys.includes(card.taskAllowKey))).toBe(true);
  const reply = await api('POST', `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: choice === 'deny' ? 'deny' : 'allow', ...(choice === 'task' ? { allowForTask: true } : {}) });
  expect(reply.outcome).toBe(choice === 'deny' ? 'rejected' : 'allowed-once');
  if (choice === 'task') expect(reply.taskAdded).toEqual([card.taskAllowKey]);
  await expect.poll(async () => (await api('GET', `/api/threads/${bot.threadId}/messages`)).messages.some((row: any) => row.text === `permission: ${choice === 'deny' ? 'denied' : 'allowed'}`), { timeout: 15000 }).toBe(true);
});
