// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (held preparation); consumer owner: recall-smoke (real adapter boundary).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';
for(const venue of ['bot','channel'] as const)for(const race of ['pin','stop','index'] as const)it(race==='index'?`held ${venue}: unknown pins run the verified owner held, without recall, and say so`:`held ${venue}: ${race} before submission never reaches the provider`,async()=>{
 const instrumentationSource=`
  const {registerHooks}=await import('node:module');
  registerHooks({load(url,context,next){
   const result=next(url,context);let text=String(result.source);
   if(url.endsWith('/server/memory/recall-view.ts')){
    const needle="export function resolveRecallView(binding: RecallViewBinding, roster: MemoryRoster, issued = false): Held {";
    if(!text.includes(needle))throw new Error("fixture anchor missing: resolveRecallView");
    text=text.replace(needle,needle+${JSON.stringify(race==='stop'?"if(!globalThis.fixtureLatePublished)throw new RecallPreparationPending();":"throw new RecallPreparationPending();")});
   }
   if(url.endsWith('/server/memory/recall-readiness.ts')){
    text=text.replace('const empty = noPins();',${JSON.stringify("console.warn('fixture readiness wait');"+(race==='index'?"database().exec('DROP INDEX IF EXISTS memory_records_pinned');":race==='stop'?"if(!globalThis.fixturePublishTimer){globalThis.fixturePublishTimer=true;setTimeout(()=>{globalThis.fixtureLatePublished=true;console.warn('fixture published after Stop');},500);}":'')+"const empty = noPins();")});
   }
   if(url.endsWith('/server/index.ts')){
    const needle='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
    text=text.replace(needle,needle+${JSON.stringify(race==='pin'?`database().prepare("INSERT OR IGNORE INTO memory_records SELECT 'fixture-racing-pin',1,id,'constraint','Fixture rule','owner-statement','active',1,1,NULL,NULL,1 FROM memory_scopes WHERE kind='bot' LIMIT 1").run();console.warn('fixture pin created before write');`:'')});
   }
   return {...result,source:text};
  }});
  ${race==='stop'?`await import(${JSON.stringify(new URL('./memory/settle-target.ts',import.meta.url).href)});
  const {database}=await import(${JSON.stringify(new URL('./database.ts',import.meta.url).href)});const {ensureScope}=await import(${JSON.stringify(new URL('./memory/policy.ts',import.meta.url).href)});const scope=ensureScope('bot','fixture-unrelated');database().prepare("INSERT INTO memory_records VALUES('fixture-wait-pin',1,?,'constraint','Fixture rule','owner-statement','active',1,1,NULL,NULL,1)").run(scope);`:''}
 `;
 const fixture=await launchVerificationServer(process.env,undefined,{separateHome:true,turnLog:{replies:['Fixture reply.']},instrumentationSource});
 const run=(args:string[])=>runControlMurage([...args,'--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}}) as Promise<any>;
 try{
  const bot=(await run(['new-bot','--name','Fixture reader'])).bot;
  const id=venue==='bot'?bot.id:(await run(['new-channel','--name','Fixture room','--members',bot.id])).channel.id;
  const destination=[`--${venue}`,id];
  if(race==='stop')await run([venue==='bot'?'send':'send-channel',...destination,'--text','Fixture guarded request']);
  else {const {secret}=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};expect((await fetch(fixture.info.url+`/api/${venue==='bot'?'bots':'groups'}/${id}/messages`,{method:'POST',headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret},body:JSON.stringify({text:'Fixture guarded request'})})).status).toBe(202);}
  if(race==='stop'){
   await expect.poll(()=>readFileSync(fixture.info.logPath,'utf8').includes('fixture readiness wait'),{timeout:1000,interval:10}).toBe(true);
   await run(['interrupt',...destination]);
  }
  await run(['wait',...destination,'--timeout','10']);
  // Waiting past the old deadline also proves that a detached waiter cannot resume a stopped send.
  if(race==='stop')await new Promise(resolve=>setTimeout(resolve,2100));
  const log=readFileSync(fixture.info.logPath,'utf8');
  expect(log).toContain(race==='pin'?'fixture pin created before write':'fixture readiness wait');
  expect(log).not.toContain('starting turn without recalled memory');
  const turns=existsSync(fixture.fixtureTurnLogPath)?readFileSync(fixture.fixtureTurnLogPath,'utf8').trim():'';
  const rows=JSON.stringify(await run(['messages',...destination,'--limit','30']));
  if(race==='index'){
   // OWNERFB 1020 (MAIN 07:24Z): a missing pin index means the pins are unknown. The verified owner's turn is no longer refused:
   // it runs held, exactly once, with no memory mount and nothing recalled, and the owner is told that pinned rules were not used.
   // Non-owners keep the unchanged pins-present-or-unknown refusal branch (OWNERFB-W3 witnesses it with pins present).
   const sent=turns.split('\n').filter(Boolean).map(line=>JSON.parse(line) as {servers?:string[]});
   expect(sent,log.slice(-8000)).toHaveLength(1);
   expect(sent[0].servers).toContain('agents');expect(sent[0].servers).not.toContain('memory');
   expect((log.match(/turn dispatch recall=held/g)??[])).toHaveLength(1);
   expect((log.match(/turn dispatch recall=(?!held)/g)??[])).toHaveLength(0);
   expect(rows).toContain("didn't use what I remember or my pinned rules");
   expect(rows).not.toContain('pinned memory is still being prepared');
   return;
  }
  expect(turns).toBe('');
  expect((log.match(/turn dispatch recall=/g)??[])).toHaveLength(0);
  if(race==='stop'){expect(log).toContain('fixture published after Stop');expect(rows).not.toContain('pinned memory is still being prepared');expect(rows).not.toContain('This reply is still being prepared');}
  else expect(rows).toContain('pinned memory is still being prepared');
 }finally{await fixture.close();}
},60_000);
