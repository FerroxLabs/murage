import { noLimitsEvidence } from './testing/no-limits-evidence.ts';
const captureDir=noLimitsEvidence('wipe-fold-r2');
// SPDX-License-Identifier: AGPL-3.0-or-later
// The isolated fake engine emits permission data; deletion commands never run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { openSse } from './testing/sse.ts';
import { fixtureMessageEvidence } from './testing/display-fixture.ts';
import { join } from 'node:path';
let fixture:VerificationServer;
let headers:Record<string,string>;
const evidence=captureDir;
mkdirSync(evidence,{recursive:true});
const commands:unknown[]=[];
async function api(method:string,path:string,body?:unknown):Promise<any>{
 const res=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 commands.push({method,path,body,status:res.status});expect(res.ok).toBe(true);return res.json();
}
beforeAll(async()=>{
 const anchor='emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
 const replacement=`const variant=JSON.stringify(turn.prompt ?? turn.text);
  let command=variant.includes('safe-shell') ? "bash -o pipefail -c 'ls'" : variant.includes('cluster-shell') ? "bash -euo pipefail -c 'rm -rf ~'" : "bash -o pipefail -c 'git clean -fdx'";
  if(variant.includes('script')){
   // Seed this fake engine's current-turn journal with its emitted turn ID.
   // This fixture checks permission decisions, not provider turn-ID binding.
   r2Marks.beginOutsideTurn(turn.threadId,input.instanceId,turnId,false,r2Marks.turnBegunAt(turn.threadId));
   const file=r2Path.join(turn.cwd,'cleanup');
   const header=variant.includes('weird-script') ? '#!/weird/interp' : '#!/usr/bin/env -vSpython3';
   const body=variant.includes('safe-script') ? "print('hi')" : variant.includes('weird-script') ? "os.remove('/x')" : "import shutil; shutil.rmtree('/archive/backups')";
   r2Fs.writeFileSync(file,header+'\\n'+body);
   const key=r2Marks.outsideTurnKey(turn.threadId);
   if(!key)throw Error('fixture has no live turn journal');
   r2Scripts.noteTurnScriptWrites(turn.threadId,input.instanceId,key,[file]);
   r2Fs.appendFileSync(r2Path.join(process.env.MURAGE_DATA_DIR,'script-states.jsonl'),JSON.stringify({thread:turn.threadId,provider:input.instanceId,turn:turnId,key,tracked:r2Scripts.turnWrittenScripts(turn.threadId,input.instanceId,key).has(file)})+'\\n');
   command='./cleanup';
  }
  emit({type:'request.opened',requestType:'permission',tool:'Bash',summary:command,toolCall:{name:'Bash',input:{command,cwd:turn.cwd}},requestId:turnId+'-approval',threadId:turn.threadId,turnId});return;`;
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  await import(${JSON.stringify(new URL('./testing/idle-load-preload.mjs',import.meta.url).href)});
  const fs=await import('node:fs');const path=await import('node:path');const {registerHooks}=await import('node:module');
  registerHooks({load(url,ctx,next){
   if(url.endsWith('/server/harness/registry.ts')){
    const result=next(url,ctx);
    // Give only this fake engine the strict delivery capability required by
    // production. All permission decisions still use the production gate.
    return {...result,source:String(result.source)+\`
     const fixtureGet=ProviderRegistry.prototype.get;
     ProviderRegistry.prototype.get=function(id){const instance=fixtureGet.call(this,id);
      if(instance?.driverKind==='fakeLateTerminal'&&!instance.decisionAdapter){
       Object.defineProperty(instance.adapter,'capabilities',{value:{...instance.adapter.capabilities,queueing:false}});
       const answered=new Map();Object.defineProperty(instance,'decisionAdapter',{value:{
        respondToRequest:async(t,r,a,o)=>{if(answered.has(r))return {state:answered.get(r)===o.answerId?'already':'failed'};
         const value=await instance.adapter.respondToRequest(t,r,a);if(value==='unavailable')return {state:'failed'};
         answered.set(r,o.answerId);return {state:'accepted'};},
        interruptTurn:(...args)=>instance.adapter.interruptTurn(...args),onPostureChange:async()=>{}
       }});
      }return instance;
     };
    \`};
   }
   if(url.endsWith('/email/external-marks.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace('COVERED_DRIVERS.has(driverKind)','(driverKind === "fakeLateTerminal" || COVERED_DRIVERS.has(driverKind))')};
   if(!url.endsWith('/fake-late-terminal-driver.ts'))return next(url,ctx);
   let source="import * as r2Fs from 'node:fs'; import * as r2Path from 'node:path'; import * as r2Scripts from '../no-limits-wipe-scripts.ts'; import * as r2Marks from '../email/external-marks.ts';\\n"+fs.readFileSync(new URL(url),'utf8');
   if(!source.includes(${JSON.stringify(anchor)}))throw Error('fixture anchor changed');
   source=source.replaceAll(${JSON.stringify(anchor)},${JSON.stringify(replacement)});
   source=source.replace('respondToRequest: async () => "unavailable" as const,','respondToRequest: async (threadId,requestId,response) => { const entry=active.get(threadId);if(!entry)return "unavailable" as const;emit({type:"item.completed",itemType:"assistant_text",origin:"engine",text:"fixture "+response.behavior,threadId,turnId:entry.turnId});active.delete(threadId);emit({type:"turn.completed",ok:true,threadId,turnId:entry.turnId});return "applied" as const; },');
   return {format:'module-typescript',shortCircuit:true,source};
  }});
  const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL('./drivers/builtIn.ts',import.meta.url).href)});
  const {makeLateTerminalDriver}=await import(${JSON.stringify(new URL('./testing/fake-late-terminal-driver.ts',import.meta.url).href)});
  BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
  const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
  cfg.instances.r2={driver:'fakeLateTerminal'};fs.writeFileSync(file,JSON.stringify(cfg));
 `});
 writeFileSync(new URL('launch.json',evidence),JSON.stringify(fixture.info,null,2));
 const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
 headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
},60000);
afterAll(async()=>{
 try{if(fixture){writeFileSync(new URL('server.log',evidence),readFileSync(fixture.info.logPath));writeFileSync(new URL('commands.json',evidence),JSON.stringify(commands,null,2));const states=fixture.info.dataDir+'/script-states.jsonl';if(existsSync(states))writeFileSync(new URL('script-states.jsonl',evidence),readFileSync(states));}}
 finally{await fixture?.close();if(fixture)writeFileSync(new URL('cleanup.json',evidence),JSON.stringify({dataDirExists:existsSync(fixture.info.dataDir)}));}
});
it.each(['git-shell','cluster-shell','safe-shell','cluster-script','weird-script','safe-script'])('r2 production permission gate: %s',async variant=>{
 // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: cluster-shell submits the
 // literal home wipe; Git cleanup and script-file bodies alone run.
 const safe=variant!=='cluster-shell';
 const {bot}=await api('POST','/api/bots',{name:'Wipe fold R2 '+variant,modelSelection:{instanceId:'r2',model:'late-1'}});
 await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'});
 await api('PATCH',`/api/bots/${bot.id}/tasks/${bot.threadId}`,{noLimits:true,acknowledgeNoLimits:true});
 const stream=await openSse(fixture.info.url+'/api/events');
 try{
  await stream.until(frame=>frame.kind==='hello');
  await api('POST',`/api/bots/${bot.id}/messages`,{text:variant,threadId:bot.threadId});
  await stream.until(frame=>frame.kind==='runtime'&&frame.event?.type==='request.opened'&&frame.event?.threadId===bot.threadId);
  const waited=await runControlMurage(['wait','--bot',bot.id,'--timeout','5','--url',fixture.info.url]);
  const transcript=await runControlMurage(['messages','--bot',bot.id,'--limit','20','--url',fixture.info.url]);
  const messages=await api('GET',`/api/threads/${bot.threadId}/messages?limit=20`),decisions=await api('GET','/api/decisions?limit=100');
  writeFileSync(new URL(variant+'.json',evidence),JSON.stringify({waited,transcript,messages,decisions},null,2));
  expect(waited).toMatchObject({status:safe?'settled':'needs-user'});
  // MAIN RULING c3-decision INT-CONFLICT-DEFAULT: the native identity
  // assertion uses durable evidence only for cards actually observed on HTTP;
  // the next assertion independently retains the public opaque-handle count.
  const stored=fixtureMessageEvidence(join(fixture.info.dataDir,'messages.db'),messages.messages);
  expect(stored.filter((m:any)=>m.card?.requestId&&m.card.answered===undefined)).toHaveLength(safe?0:1);
  expect(messages.messages.filter((m:any)=>(m.card?.requestHandle||m.card?.requestId)&&m.card.answered===undefined)).toHaveLength(safe?0:1);
  if(!safe)expect(messages.messages.find((m:any)=>m.card?.requestHandle)?.card.requestHandle).toMatch(/^p\./);
  if(safe)expect(messages.messages).toContainEqual(expect.objectContaining({text:'fixture allow'}));
  else expect(decisions.decisions).toContainEqual(expect.objectContaining({threadId:bot.threadId,decision:'card-shown',source:'always-ask'}));
  if(!safe)expect(decisions.decisions.some((row:any)=>row.threadId===bot.threadId&&row.decision==='auto-approved')).toBe(false);
 }finally{await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});stream.close();}
},30000);
