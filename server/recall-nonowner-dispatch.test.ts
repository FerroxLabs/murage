// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (refusal classification); consumer owner: recall-smoke (audience-safe thread rows).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';
for(const venue of ['bot','channel'] as const)for(const error of ['MemoryPinProjectionPending','MemoryPinSetTooLarge','RecallDispatchPending'] as const)it(`S1-T13 ${venue} non-owner ${error} gets only the generic refusal`,async()=>{
 const instrumentationSource=`
 const {registerHooks}=await import('node:module');
 registerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/server/index.ts'))return result;
 const needle='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
 return {...result,source:String(result.source).replace(needle,needle+"console.warn('fixture non-owner refusal');throw new globalThis.fixtureRefusal();")};}});
 await import(${JSON.stringify(new URL('./memory/settle-target.ts',import.meta.url).href)});
 const types=await import(${JSON.stringify(new URL(error==='RecallDispatchPending'?'./memory/recall-readiness.ts':'./memory/recall-recovery.ts',import.meta.url).href)});
 globalThis.fixtureRefusal=types[${JSON.stringify(error)}];
 `;
 const fixture=await launchVerificationServer(process.env,undefined,{separateHome:true,turnLog:{replies:['Fixture reply.']},instrumentationSource});
 const run=(args:string[])=>runControlMurage([...args,'--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}}) as Promise<any>;
 try{
  const bot=(await run(['new-bot','--name','Fixture persona'])).bot;
  const id=venue==='bot'?bot.id:(await run(['new-channel','--name','Fixture room','--members',bot.id])).channel.id,destination=[`--${venue}`,id];
  // The control surface is not the authenticated desktop owner audience.
  await run([venue==='bot'?'send':'send-channel',...destination,'--text','Fixture input']);
  await run(['wait',...destination,'--timeout','20']);
  const rows=JSON.stringify(await run(['messages',...destination,'--limit','30']));
  expect(rows).toContain("Murage couldn't start this reply. Send it again.");
  expect(rows).not.toContain('pinned memory');expect(rows).not.toContain('pinned memories');expect(rows).not.toContain('still being prepared');
  const log=readFileSync(fixture.info.logPath,'utf8');expect(log).toContain('fixture non-owner refusal');expect(log).not.toContain('turn dispatch recall=');
  expect(existsSync(fixture.fixtureTurnLogPath)?readFileSync(fixture.fixtureTurnLogPath,'utf8').trim():'').toBe('');
 }finally{await fixture.close();}
},60_000);
