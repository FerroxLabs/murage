// A real isolated server folds an engine's truncated permission with an invalid
// cwd. The fake driver emits protocol data only; no command is ever executed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { openSse } from './testing/sse.ts';

let fixture: VerificationServer;
let headers: Record<string, string>;
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(fixture.info.url + path, { method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
  return res.json();
}

beforeAll(async () => {
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  const replacement = `emit({ type: 'request.opened', requestType: 'permission', tool: 'Bash', summary: 'echo safe',
    toolCall: { name: 'Bash', input: { cwdInvalid: true } }, toolInputTruncated: true,
    requestId: turnId + '-approval', threadId: turn.threadId, turnId }); return;`;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    await import(${JSON.stringify(new URL('./testing/idle-load-preload.mjs', import.meta.url).href)});
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { registerHooks } = await import('node:module');
    registerHooks({ load(url, ctx, next) {
      if (!url.endsWith('/fake-late-terminal-driver.ts')) return next(url, ctx);
      let source = fs.readFileSync(new URL(url), 'utf8');
      if (!source.includes(${JSON.stringify(anchor)})) throw Error('fixture anchor changed');
      source = source.split(${JSON.stringify(anchor)}).join(${JSON.stringify(replacement)});
      return { format: 'module-typescript', shortCircuit: true, source };
    } });
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL('./drivers/builtIn.ts', import.meta.url).href)});
    const { makeLateTerminalDriver } = await import(${JSON.stringify(new URL('./testing/fake-late-terminal-driver.ts', import.meta.url).href)});
    BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.instances.truncated = { driver: 'fakeLateTerminal' };
    fs.writeFileSync(file, JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json();
  if (!proof || typeof proof !== 'object' || !('secret' in proof) || typeof proof.secret !== 'string') throw new Error('Missing fixture desktop proof');
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 30_000);
afterAll(async () => {
  try {
    if (fixture && process.env.CFIX_EVIDENCE_DIR) {
      mkdirSync(process.env.CFIX_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.CFIX_EVIDENCE_DIR, 'cwd-server.log'), readFileSync(fixture.info.logPath));
    }
  } finally { await fixture?.close(); }
});

it('a truncated owner request with invalid cwd and no complete command keeps its card at No limits', async () => {
  const { bot } = await api('POST', '/api/bots', { name: 'Truncated cwd', modelSelection: { instanceId: 'truncated', model: 'late-1' } });
  await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off' });
  await api('PATCH', `/api/bots/${bot.id}/tasks/${bot.threadId}`, { noLimits: true, acknowledgeNoLimits: true });
  const stream = await openSse(fixture.info.url + '/api/events');
  try {
    await stream.until(frame => frame.kind === 'hello');
    await api('POST', `/api/bots/${bot.id}/messages`, { text: 'Run the fixture', threadId: bot.threadId });
    await stream.until(frame => frame.kind === 'runtime' && frame.event?.type === 'request.opened' && frame.event?.threadId === bot.threadId);
    const env = { MURAGE_URL: fixture.info.url };
    const waited = await runControlMurage(['wait', '--bot', bot.id, '--timeout', '3'], { env });
    const transcript = await runControlMurage(['messages', '--bot', bot.id, '--limit', '20'], { env }) as any;
    // The control transcript intentionally strips request IDs and policy fields.
    const messages = await api('GET', `/api/threads/${bot.threadId}/messages?limit=20`);
    const decisions = await api('GET', '/api/decisions?limit=100');
    if (process.env.CFIX_EVIDENCE_DIR) {
      mkdirSync(process.env.CFIX_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.CFIX_EVIDENCE_DIR, 'cwd-fixture.json'), JSON.stringify({ fixture: fixture.info, waited, transcript, messages, decisions }, null, 2));
      writeFileSync(join(process.env.CFIX_EVIDENCE_DIR, 'cwd-server.log'), readFileSync(fixture.info.logPath));
    }
    expect(waited).toMatchObject({ status: 'needs-user' });
    const card = messages.messages.find((message: any) => message.card?.requestId && message.card.answered === undefined);
    expect(card, JSON.stringify({ waited, transcript })).toBeDefined();
    expect(card.card).toMatchObject({ toolInputTruncated: true, held: "The command's folder is unknown or conflicting.",
      cardClass: { origin: 'owner', noLimits: { initiator: 'owner', n2: true } } });
    expect(decisions.decisions).toContainEqual(expect.objectContaining({ threadId: bot.threadId, decision: 'card-shown', source: 'always-ask' }));
    expect(transcript.messages.some((message: any) => message.tool?.name === 'Approved 1 step (No limits)')).toBe(false);
  } finally {
    await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    stream.close();
  }
}, 20_000);
