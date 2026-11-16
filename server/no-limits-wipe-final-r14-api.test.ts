// SPDX-License-Identifier: AGPL-3.0-or-later
// The isolated fake engine emits permission data; deletion commands never run.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { openSse } from './testing/sse.ts';
import { finalWipeFilesystemFixture } from './testing/final-wipe-filesystem-fixture.ts';
const r14Cases={"r14-H1": "echo 'DROP TABLE t;' | mysql -f appdb", "r14-H1-psql": "echo 'DROP TABLE t;' | psql -f safe.sql", "r14-H2": "cd link/.. && pushd safe && popd && psql < schema.sql", "safe-r14-stack": "pushd sub && psql < schema.sql && popd", "safe-r14-file": "psql -f safe.sql"};
let fixture:VerificationServer;
let headers:Record<string,string>;
const evidence=pathToFileURL(mkdtempSync(join(process.env.WIPE_FINAL_EVIDENCE??tmpdir(),'wipe-final-'))+'/');
mkdirSync(evidence,{recursive:true});
const commands:unknown[]=[];
async function api(method:string,path:string,body?:unknown):Promise<any>{
 const res=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 commands.push({method,path,body,status:res.status});expect(res.ok).toBe(true);return res.json();
}
beforeAll(async()=>{
 const anchor='emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
 const replacement=`const variant=JSON.stringify(turn.prompt ?? turn.text);
  const assembled=${JSON.stringify(r14Cases)};
  const key=Object.keys(assembled).sort((a,b)=>b.length-a.length).find(key=>variant.includes(key));
  if(!key)throw Error('unknown fixture command');
  const command=assembled[key];
  for(const dir of ['safe','sub','other/deep'])r2Fs.mkdirSync(r2Path.join(turn.cwd,dir),{recursive:true});
  r2Fs.symlinkSync(r2Path.join(turn.cwd,'other/deep'),r2Path.join(turn.cwd,'link'));
  r2Fs.writeFileSync(r2Path.join(turn.cwd,'schema.sql'),'DROP TABLE t;');
  for(const name of ['appdb','safe.sql','other/schema.sql','sub/schema.sql']){
   const file=r2Path.join(turn.cwd,name),body='SELECT 1';r2Fs.writeFileSync(file,body);
   emit({type:'item.started',itemType:'tool',origin:'engine',title:'Write',itemId:turnId+'-write-'+name,input:{file_path:file,content:body},threadId:turn.threadId,turnId});
   r2Fs.appendFileSync(r2Path.join(process.env.MURAGE_DATA_DIR,'script-states.jsonl'),JSON.stringify({thread:turn.threadId,file,tracked:r2Scripts.turnWrittenScripts(turn.threadId,input.instanceId,turnId).has(file)})+'\\n');
  }
  emit({type:'request.opened',requestType:'permission',tool:'Bash',summary:command,toolCall:{name:'Bash',input:{command,cwd:turn.cwd}},requestId:turnId+'-approval',threadId:turn.threadId,turnId});return;`;
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  await import(${JSON.stringify(new URL('./testing/idle-load-preload.mjs',import.meta.url).href)});
  const fs=await import('node:fs');const path=await import('node:path');const {registerHooks}=await import('node:module');
  registerHooks({load(url,ctx,next){
   ${finalWipeFilesystemFixture}
   if(url.endsWith('/server/no-limits-wipe.ts')){
    const result=next(url,ctx);
    return {...result,source:String(result.source).replace('export function noLimitsWipe(', 'function fixtureNoLimitsWipe(')+${JSON.stringify("\nimport * as fs from 'node:fs';import * as path from 'node:path';export function noLimitsWipe(text,options){const result=fixtureNoLimitsWipe(text,options);if(result)fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'wipe-findings.jsonl'),JSON.stringify({text,options,result})+'\\n');return result;}")}};
   }
   if(url.endsWith('/server/no-limits-wipe-scripts.ts')){
    const result=next(url,ctx);
    return {...result,source:String(result.source).replace('export function* writtenScriptTexts(', 'function* fixtureWrittenScriptTexts(')+${JSON.stringify("\nimport * as fs from 'node:fs';import * as path from 'node:path';export function* writtenScriptTexts(commands,options){for(const script of fixtureWrittenScriptTexts(commands,options)){fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'script-findings.jsonl'),JSON.stringify({script,files:[...(options.files??[])]})+'\\n');yield script;}}")}};
   }
   if(url.endsWith('/server/decision/records.ts')){
    const result=next(url,ctx);
    return {...result,source:String(result.source).replace('export function insertRecord(', 'function fixtureInsertRecord(')+${JSON.stringify("\nimport * as fs from 'node:fs';import * as path from 'node:path';export function insertRecord(db,row){const result=fixtureInsertRecord(db,row);fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'approval-records.jsonl'),JSON.stringify(row)+'\\n');return result;}")}};
   }
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
 `}).catch(error=>{const log=String(error).split('see ')[1];if(log&&existsSync(log))writeFileSync(new URL('startup-error.log',evidence),readFileSync(log));throw error;});
 writeFileSync(new URL('launch.json',evidence),JSON.stringify(fixture.info,null,2));
 const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
 headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
},60000);
afterAll(async()=>{
 try{if(fixture){writeFileSync(new URL('server.log',evidence),readFileSync(fixture.info.logPath));writeFileSync(new URL('commands.json',evidence),JSON.stringify(commands,null,2));const states=fixture.info.dataDir+'/script-states.jsonl';if(existsSync(states))writeFileSync(new URL('script-states.jsonl',evidence),readFileSync(states));}}
 finally{await fixture?.close();if(fixture)writeFileSync(new URL('cleanup.json',evidence),JSON.stringify({dataDirExists:existsSync(fixture.info.dataDir)}));}
});
it.each(["r14-H1", "r14-H1-psql", "r14-H2", "safe-r14-stack", "safe-r14-file"])('R14 isolated production lifecycle: %s',async variant=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 const safe=!['cluster-shell','r5-array','r5-time'].includes(variant);
 const {bot}=await api('POST','/api/bots',{name:'Wipe R14 '+variant,modelSelection:{instanceId:'r2',model:'late-1'}});
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
  writeFileSync(new URL(variant+'.json',evidence),JSON.stringify({waited,transcript,messages,decisions,approvalRecords:existsSync(fixture.info.dataDir+'/approval-records.jsonl')?readFileSync(fixture.info.dataDir+'/approval-records.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line)):[],scriptFindings:existsSync(fixture.info.dataDir+'/script-findings.jsonl')?readFileSync(fixture.info.dataDir+'/script-findings.jsonl','utf8'):'',wipeFindings:existsSync(fixture.info.dataDir+'/wipe-findings.jsonl')?readFileSync(fixture.info.dataDir+'/wipe-findings.jsonl','utf8'):''},null,2));
  expect(waited).toMatchObject({status:safe?'settled':'needs-user'});
  // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 / c08609816b: count the public opaque permission handle; private execution ids stay hidden.
  expect(messages.messages.filter((m:any)=>m.card?.requestHandle&&m.card.answered===undefined)).toHaveLength(safe?0:1);
  const states=readFileSync(fixture.info.dataDir+'/script-states.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(states.filter(row=>row.thread===bot.threadId&&row.tracked)).toHaveLength(4);
  if(safe)expect(messages.messages).toContainEqual(expect.objectContaining({text:'fixture allow'}));
  else expect(decisions.decisions).toContainEqual(expect.objectContaining({threadId:bot.threadId,decision:'card-shown',source:'always-ask'}));
  if(!safe)expect(decisions.decisions.some((row:any)=>row.threadId===bot.threadId&&row.decision==='auto-approved')).toBe(false);
 }finally{await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});stream.close();}
},30000);
