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
      source=source.replace('respondToRequest: async () => "unavailable" as const,',
        'respondToRequest: async (threadId, requestId, response) => { const entry=active.get(threadId); if(!entry)return {state:"failed"} as const; setTimeout(()=>{emit({type:"item.completed",itemType:"assistant_text",origin:"engine",text:"fixture "+response.behavior,threadId,turnId:entry.turnId}); active.delete(threadId); emit({type:"turn.completed",ok:true,threadId,turnId:entry.turnId});},10); return {state:"accepted"} as const; },');
      return { format: 'module-typescript', shortCircuit: true, source };
    } });
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL('./drivers/builtIn.ts', import.meta.url).href)});
    const { makeLateTerminalDriver } = await import(${JSON.stringify(new URL('./testing/fake-late-terminal-driver.ts', import.meta.url).href)});
    const fake=makeLateTerminalDriver(),create=fake.create.bind(fake);
    fake.create=async input=>{const instance=await create(input);return {...instance,decisionAdapter:{respondToRequest:instance.adapter.respondToRequest.bind(instance.adapter),interruptTurn:instance.adapter.interruptTurn.bind(instance.adapter)}};};
    BUILT_IN_DRIVERS.push(fake);
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

it('a truncated owner request with invalid cwd and no complete command runs without a card at No limits', async () => {
  const { bot } = await api('POST', '/api/bots', { name: 'Truncated cwd', modelSelection: { instanceId: 'truncated', model: 'late-1' } });
  await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off' });
  await api('PATCH', `/api/bots/${bot.id}/tasks/${bot.threadId}`, { noLimits: true, acknowledgeNoLimits: true });
  const stream = await openSse(fixture.info.url + '/api/events');
  try {
    await stream.until(frame => frame.kind === 'hello');
    await api('POST', `/api/bots/${bot.id}/messages`, { text: 'Run the fixture', threadId: bot.threadId });
    await stream.until(frame => frame.kind === 'runtime' && frame.event?.type === 'request.opened' && frame.event?.threadId === bot.threadId);
    const env = { MURAGE_URL: fixture.info.url, MURAGE_DATA_DIR:fixture.info.dataDir };
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
    expect(waited).toMatchObject({ status: 'settled' });
    expect(messages.messages.filter((message:any)=>message.card?.requestId&&!message.card?.answered)).toHaveLength(0);
    expect(decisions.decisions.filter((row:any)=>row.threadId===bot.threadId&&row.decision==='card-shown')).toHaveLength(0);
    expect(decisions.decisions.filter((row:any)=>row.threadId===bot.threadId&&row.decision==='auto-approved')).toEqual([expect.objectContaining({source:'no-limits'})]);
    expect(transcript.messages.some((message:any)=>message.tool?.name==='Approved 1 step (No limits)')).toBe(true);
  } finally {
    await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    stream.close();
  }
}, 20_000);
