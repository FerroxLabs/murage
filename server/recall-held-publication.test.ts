// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (held access prohibition); consumer owner: recall-smoke (request and thread effects).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';
for(const venue of ['bot','channel'] as const)for(const race of ['publication','mode-change','view-lost','held-pending'] as const)it(`S1-T4/T5/T9 ${venue} ${race}`,async()=>{
 const instrumentationSource=`
  const {registerHooks}=await import('node:module');
  registerHooks({load(url,context,next){
   const result=next(url,context);let text=String(result.source);
   if(url.endsWith('/server/memory/recall-view.ts')){
    const needle='export function resolveRecallView(binding: RecallViewBinding, roster: MemoryRoster): Held {';
    text=text.replace(needle,needle+${JSON.stringify(race==='view-lost'?"try{const current=cache(database(),roster).get(recallContextKey(binding));if(!current)throw Error('cold');assertRecallView(database(),current.handle,binding);}catch{prepareRecallContextSync(binding.botId,binding.threadId,roster,binding.notOwnerAudience);}":"if(!globalThis.fixturePublished || "+JSON.stringify(race==='held-pending')+")throw new RecallPreparationPending();try{const current=cache(database(),roster).get(recallContextKey(binding));if(!current)throw Error('cold');assertRecallView(database(),current.handle,binding);}catch{prepareRecallContextSync(binding.botId,binding.threadId,roster,binding.notOwnerAudience);}")});
   }
   if(url.endsWith('/server/memory/recall-readiness.ts'))text=text.replace('this.readmitted = true;',"this.readmitted = true;console.warn('fixture readmission');");
   if(url.endsWith('/server/index.ts')){
    text=text.replace('function turnMemoryAccess(botId: string, threadId: string, generation: string): MemoryAccess {', 'function turnMemoryAccess(botId: string, threadId: string, generation: string): MemoryAccess {if(globalThis.fixtureHeld)console.warn("fixture forbidden memory access");');
    const mode=${JSON.stringify(venue==='bot'?'const directMemoryMode = opts?.recallHeld ? "paused" : directStoredMemoryMode;':'const roomMemoryMode = recallHeld ? "paused" : roomStoredMemoryMode;')};
    text=text.replace(mode,mode+\`
      globalThis.fixtureHeld=${venue==='bot'?'Boolean(opts?.recallHeld)':'recallHeld'};
      if(globalThis.fixtureHeld){
       globalThis.fixturePublished=true;
       globalThis.fixturePrepare(bot.id,threadId,store,${venue==='bot'?'memoryNotOwner':'!roomOwnerAudience'});
       ${race==='mode-change'?"globalThis.fixturePause();":''}
       console.warn('fixture held publication rebuilds='+${venue==='bot'?'(opts?.memoryRedispatch??0)':'memoryRedispatch'});
      }
    \`);
    if(${JSON.stringify(race==='view-lost')}){
     const assembly=${JSON.stringify(venue==='bot'?'const {access,earlyVerdictHolds}=dispatchAccess(':'roomReader = finalizeRoomReader([], access.view);')};
     text=text.replace(assembly,\`if(!globalThis.fixtureLost){globalThis.fixtureLost=true;console.warn('fixture view lost during assembly');throw new RecallPreparationPending();}\`+assembly);
    }
    const dispatch='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
    text=text.replace(dispatch,dispatch+\`console.warn('fixture request='+JSON.stringify({system:built.system,tools:Object.keys(built.integrations??{}),memory:Boolean(built.memoryContext),recall:built.recall,transcript:built.transcript,prompt:built.prompt.text}));${race==='held-pending'?"if(built.recall==='held')throw new RecallPreparationPending();":''}\`);
   }
   return {...result,source:text};
  }});
  await import(${JSON.stringify(new URL('./memory/settle-target.ts',import.meta.url).href)});
  const {database}=await import(${JSON.stringify(new URL('./database.ts',import.meta.url).href)});
  const {ensureScope}=await import(${JSON.stringify(new URL('./memory/policy.ts',import.meta.url).href)});
  const {prepareRecallContextSync}=await import(${JSON.stringify(new URL('./memory/recall-view.ts',import.meta.url).href)});
  const {setMemoryMode}=await import(${JSON.stringify(new URL('./memory/repository.ts',import.meta.url).href)});
  globalThis.fixturePrepare=prepareRecallContextSync;globalThis.fixturePause=()=>setMemoryMode('paused');
  const scope=ensureScope('bot','fixture-unrelated');database().prepare("INSERT INTO memory_records VALUES('fixture-record',1,?,'constraint','Fixture unpinned memory','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
 `;
 const fixture=await launchVerificationServer(process.env,undefined,{separateHome:true,turnLog:{replies:['Fixture reply.','Fixture reply.']},instrumentationSource});
 const run=(args:string[])=>runControlMurage([...args,'--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}}) as Promise<any>;
 try{
  const bot=(await run(['new-bot','--name','Fixture persona'])).bot;
  const id=venue==='bot'?bot.id:(await run(['new-channel','--name','Fixture room','--members',bot.id])).channel.id,destination=[`--${venue}`,id];
  for(let n=0;n<2;n++){
   const {secret}=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
   expect((await fetch(fixture.info.url+`/api/${venue==='bot'?'bots':'groups'}/${id}/messages`,{method:'POST',headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret},body:JSON.stringify({text:n?'Fixture follow-up':'Fixture first input'})})).status).toBe(202);
   await run(['wait',...destination,'--timeout','20']);
  }
  const log=readFileSync(fixture.info.logPath,'utf8');
  const turns=existsSync(fixture.fixtureTurnLogPath)?readFileSync(fixture.fixtureTurnLogPath,'utf8').trim().split('\n').filter(Boolean):[];
  expect(turns,log.slice(-14000)).toHaveLength(race==='held-pending'?0:2);
  const requests=[...log.matchAll(/fixture request=([^\n]+)/g)].map(match=>JSON.parse(match[1]));
  expect(requests).toHaveLength(2);
  for(const request of requests){expect(request.system).toContain('Fixture persona');expect(request.tools).toContain('agents');}
  expect(log).not.toContain('fixture forbidden memory access');expect(log).not.toContain('starting turn without recalled memory');
  const rows=await run(['messages',...destination,'--limit','50']);
  expect(JSON.stringify(rows)).not.toContain('MEMORY_RECALL_UNAVAILABLE');
  if(race==='publication'){
   expect(requests[0].recall).toBe('held');expect(requests[0].memory).toBe(false);expect(requests[0].tools).not.toContain('memory');expect(requests[1].recall).toBe('full');expect(log).toContain('fixture held publication rebuilds=0');
   expect(rows.messages.filter((row:any)=>row.tool?.name==='Memory is still catching up, so this reply did not use recalled memories.')).toHaveLength(1);
  }
  if(race==='held-pending'){expect(JSON.stringify(rows)).toContain('This reply is still being prepared, so this message was not sent. Send it again in a moment.');expect((log.match(/turn dispatch recall=/g)??[])).toHaveLength(0);}
  if(race==='mode-change')expect(requests.every(request=>request.recall==='off')).toBe(true);
  if(race==='view-lost'){expect(log).toContain('fixture view lost during assembly');expect((log.match(/fixture readmission/g)??[])).toHaveLength(1);}
 }finally{await fixture.close();}
},90_000);
