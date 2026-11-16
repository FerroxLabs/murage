import { describe, expect, it } from 'vitest';
import { EventBus } from './harness/bus.ts';
import type { RuntimeEvent } from './contracts.ts';

// Baseline adapter exercises the actual raw bus rather than missing exports.
function audience(bus: EventBus, listener: (event: unknown) => void) {
  const candidate = bus as EventBus & { subscribeAudience?: (f: (e: { event: unknown }) => void, options: { durable: boolean }) => () => void };
  return candidate.subscribeAudience ? candidate.subscribeAudience(e => listener(e.event), { durable: false }) : bus.subscribe(listener, { durable: false });
}
const fixtures = [
  { type: 'turn.diagnostic', category: 'SECRET' }, { type: 'session.started', model: 'SECRET', sessionId: 'SECRET' },
  { type: 'turn.subtask', subtask: { id: 'SECRET', label: 'SECRET' } }, { type: 'session.exited', reason: 'SECRET' },
  { type: 'turn.started' }, { type: 'turn.retrying', reason: 'SECRET' }, { type: 'turn.completed', ok: true, stopReason: 'SECRET' },
  { type: 'item.started', itemType: 'tool', title: 'SECRET', input: { SECRET: 'SECRET' } },
  { type: 'item.started', itemType: 'reasoning', summary: 'SECRET' },
  { type: 'item.updated', itemType: 'tool', tokens: 1 }, { type: 'item.updated', itemType: 'reasoning', tokens: 1 },
  { type: 'item.completed', itemType: 'tool', result: { SECRET: 'SECRET' } },
  { type: 'item.completed', itemType: 'assistant_text', origin: 'engine', text: 'SECRET' },
  { type: 'item.completed', itemType: 'assistant_image', alt: 'SECRET', data: 'SECRET' },
  { type: 'content.delta', streamKind: 'assistant_text', delta: 'SECRET' },
  { type: 'content.delta', streamKind: 'reasoning_text', delta: 'SECRET' },
  { type: 'content.reset', streamKind: 'assistant_text' }, { type: 'content.reset', streamKind: 'reasoning_text' },
  { type: 'plan.updated', entries: [{ content: 'SECRET', status: 'pending' }] },
  { type: 'engine.commands', commands: [{ name: 'SECRET', description: 'SECRET' }] },
  { type: 'steer.confirmed', interjectionId: 'SECRET' }, { type: 'question.async', questions: [{ id: 'SECRET', question: 'SECRET' }] },
  { type: 'request.opened', requestType: 'permission', tool: 'SECRET', summary: 'SECRET', toolCall: { name: 'SECRET', input: 'SECRET' } },
  { type: 'request.opened', requestType: 'question', summary: 'SECRET', questions: [{ id: 'SECRET', question: 'SECRET' }] },
  { type: 'request.resolved', behavior: 'allow', source: 'user', decidedBy: 'SECRET' },
  { type: 'thread.token-usage.updated', input: 1, output: 1 }, { type: 'turn.served-model', routed: 'SECRET', requested: 'SECRET' },
  { type: 'runtime.error', message: 'SECRET', details: 'SECRET' }, { type: 'unknown.SECRET', unknown: 'SECRET' },
];
describe('manifest serialized intake', () => {
  for (const [index, fields] of fixtures.entries()) {
    const name = `M${String(index + 1).padStart(2, '0')}`;
    it(`manifest.${name}.serialized`, () => {
      const bus = new EventBus(() => {}); bus.omitLog(() => true);
      const seen: unknown[] = []; audience(bus, event => seen.push(event));
      bus.publish({ eventId: 'SECRET', provider: 'fake', threadId: 'fixture-thread', createdAt: 'SECRET', raw: { source: 'SECRET', payload: { SECRET: 'SECRET' } }, ...fields } as RuntimeEvent);
      expect(seen.length).toBeGreaterThan(0);
      expect(JSON.stringify(seen)).not.toContain('SECRET');
      expect(JSON.stringify(seen)).not.toContain('"raw"');
    });
    it(`manifest.${name}.execution-unchanged`, () => {
      const bus = new EventBus(() => {}); bus.omitLog(() => true);
      const event = { eventId: 'original', provider: 'fake', threadId: 'fixture-thread', createdAt: 'now', ...fields } as RuntimeEvent;
      let delivered: unknown; bus.subscribe(e => { delivered = e; }, { durable: false }); bus.publish(event);
      expect(delivered).toBe(event);
    });
  }
});

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, vi } from 'vitest';
import { freePortBlock } from './testing/ports.ts';
import { removeTempDir, waitForExit } from './testing/cleanup.ts';

describe.skipIf(process.platform === 'win32')('R1/R2 real owner response route', () => {
  let child: ChildProcess, home: string, base: string, headers: Record<string, string>;
  let output = '';
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), 'murage-l5a-handles-')); mkdirSync(join(home, '.murage'));
    const cli = fileURLToPath(new URL('./testing/fake-codex-app-server.ts', import.meta.url)); chmodSync(cli, 0o755);
    writeFileSync(join(home, '.murage', 'config.json'), JSON.stringify({ engineDiscovery: 'explicit', instances: {
      live: { driver: 'codex', environment: { FAKE_CODEX_MODE: 'user-input', FAKE_CODEX_DUMP: join(home, 'answers.jsonl') }, config: { cli, fullAuto: true } },
      async: { driver: 'codex', environment: { FAKE_CODEX_MODE: 'async-question', FAKE_CODEX_ASYNC_QUESTION_ONCE: join(home, 'once'), FAKE_CODEX_ASYNC_QUESTION_GATE: join(home, 'release') }, config: { cli, fullAuto: true } },
    } }));
    const capture = join(home, 'capture-adapter.mjs');
    const driverModule = new URL('./drivers/codex.ts', import.meta.url).href;
    writeFileSync(capture, `import { writeFileSync } from 'node:fs';
import { CodexDriver } from ${JSON.stringify(driverModule)};
const create = CodexDriver.create;
CodexDriver.create = async function(...args) {
  const instance = await create.apply(this, args);
  const respond = instance.adapter.respondToRequest;
  instance.adapter.respondToRequest = function(thread, request, answer) {
    if (answer.answers) writeFileSync(${JSON.stringify(join(home, 'adapter-answer.json'))}, JSON.stringify(answer.answers));
    return respond.call(this, thread, request, answer);
  };
  return { ...instance, ...(instance.decisionAdapter ? { decisionAdapter: { ...instance.decisionAdapter,
    respondToRequest: function(thread, request, answer, options) {
      if (answer.answers) writeFileSync(${JSON.stringify(join(home, 'adapter-answer.json'))}, JSON.stringify(answer.answers));
      return instance.decisionAdapter.respondToRequest(thread, request, answer, options);
    } } } : {}) };
};`);
    child = spawn(process.execPath, ['--import', capture, fileURLToPath(new URL('./index.ts', import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
    await vi.waitFor(async () => { expect((await fetch(base + '/api/health')).ok).toBe(true); }, { timeout: 25_000 });
    const proof = await fetch(base + '/api/desktop-secret').then(r => r.json()) as { secret: string };
    headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
  }, 35_000);
  afterAll(async () => { if (child) await waitForExit(child, { signal: 'SIGTERM' }); if (home) await removeTempDir(home); });
  const open = async (instanceId: string) => {
    const created = await request('POST', '/api/bots', { name: 'Handle fixture', modelSelection: { instanceId, model: 'gpt-fake-default' } });
    expect(created.status).toBe(201); const bot = created.body.bot;
    await request('PATCH', `/api/bots/${bot.id}`, { computer: 'off' });
    expect((await request('POST', `/api/bots/${bot.id}/messages`, { text: 'ask me', threadId: bot.threadId })).status).toBe(202);
    let row: any;
    await expect.poll(async () => { row = (await request('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages.find((m: any) => m.card?.questions?.length && !m.card.answered); return Boolean(row); }, { timeout: 20_000 }).toBe(true);
    return { bot, row };
  };
  it('execution.answers-route-original-bytes-and-zero-partial-effects', async () => {
    const { bot, row } = await open('live');
    const action = { requestHandle: `q.${row.id}`, action: 'answer', answers: [
      { questionHandle: 'q.0', optionHandles: ['o.0.1'] },
      { questionHandle: 'q.1', optionHandles: [], other: '  HANDLE_SECRET\nBYTES  ' },
      { questionHandle: 'q.2', optionHandles: [], other: 'Frankfurt' },
    ] };
    const route = `/api/threads/${bot.threadId}/respond`;
    const dump = () => existsSync(join(home, 'answers.jsonl')) ? readFileSync(join(home, 'answers.jsonl'), 'utf8') : '';
    const before = dump();
    expect((await request('POST', route, { ...action, answers: [action.answers[0], action.answers[0], action.answers[2]] })).status).toBe(400);
    expect(dump()).toBe(before);
    expect((await request('POST', route, action)).status).toBe(200);
    await expect.poll(() => dump(), { timeout: 5000 }).toContain('HANDLE_SECRET');
    const received = JSON.parse(readFileSync(join(home, 'adapter-answer.json'), 'utf8'));
    expect(received).toEqual([{ id: 'db', selected: ['Redis'] }, { id: 'token', selected: [], other: '  HANDLE_SECRET\nBYTES  ' }, { id: 'region', selected: [], other: 'Frankfurt' }]);
    expect(JSON.stringify((await request('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).body)).not.toContain('HANDLE_SECRET');
    expect(output).not.toContain('HANDLE_SECRET');
    expect((await request('POST', route, action)).status).toBe(409);
  }, 30_000);
  it('execution.handle-async-question-answer-and-duplicate-submit', async () => {
    const { bot, row } = await open('async');
    const action = { requestHandle: `q.${row.id}`, action: 'answer', answers: [{ questionHandle: 'q.0', optionHandles: ['o.0.0'] }] };
    const route = `/api/threads/${bot.threadId}/respond`;
    expect((await request('POST', route, action)).status).toBe(200);
    expect((await request('POST', route, action)).status).toBe(409);
    const pending = (await request('GET', '/api/bots')).body.pendingSends?.[bot.threadId] ?? [];
    expect(pending.filter((entry: any) => entry.sendId === `ask-${row.id}`)).toHaveLength(1);
    writeFileSync(join(home, 'release'), '');
  }, 30_000);
});
