// SPDX-License-Identifier: AGPL-3.0-or-later
// The isolated fake driver emits permission data and never executes commands.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';
import { openSse } from './testing/sse.ts';

it('review High workflow: secure removal waits for owner Allow before fake delivery', async () => {
  const evidence = (process.env.MURAGE_TEST_EVIDENCE_DIR ?? '/tmp/murage-test-evidence') + '/secure-removal';
  mkdirSync(evidence, { recursive: true });
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  const replacement = `const command='sudo srm -r /usr';
    emit({type:'request.opened',requestType:'permission',tool:'Bash',summary:command,
      toolCall:{name:'Bash',input:{command,cwd:turn.cwd}},executionCwd:turn.cwd,
      requestId:turnId+'-secure-removal',threadId:turn.threadId,turnId});return;`;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    await import(${JSON.stringify(new URL('./testing/idle-load-preload.mjs', import.meta.url).href)});
    const fs=await import('node:fs'),path=await import('node:path');
    const {registerHooks}=await import('node:module');
    registerHooks({load(url,ctx,next){
      if(url.endsWith('/email/external-marks.ts'))return {format:'module-typescript',shortCircuit:true,
        source:fs.readFileSync(new URL(url),'utf8').replace('COVERED_DRIVERS.has(driverKind)', '(driverKind === "fakeLateTerminal" || COVERED_DRIVERS.has(driverKind))')};
      if(!url.endsWith('/fake-late-terminal-driver.ts'))return next(url,ctx);
      let source=fs.readFileSync(new URL(url),'utf8');
      if(!source.includes(${JSON.stringify(anchor)}))throw Error('fake driver anchor changed');
      source=source.replaceAll(${JSON.stringify(anchor)},${JSON.stringify(replacement)});
      source=source.replace('respondToRequest: async () => "unavailable" as const,',
        'respondToRequest: async (threadId,requestId,response)=>{const entry=active.get(threadId);if(!entry)return {state:"failed"} as const;setTimeout(()=>{emit({type:"item.completed",itemType:"assistant_text",origin:"engine",text:"fixture "+response.behavior,threadId,turnId:entry.turnId});active.delete(threadId);emit({type:"turn.completed",ok:true,threadId,turnId:entry.turnId});},10);return {state:"accepted"} as const;},');
      return {format:'module-typescript',shortCircuit:true,source};
    }});
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL('./drivers/builtIn.ts', import.meta.url).href)});
    const {makeLateTerminalDriver}=await import(${JSON.stringify(new URL('./testing/fake-late-terminal-driver.ts', import.meta.url).href)});
    const fake=makeLateTerminalDriver(),create=fake.create.bind(fake);
    fake.create=async input=>{const instance=await create(input);return {...instance,decisionAdapter:{respondToRequest:instance.adapter.respondToRequest.bind(instance.adapter),interruptTurn:instance.adapter.interruptTurn.bind(instance.adapter)}};};
    BUILT_IN_DRIVERS.push(fake);
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.secure={driver:'fakeLateTerminal'};fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const commands: unknown[] = [];
  let desktop: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { ...desktop, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); commands.push({ method, path, status: response.status });
    expect(response.ok).toBe(true); return result;
  };
  const control = async (command: string, ...args: string[]) => {
    const argv = [command, ...args, '--url', fixture.info.url]; commands.push(argv);
    const result = await runControlMurage(argv, { env: { MURAGE_DATA_DIR: fixture.info.dataDir } });
    writeFileSync(evidence + '/' + command + '-' + commands.length + '.json', JSON.stringify(result, null, 2)); return result as any;
  };
  let stream: Awaited<ReturnType<typeof openSse>> | undefined;
  try {
    writeFileSync(evidence + '/launch.json', JSON.stringify(fixture.info, null, 2));
    expect(await control('doctor')).toMatchObject({ ok: true });
    desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await api('GET', '/api/desktop-secret')).secret };
    const { bot } = await api('POST', '/api/bots', { name: 'Secure removal fixture', modelSelection: { instanceId: 'secure', model: 'late-1' } });
    const raised = await raiseLevel(async (method, path, body) => ({ status: 200, body: await api(method, path, body) }), bot.id,
      { noLimits: true, acknowledgeNoLimits: true, computer: 'off', browser: false, composio: false, autoReview: 'off' });
    expect(raised.status).toBe(200);
    stream = await openSse(fixture.info.url + '/api/events');
    await stream.until(frame => frame.kind === 'hello');
    await api('POST', `/api/bots/${bot.id}/messages`, { text: 'Inert permission fixture', threadId: bot.threadId });
    await stream.until(frame => frame.kind === 'runtime' && frame.event?.type === 'request.opened' && frame.event?.threadId === bot.threadId);
    expect(await control('wait', '--bot', bot.id, '--timeout', '5')).toMatchObject({ status: 'needs-user' });
    await control('messages', '--bot', bot.id, '--limit', '20');
    const before = await api('GET', `/api/threads/${bot.threadId}/messages?limit=40`);
    const card = before.messages.find((message: any) => message.card?.requestHandle && message.card.subtitle === 'sudo srm -r /usr' && !message.card.answered);
    expect(card).toBeTruthy();
    expect(card.card.requestHandle).toMatch(/^p\./);
    const decisions = await api('GET', '/api/decisions?limit=100');
    expect(decisions.decisions).toContainEqual(expect.objectContaining({ threadId: bot.threadId, decision: 'card-shown', source: 'always-ask' }));
    expect(decisions.decisions.some((row: any) => row.threadId === bot.threadId && row.decision === 'auto-approved')).toBe(false);
    writeFileSync(evidence + '/before.json', JSON.stringify({ before, decisions }, null, 2));
    await api('POST', `/api/threads/${bot.threadId}/respond`, { requestHandle: card.card.requestHandle, action: 'allow' });
    expect(await control('wait', '--bot', bot.id, '--timeout', '5')).toMatchObject({ status: 'settled' });
    const after = await control('messages', '--bot', bot.id, '--limit', '20');
    expect(after.messages.some((message: any) => message.text === 'fixture allow')).toBe(true);
  } finally {
    stream?.close();
    await fixture.close();
    writeFileSync(evidence + '/commands.json', JSON.stringify(commands, null, 2));
    writeFileSync(evidence + '/server.log', readFileSync(fixture.info.logPath));
  }
}, 120000);
