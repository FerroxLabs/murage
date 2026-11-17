// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (bounded recovery); consumer owner: recall-smoke (provider delivery).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';
for(const venue of ['bot','channel'] as const)for(const cause of ['double-revoke','selective-drop','unknown-write','scope-denied','no-tools'] as const)it(`S1-T2/T11/T12 ${venue} ${cause}`,async()=>{
 const instrumentationSource=`
  const {registerHooks}=await import('node:module');
  registerHooks({load(url,context,next){
   const result=next(url,context);let text=String(result.source);
   if(url.endsWith('/server/index.ts')){
    if(${JSON.stringify(cause==='selective-drop')}){
     text=text.replace('if (memoryLastResort || selectiveDropped) {','selectiveDropped=true;if (memoryLastResort || selectiveDropped) {');
     text=text.replace('if (roomLastResort || roomSelectiveDropped) roomPrompt =','roomSelectiveDropped=true;if (roomLastResort || roomSelectiveDropped) roomPrompt =');
    }
    if(${JSON.stringify(cause==='no-tools')}){
     text=text.replace('      const directRecallPrepared = {','      for(const key of Object.keys(integrations))delete integrations[key];const directRecallPrepared = {');
     text=text.replace('      const roomRecallPrepared = {','      for(const key of Object.keys(integrations))delete integrations[key];const roomRecallPrepared = {');
    }
    const needle='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
    text=text.replace(needle,needle+\`
     globalThis.fixtureDispatches=(globalThis.fixtureDispatches??0)+1;
     console.warn('fixture dispatch attempt '+globalThis.fixtureDispatches);
     ${cause==='double-revoke'?"if(globalThis.fixtureDispatches<=2)throw new Error('MEMORY_CONTEXT_REVOKED');":cause==='unknown-write'?"if(globalThis.fixtureDispatches===1){fence.invoked?.();throw new RecallPreparationPending();}":cause==='scope-denied'?"throw new Error('MEMORY_SCOPE_DENIED');":''}
     console.warn('fixture final fields='+JSON.stringify({system:built.system,tools:Object.keys(built.integrations??{}),transcript:built.transcript,resumed:built.recallPrepared?.resumed}));
    \`);
   }
   return {...result,source:text};
  }});
 `;
 const fixture=await launchVerificationServer(process.env,undefined,{separateHome:true,turnLog:{replies:['Fixture reply.','Fixture reply.']},instrumentationSource});
 const run=(args:string[])=>runControlMurage([...args,'--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}}) as Promise<any>;
 try{
  const bot=(await run(['new-bot','--name','Fixture persona'])).bot;
  const id=venue==='bot'?bot.id:(await run(['new-channel','--name','Fixture room','--members',bot.id])).channel.id,destination=[`--${venue}`,id];
  for(let n=0;n<(cause==='no-tools'?2:1);n++){
   const {secret}=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
   expect((await fetch(fixture.info.url+`/api/${venue==='bot'?'bots':'groups'}/${id}/messages`,{method:'POST',headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret},body:JSON.stringify({text:n?'Fixture follow-up':'Fixture first input'})})).status).toBe(202);
   await run(['wait',...destination,'--timeout','20']);
  }
  const log=readFileSync(fixture.info.logPath,'utf8');
  const turns=existsSync(fixture.fixtureTurnLogPath)?readFileSync(fixture.fixtureTurnLogPath,'utf8').trim().split('\n').filter(Boolean):[];
  expect(turns,log.slice(-14000)).toHaveLength(cause==='no-tools'?2:0);
  const attempts=(log.match(/fixture dispatch attempt /g)??[]).length;
  if(cause==='unknown-write'||cause==='scope-denied')expect(attempts).toBe(1);
  if(cause==='double-revoke')expect(attempts).toBe(3);
  if(cause==='no-tools'){
   const requests=[...log.matchAll(/fixture final fields=([^\n]+)/g)].map(match=>JSON.parse(match[1]));
   expect(requests).toHaveLength(2);for(const request of requests){expect(request.system).toContain('Fixture persona');expect(request.tools).toEqual([]);}
  }else{
   expect((log.match(/turn dispatch recall=/g)??[])).toHaveLength(0);
   const rows=await run(['messages',...destination,'--limit','30']);
   expect(JSON.stringify(rows)).toContain(cause==='scope-denied'?'MEMORY_SCOPE_DENIED':'This reply is still being prepared, so this message was not sent. Send it again in a moment.');
  }
 }finally{await fixture.close();}
},90_000);
