// SPDX-License-Identifier: AGPL-3.0-or-later
// The isolated fake engine emits permission data; deletion commands never run.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import {parseFreeWipeCases} from '../shared/testing/no-limits-parse-free-cases.ts';
import { openSse } from './testing/sse.ts';
import { finalWipeFilesystemFixture } from './testing/final-wipe-filesystem-fixture.ts';
const r12Cases={"r12-H1": "echo x\\ #; eval \"$OPAQUE\"", "r12-H2": "cat <<'EOF'\ntext\\\nEOF\neval \"$OPAQUE\"\nEOF", "r12-H3": "uniq payload.sql input.sql; psql < input.sql", "r12-H4": "psql < sub/../input.sql", "r12-H5": "echo * | psql", "safe-r12-echo": "echo 'SELECT 1' | psql", "safe-r12-file": "psql < schema.sql", "safe-r12-heredoc": "cat <<'EOF'\nplain text\nEOF", "safe-r12-quote": "echo 'a # inside quoted string'"};
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
  let command=variant.includes('safe-shell') ? "bash -o pipefail -c 'ls'" : variant.includes('cluster-shell') ? "bash -euo pipefail -c 'rm -rf ~'" : "bash -o pipefail -c 'git clean -fdx'";
  if(variant.includes('script')){
   const file=r2Path.join(turn.cwd,'cleanup');
   const header=variant.includes('weird-script') ? '#!/weird/interp' : '#!/usr/bin/env -vSpython3';
   const body=(variant.includes('safe-script')||variant.includes('safe-stdin-script')) ? "print('hi')" : variant.includes('weird-script') ? "os.remove('/x')" : "import shutil; shutil.rmtree('/archive/backups')";
   r2Fs.writeFileSync(file,header+'\\n'+body);
   emit({type:'item.started',itemType:'tool',origin:'engine',title:'Write',itemId:turnId+'-write',input:{file_path:file,content:header+'\\n'+body},threadId:turn.threadId,turnId});
   r2Fs.appendFileSync(r2Path.join(process.env.MURAGE_DATA_DIR,'script-states.jsonl'),JSON.stringify({thread:turn.threadId,provider:input.instanceId,turn:turnId,key:r2Marks.outsideTurnKey(turn.threadId),tracked:r2Scripts.turnWrittenScripts(turn.threadId,input.instanceId,turnId).has(file)})+'\\n');
   command=variant.includes('stdin-script')?'lua < cleanup':'./cleanup';
  }
  if(variant.includes('wrapper-script')){
   const file=r2Path.join(turn.cwd,'env'),body='#!/bin/sh\\nrm -rf ~';r2Fs.writeFileSync(file,body);
   emit({type:'item.started',itemType:'tool',origin:'engine',title:'Write',itemId:turnId+'-wrapper',input:{file_path:file,content:body},threadId:turn.threadId,turnId});
   command='./env tee out.txt';
   r2Fs.appendFileSync(r2Path.join(process.env.MURAGE_DATA_DIR,'script-states.jsonl'),JSON.stringify({thread:turn.threadId,tracked:r2Scripts.turnWrittenScripts(turn.threadId,input.instanceId,turnId).has(file)})+'\\n');
  }
  if(variant.includes('safe-r8-tee-existing'))r2Fs.writeFileSync(r2Path.join(turn.cwd,'ordinary.txt'),'existing ordinary data');
  if(variant.includes('safe-platform'))command='echo platform ready';
  if(variant.includes('rows-review'))command=${JSON.stringify(`echo 'rm -rf "$HOME"' > /tmp/nolim-r5; source</dev/null /tmp/nolim-r5`)};
  if(variant.includes('parser-review'))command="bash -o pipefail -c 'git clean -fdx'; "+'eval '.repeat(40)+'true';
  if(variant.includes('printf-review'))command="printf -v 'a[$(./cleanup.sh)]' %s x";
  if(variant.includes('printf-multiline'))command=${JSON.stringify("printf '\n\\x72\\x6d\\x20\\x2d\\x72\\x66\\x20\\x7e' | bash")};
  if(variant.includes('printf-octal'))command=${JSON.stringify('printf "\n\\162\\155\\040\\055\\162\\146\\040\\176" | bash')};
  if(variant.includes('printf-pipeline'))command="printf '%s' 'echo ok' | bash";
  if(variant.includes('printf-substitution'))command='bash -c "$(printf %s harmless)"';
  const assembled=${JSON.stringify(r12Cases)};
  for(const [key,value] of Object.entries(assembled))if(variant.includes(key))command=value;
  const parseFree=${JSON.stringify(parseFreeWipeCases)};
  for(const row of parseFree)if(variant.includes(row.id))command=row.command;
  if(variant.includes('recovery-inline')){
   command=${JSON.stringify(`python3 -c 'import os; os.system("./cleanup.sh")'`)};
   r2Scripts.registerRecoveryScriptRequest({threadId:turn.threadId,providerInstanceId:input.instanceId,turnId,requestId:turnId+'-approval'});
  }
  if(variant.includes('backdated-script')){
   const file=r2Path.join(turn.cwd,'cleanup');r2Fs.utimesSync(file,new Date(1000),new Date(1000));
  }
  if(variant.includes('r12-H4')||variant.includes('r12-H3')||variant.includes('safe-r12-file')){
   for(const name of ['input.sql','schema.sql']){
    const file=r2Path.join(turn.cwd,name),body='SELECT 1';r2Fs.writeFileSync(file,body);
    emit({type:'item.started',itemType:'tool',origin:'engine',title:'Write',itemId:turnId+'-write-'+name,input:{file_path:file,content:body},threadId:turn.threadId,turnId});
    r2Fs.appendFileSync(r2Path.join(process.env.MURAGE_DATA_DIR,'script-states.jsonl'),JSON.stringify({thread:turn.threadId,file,tracked:r2Scripts.turnWrittenScripts(turn.threadId,input.instanceId,turnId).has(file)})+'\\n');
   }
   r2Fs.writeFileSync(r2Path.join(turn.cwd,'payload.sql'),'DROP TABLE t;');
   if(variant.includes('r12-H4')){
    r2Fs.mkdirSync(r2Path.join(turn.cwd,'other/deep'),{recursive:true});
    r2Fs.writeFileSync(r2Path.join(turn.cwd,'other/input.sql'),'DROP TABLE t;');
    r2Fs.symlinkSync(r2Path.join(turn.cwd,'other/deep'),r2Path.join(turn.cwd,'sub'));
   }

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
it.each(["r12-H1", "r12-H2", "r12-H3", "r12-H4", "r12-H5", "safe-r12-echo", "safe-r12-file", "safe-r12-heredoc", "safe-r12-quote"])('R12 isolated production lifecycle: %s',async variant=>{
 // MAIN RULING T5: unknown output consumers are not shell executors.
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 const safe=!['cluster-shell','r5-array','r5-time'].includes(variant);
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
  writeFileSync(new URL(variant+'.json',evidence),JSON.stringify({waited,transcript,messages,decisions,approvalRecords:existsSync(fixture.info.dataDir+'/approval-records.jsonl')?readFileSync(fixture.info.dataDir+'/approval-records.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line)):[],scriptFindings:existsSync(fixture.info.dataDir+'/script-findings.jsonl')?readFileSync(fixture.info.dataDir+'/script-findings.jsonl','utf8'):'',wipeFindings:existsSync(fixture.info.dataDir+'/wipe-findings.jsonl')?readFileSync(fixture.info.dataDir+'/wipe-findings.jsonl','utf8'):''},null,2));
  expect(waited).toMatchObject({status:safe?'settled':'needs-user'});
  // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 / c08609816b: count the public opaque permission handle; private execution ids stay hidden.
  expect(messages.messages.filter((m:any)=>m.card?.requestHandle&&m.card.answered===undefined)).toHaveLength(safe?0:1);
  if(variant.includes('script')){const states=readFileSync(fixture.info.dataDir+'/script-states.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));expect(states).toContainEqual(expect.objectContaining({thread:bot.threadId,tracked:true}));}
  if(['r12-H4','r12-H3','safe-r12-file'].includes(variant)){const states=readFileSync(fixture.info.dataDir+'/script-states.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));expect(states.filter(row=>row.thread===bot.threadId&&row.tracked)).toHaveLength(2);}
  if(safe)expect(messages.messages).toContainEqual(expect.objectContaining({text:'fixture allow'}));
  else expect(decisions.decisions).toContainEqual(expect.objectContaining({threadId:bot.threadId,decision:'card-shown',source:'always-ask'}));
  if(!safe)expect(decisions.decisions.some((row:any)=>row.threadId===bot.threadId&&row.decision==='auto-approved')).toBe(false);
 }finally{await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});stream.close();}
},30000);
