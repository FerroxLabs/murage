// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { openSse } from './testing/sse.ts';

let fixture: VerificationServer;
let headers: Record<string, string>;
const commands: unknown[] = [];
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  commands.push({ method, path, body, status: response.status });
  expect(response.ok).toBe(true);
  return response.json();
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.FAKE_CLAUDE_MODE='happy';
    process.env.FAKE_CLAUDE_PERM_TOOL='Bash';
    process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify({command:'printf fixture > /etc/fixture-policy',cwd:'/tmp'});
    const fs=await import('node:fs'),{registerHooks}=await import('node:module');
    registerHooks({load(url,context,next){
      if(!url.endsWith('/server/index.ts'))return next(url,context);
      const source=fs.readFileSync(new URL(url),'utf8');
      const anchor='const { gate: folderTrustGate, onFolderPolicyApplied } =';
      if(!source.includes(anchor))throw Error('D1 service observer anchor moved');
      return {format:'module-typescript',shortCircuit:true,source:source.replace(anchor,"store.appendMessage(threadId,{role:'bot',kind:'text',text:'service-no-limits:'+servicePermissions.serviceNoLimits(run.generation,threadId,bot.id)});"+anchor)};
    }});
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 120000);
afterAll(async () => {
  mkdirSync('evidence/gnl-r3', { recursive: true });
  if (fixture) {
    writeFileSync('evidence/gnl-r3/d1-workflow.json', JSON.stringify({ fixture: fixture.info, commands }, null, 2));
    writeFileSync('evidence/gnl-r3/d1-server.log', readFileSync(fixture.info.logPath));
  }
  await fixture?.close();
});
it.each([false, true])('D1 lower bot with owner task No limits=%s preserves task precedence and service authority', async explicitTask => {
  const model=(await api('GET','/api/instances')).instances.find((x:any)=>x.instanceId==='verification').models.options[0].id;
  const { bot } = await api('POST', '/api/bots', { name: 'D1 owner task ' + explicitTask, modelSelection: { instanceId: 'verification', model } });
  await api('PATCH', `/api/bots/${bot.id}`, { autoApprove: false, fullAccess: false, noLimits: false, computer: 'off', browser: false, composio: false, autoReview: 'off' });
  if (explicitTask) await api('PATCH', `/api/bots/${bot.id}/tasks/${bot.threadId}`, { noLimits: true, acknowledgeNoLimits: true });
  const stream = await openSse(fixture.info.url + '/api/events');
  try {
    await stream.until(frame => frame.kind === 'hello');
    await api('POST', `/api/bots/${bot.id}/messages`, { text: '__fixture_permission_tool__ D1 protected write fixture', threadId: bot.threadId });
    await stream.until(frame => frame.kind === 'runtime' && frame.event?.type === 'request.opened' && frame.event?.threadId === bot.threadId);
    const waited = await runControlMurage(['wait', '--bot', bot.id, '--timeout', '5', '--url', fixture.info.url]);
    const messages = await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`);
    commands.push({ explicitTask, waited, messages });
    expect.soft(messages.messages.some((m: any) => m.text === 'service-no-limits:' + explicitTask)).toBe(true);
    expect.soft(waited).toMatchObject({ status: explicitTask ? 'settled' : 'needs-user' });
    expect.soft(messages.messages.filter((m: any) => m.card?.requestId && !m.card.answered)).toHaveLength(explicitTask ? 0 : 1);
    expect(messages.messages.some((m: any) => m.text === 'permission: allowed')).toBe(explicitTask);
  } finally {
    await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    stream.close();
  }
}, 60000);
