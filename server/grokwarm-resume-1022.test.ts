// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';
const instrumentationSource = `
  const {registerHooks}=await import('node:module');
  registerHooks({load(url,context,next){
   const result=next(url,context);let text=String(result.source);
   if(url.endsWith('/server/index.ts')){
    const swap=(from,to)=>{if(text.split(from).length!==2)throw new Error('fixture anchor not found exactly once: '+from.slice(0,60));text=text.replace(from,to);};
    const dispatch='  const trace = beginTurnTrace(threadId);';
    swap(dispatch, \`
      if (text === "Fixture history setup") {
        for (let index = 0; index < 60; index++) {
          store.appendMessage(threadId, { role: "user", kind: "text", text: "Historical fixture line " + String(index).padStart(2,"0") });
        }
      }
    \`+dispatch);
    const needle='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
    // Refuse the marked owner message twice. Later prompts can replay the marker without triggering another refusal.
    swap(needle,needle+\`
     if(!built.prewarm){
      const seen=(globalThis.fixtureSeen??=new Map());const n=(seen.get(built.ownerMessageId)??0)+1;seen.set(built.ownerMessageId,n);
      if(built.ownerMessageId && store.messageById(built.threadId,built.ownerMessageId)?.text==='Fixture follow-up REFUSE-ME' && n<=2){console.warn('fixture refused send '+n);throw new Error('MEMORY_CONTEXT_REVOKED');}
      console.warn('fixture final fields='+JSON.stringify({system:built.system,text:built.prompt?.text,transcript:built.transcript,resumed:built.recallPrepared?.resumed,recall:built.recall,memoryFree:built.recallPrepared?.memoryFree,tools:Object.keys(built.integrations??{})}));
     }
    \`);
   }
   return {...result,source:text};
  }});
 `;
type Sent = { system: string; text: string; transcript?: { text: string }[]; resumed?: boolean; recall?: string; memoryFree?: boolean; tools: string[] };
const carried = (sent: Sent) => sent.text + '\n' + JSON.stringify(sent.transcript ?? []);
async function world() {
  const fixture = await launchVerificationServer(process.env, undefined, { separateHome: true, turnLog: { replies: ['Reply one.', 'Reply two.', 'Reply three.', 'Reply four.', 'Reply five.'] }, instrumentationSource });
  const run = (args: string[]) => runControlMurage([...args, '--url', fixture.info.url], { env: { MURAGE_DATA_DIR: fixture.info.dataDir } }) as Promise<any>;
  const bot = (await run(['new-bot', '--name', 'Fixture persona'])).bot;
  const headers = async () => ({ 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string }).secret });
  const post = async (path: string, text: string) => {
    expect((await fetch(fixture.info.url + `/api/bots/${bot.id}/${path}`, { method: 'POST', headers: await headers(), body: JSON.stringify({ text }) })).status).toBe(202);
    await run(['wait', '--bot', bot.id, '--timeout', '30']);
  };
  const configureMemory = async (mode: string) => {
    expect((await fetch(fixture.info.url + '/api/memory/action', {
      method: 'POST', headers: await headers(), body: JSON.stringify({ action: 'configure', mode }),
    })).ok).toBe(true);
  };
  const sent = (): Sent[] => [...readFileSync(fixture.info.logPath, 'utf8').matchAll(/fixture final fields=([^\n]+)/g)].map(match => JSON.parse(match[1]!));
  const log = () => readFileSync(fixture.info.logPath, 'utf8');
  return { fixture, post, configureMemory, sent, log };
}
const lastRebuild = (sent: Sent, log: string) => {
  expect(sent.recall, log.slice(-6000)).toBe('withheld');
  expect(sent.memoryFree).toBe(true);
  expect(sent.resumed).toBe(false);
  // the memory reader stays out of a turn sent without remembered context
  expect(sent.tools).not.toContain('memory');
};


// Control: the fixture engine resumes an ordinary session, so resumed=false below is the product's choice, not the fixture's.
it('control: an ordinary second turn resumes the first turn\'s session', async () => {
  const w = await world();
  try {
    await w.post('messages', 'Fixture first input');
    await w.post('messages', 'Fixture second input');
    const sent = w.sent(), log = w.log();
    expect(sent, log.slice(-9000)).toHaveLength(2);
    expect(sent[1]!.resumed, 'control resumed').toBe(true);
  } finally { await w.fixture.close(); }
}, 120_000);

// The retries here are at the dispatch boundary. They leave the memory check
// settled, so the next owner turn must rebuild with the full authorized history.
it.each(['active', 'off'])('WM-D5 refreshes a settled partial replay with memory %s and resumes the replacement', async mode => {
  const w = await world();
  try {
    await w.configureMemory(mode);
    await w.post('messages', 'Fixture history setup');
    await w.post('messages', 'Fixture follow-up REFUSE-ME');
    await w.post('messages', 'Fixture third input');
    await w.post('messages', 'Fixture fourth input');
    const sent = w.sent(), log = w.log();
    expect(sent, log.slice(-9000)).toHaveLength(4);
    lastRebuild(sent[1]!, log);
    expect(carried(sent[1]!), 'the last rebuild replayed the recent conversation').toContain('Historical fixture line 59');
    expect(carried(sent[1]!), 'the last resort kept only its recent window').not.toContain('Historical fixture line 00');
    expect(log, 'the partial replay cursor took the settled reset').toContain('reason=partial-replay-settled');
    expect(sent[2]!.resumed, 'the settled session was rebuilt').toBe(false);
    expect(carried(sent[2]!), 'the rebuilt session recovered history outside the last-resort window').toContain('Historical fixture line 00');
    expect(sent[3]!.resumed, log.split('\n').filter(line => /continuation |fence recovery|fixture refused|claude dispatch/.test(line)).join('\n')).toBe(true);
  } finally { await w.fixture.close(); }
}, 180_000);
