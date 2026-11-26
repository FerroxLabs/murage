// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SABLE-IDENTITY-1020 (owner report, 1.0.20): while a revoke on the thread was still being checked, every fresh spawn of a Claude bot was
// refused twice and then sent as the last rebuild with an empty system and no conversation, so the bot answered as the bare model with no
// history, turn after turn. The last rebuild of a turn the owner typed always carries the bot's instructions and the recent lines of its
// own conversation that read shown. Refusals are raised at the real send (sendProjectUsageTurn), the product rebuilds by itself.
// Mutants (SABLE_MUTANT): no-system sends the empty system again; no-replay drops the history again. Each turns both witnesses RED.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';
const mutant = process.env.SABLE_MUTANT ?? '';
const instrumentationSource = `
  const {registerHooks}=await import('node:module');
  registerHooks({load(url,context,next){
   const result=next(url,context);let text=String(result.source);
   if(url.endsWith('/server/index.ts')){
    const swap=(from,to)=>{if(text.split(from).length!==2)throw new Error('fixture anchor not found exactly once: '+from.slice(0,60));text=text.replace(from,to);};
    if(${JSON.stringify(mutant === 'no-system')}){
     swap('system: joinShapeLayers(memoryLastResort || selectiveDropped ? recoverySystemLayers : systemLayers),','system: memoryLastResort || selectiveDropped ? "" : joinShapeLayers(systemLayers),');
     swap('memoryFreeSystem: joinShapeLayers(recoverySystemLayers)','memoryFreeSystem: ""');
    }
    if(${JSON.stringify(mutant === 'no-replay')})swap('lastResortReplay = kept.length > 0;','lastResortReplay = false;');
    const needle='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
    // A send whose prompt carries REFUSE-ME is refused twice per owner message, as a thread still checking a revoke refuses it: the
    // third send of that message is the last rebuild. Every send that goes through is logged whole.
    swap(needle,needle+\`
     if(!built.prewarm){
      const seen=(globalThis.fixtureSeen??=new Map());const n=(seen.get(built.ownerMessageId)??0)+1;seen.set(built.ownerMessageId,n);
      if(String(built.prompt?.text??'').includes('REFUSE-ME')&&n<=2){console.warn('fixture refused send '+n);throw new Error('MEMORY_CONTEXT_REVOKED');}
      console.warn('fixture final fields='+JSON.stringify({system:built.system,text:built.prompt?.text,transcript:built.transcript,resumed:built.recallPrepared?.resumed,recall:built.recall,memoryFree:built.recallPrepared?.memoryFree,tools:Object.keys(built.integrations??{})}));
     }
    \`);
   }
   return {...result,source:text};
  }});
 `;
type Sent = { system: string; text: string; transcript?: { text: string }[]; resumed?: boolean; recall?: string; memoryFree?: boolean; tools: string[] };
const carried = (sent: Sent) => sent.text + '\n' + JSON.stringify(sent.transcript ?? []);
const findId = (value: unknown, text: string): string | undefined => {
  if (Array.isArray(value)) { for (const item of value) { const id = findId(item, text); if (id) return id; } return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.text === text && typeof row.id === 'string' && row.role === 'user') return row.id;
  for (const item of Object.values(row)) { const id = findId(item, text); if (id) return id; }
  return undefined;
};
async function world() {
  const fixture = await launchVerificationServer(process.env, undefined, { separateHome: true, turnLog: { replies: ['Reply one.', 'Reply two.', 'Reply three.', 'Reply four.'] }, instrumentationSource });
  const run = (args: string[]) => runControlMurage([...args, '--url', fixture.info.url], { env: { MURAGE_DATA_DIR: fixture.info.dataDir } }) as Promise<any>;
  const bot = (await run(['new-bot', '--name', 'Fixture persona'])).bot;
  const headers = async () => ({ 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string }).secret });
  const post = async (path: string, text: string) => {
    expect((await fetch(fixture.info.url + `/api/bots/${bot.id}/${path}`, { method: 'POST', headers: await headers(), body: JSON.stringify({ text }) })).status).toBe(202);
    await run(['wait', '--bot', bot.id, '--timeout', '30']);
  };
  const sent = (): Sent[] => [...readFileSync(fixture.info.logPath, 'utf8').matchAll(/fixture final fields=([^\n]+)/g)].map(match => JSON.parse(match[1]!));
  const log = () => readFileSync(fixture.info.logPath, 'utf8');
  return { fixture, run, bot, post, sent, log };
}
const lastRebuild = (sent: Sent, log: string) => {
  expect(sent.recall, log.slice(-6000)).toBe('withheld');
  expect(sent.memoryFree).toBe(true);
  expect(sent.resumed).toBe(false);
  // the memory reader stays out of a turn sent without remembered context
  expect(sent.tools).not.toContain('memory');
};

it('W2 a fresh spawn with recall withheld still carries the bot instructions and the recent turns', async () => {
  const w = await world();
  try {
    await w.post('messages', 'Fixture first input');
    await w.post('messages', 'Fixture follow-up REFUSE-ME');
    const log = w.log(), sent = w.sent();
    expect(sent, log.slice(-9000)).toHaveLength(2);
    expect((log.match(/fixture refused send /g) ?? [])).toHaveLength(2);
    expect((log.match(/\[memory\] starting turn without recalled memory /g) ?? [])).toHaveLength(1);
    lastRebuild(sent[1]!, log);
    expect(sent[1]!.system).toContain('Fixture persona');
    expect(carried(sent[1]!)).toContain('Fixture first input');
    expect(carried(sent[1]!)).toContain('Reply one.');
    expect(sent[1]!.text).toContain('Fixture follow-up REFUSE-ME');
    // the reply landed once, with no refusal card
    const shown = JSON.stringify(await w.run(['messages', '--bot', w.bot.id, '--limit', '30']));
    expect(shown).toContain('Reply two.');
    expect(shown).not.toMatch(/could not start this reply|couldn't start this reply|still being prepared/i);
  } finally { await w.fixture.close(); }
}, 120_000);

it('W1 after an edit the edited turn and the turn after it replay the surviving conversation and keep the instructions', async () => {
  const w = await world();
  try {
    await w.post('messages', 'Fixture first input');
    await w.post('messages', 'Fixture second input');
    const secondId = findId(await w.run(['messages', '--bot', w.bot.id, '--limit', '30']), 'Fixture second input');
    expect(secondId).toBeTruthy();
    await w.post(`messages/${secondId}/edit`, 'Fixture edited input REFUSE-ME');
    await w.post('messages', 'Fixture next input REFUSE-ME');
    const log = w.log(), sent = w.sent();
    expect(sent, log.slice(-9000)).toHaveLength(4);
    expect((log.match(/fixture refused send /g) ?? [])).toHaveLength(4);
    // the edit: a fresh session by construction (the old one holds the replaced message), refused twice, sent as the last rebuild
    const edited = sent[2]!;
    lastRebuild(edited, log);
    expect(edited.system).toContain('Fixture persona');
    expect(carried(edited)).toContain('Fixture first input');
    expect(carried(edited)).toContain('Reply one.');
    expect(edited.text).toContain('Fixture edited input REFUSE-ME');
    // the replaced message and its reply are off the branch: never replayed
    expect(carried(edited)).not.toContain('Fixture second input');
    expect(carried(edited)).not.toContain('Reply two.');
    // the next turn: no session was kept, and it is refused the same way; it still carries the conversation, the edit and its reply included
    const next = sent[3]!;
    lastRebuild(next, log);
    expect(next.system).toContain('Fixture persona');
    for (const line of ['Fixture first input', 'Reply one.', 'Fixture edited input REFUSE-ME', 'Reply three.']) expect(carried(next)).toContain(line);
    expect(carried(next)).not.toContain('Fixture second input');
    expect(next.text).toContain('Fixture next input REFUSE-ME');
  } finally { await w.fixture.close(); }
}, 180_000);
