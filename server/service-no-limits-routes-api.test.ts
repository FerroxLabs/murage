// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { raiseLevel } from './testing/raise-level.ts';
let fixture: VerificationServer, desktop: Record<string,string>;
const evidence:unknown[]=[];
const instrumentation=`
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
process.env.FAKE_CLAUDE_MODE='hang';
const fs=await import('node:fs'),path=await import('node:path');
const configFile=path.join(process.env.MURAGE_DATA_DIR,'config.json'),config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const fake=path.join(process.cwd(),'server/testing/fake-acp-cli.ts');fs.chmodSync(fake,0o755);
config.instances.fuigo={driver:'fuigoAgent',environment:{PATH:path.dirname(process.execPath),FAKE_ACP_MODE:'folder-trust',FAKE_ACP_TRUST_V:'2',FAKE_ACP_MCP_READY:'1',FAKE_ACP_DUMP:path.join(process.env.MURAGE_DATA_DIR,'fuigo-dump.json')},config:{cli:fake,fullAuto:false}};
fs.mkdirSync(path.join(process.env.HOME,'.fuigo'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.fuigo','auth.json'),'{}');
fs.writeFileSync(configFile,JSON.stringify(config));
// Model the owner's already saved Do not trust answer before the server loads it.
const rejectedFolder=path.join(process.env.MURAGE_DATA_DIR,'n7-rejected-folder');
fs.mkdirSync(rejectedFolder,{recursive:true});
fs.writeFileSync(path.join(rejectedFolder,'AGENTS.md'),'# Fixture instructions\\nsvc-rejected-folder-witness\\n');
fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'folder-trust.json'),JSON.stringify({version:1,seededFrom:'fixture',folders:{[rejectedFolder]:{decision:'reject',source:'card',folder:rejectedFolder,decidedAt:Date.now(),consent:2}}}));
const nativeRejectedFolder=path.join(process.env.MURAGE_DATA_DIR,'n7-native-rejected-folder');
fs.mkdirSync(nativeRejectedFolder,{recursive:true});
fs.writeFileSync(path.join(nativeRejectedFolder,'AGENTS.md'),'# Fixture instructions\\nsvc-native-rejected-folder-witness\\n');
fs.writeFileSync(path.join(process.env.HOME,'.fuigo','trusted_folders.toml'),'[folders.'+JSON.stringify(nativeRejectedFolder)+']\\ntrusted = false\\nconsent = 2\\n');
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(url.endsWith('/server/index.ts')){
  let source=fs.readFileSync(new URL(url),'utf8');
  const admission='function makeDecisionProvenance(botId: string, threadId: string, generation: string, initiator: Initiator, ownerAudience: boolean): TurnProvenance {';
  const own='function ownPermissionFacts(botId: string, threadId: string, generation: string) {';
  if(!source.includes(admission)||!source.includes(own))throw Error('content-origin fixture anchor moved');
  source=source.replace(admission,admission+"if(store.bot(botId)?.name==='H5 content recovery'){initiator={k:'other-human'};ownerAudience=false;}");
  source=source.replace(own,own+"if(store.bot(botId)?.name==='H5 content recovery')markTurnOutside(threadId,'another person');");
  return {format:'module-typescript',shortCircuit:true,source};
 }
 if(url.endsWith('/browser-extension-integration.ts'))return {format:'module',shortCircuit:true,source:\`export class BrowserExtensionIntegration{constructor(){this.approvals={resolve:()=>false};}async start(){return this;}status(){return {profiles:[],bindings:[]};}hostConfigPath(){return 'fixture-helper';}async dispatch(){return {tools:[]};}cancelThread(){}async close(){}}export function routineThreadSignal(){return ()=>false;}export function delegatedTurnUnattended(){return false;}\`};
 return next(url,context);
}});
`;
async function api(method:string,path:string,body?:unknown,headers=desktop){
 const res=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const result={status:res.status,body:await res.json() as any};
 if(!path.includes('secret'))evidence.push({method,path,status:res.status,body:result.body?.credential?{...result.body,credential:'[fixture credential omitted]'}:result.body});
 return result;
}
async function makeBot(name:string,instanceId='verification'){
 const model=instanceId==='verification'?(await api('GET','/api/instances')).body.instances.find((x:any)=>x.instanceId===instanceId).models.options[0].id:'fake-acp-model';
 const made=await api('POST','/api/bots',{name,modelSelection:{instanceId,model}});expect(made.status).toBe(201);
 const bot=made.body.bot;
 expect((await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
 expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 return bot;
}
async function routineTurn(name:string,lead=false){
 const b=await makeBot(name);
 if(lead)expect((await api('PATCH',`/api/bots/${b.id}`,{chiefOfStaff:true,chiefScope:'section',section:name})).status).toBe(200);
 const made=await api('POST','/api/routines',{botId:b.id,name,prompt:'__fixture_hold_authority__ '+name,permissionMode:'unlimited',enabled:false,schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});expect(made.status).toBe(201);
 const started=await api('POST',`/api/routines/${made.body.routine.id}/run`,{});expect(started.status).toBe(201);
 let dump:any;
 await expect.poll(()=>{try{const lines=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n');const line=lines.find(x=>x.includes('__fixture_hold_authority__ '+name));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN);}catch{return false;}},{timeout:30000}).toBe(true);
 const run=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===started.body.run.id);
 return {bot:b,threadId:run.threadId,auth:{authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}};
}
async function webhookTurn(name:string){
 const bot=await makeBot(name);
 const hook=await api('POST','/api/webhooks',{name,prompt:'__fixture_hold_authority__ '+name,botId:bot.id,runOn:'ember'});expect(hook.status).toBe(201);
 const delivered=await fetch(hook.body.credential.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixture:'ping'})});expect(delivered.status).toBe(202);
 const runId=(await delivered.json() as any).runId;
 let dump:any;
 await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(x=>x.includes(name));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN);}catch{return false;}},{timeout:30000}).toBe(true);
 const run=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===runId);
 return {bot,threadId:run.threadId,auth:{authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}};
}
async function messages(threadId:string){return (await api('GET',`/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation,dumpLog:true});
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret',undefined,{})).body.secret};
},120000);
afterAll(async()=>{
 mkdirSync('evidence/nolim-svc',{recursive:true});
 writeFileSync('evidence/nolim-svc/route-workflows.json',JSON.stringify({fixture:fixture?.info,evidence},null,2));
 if(fixture)writeFileSync('evidence/nolim-svc/server.log',readFileSync(fixture.info.logPath));
 await fixture?.close();
});
it('S1 a No limits routine proposes another routine with no card',async()=>{
 const t=await routineTurn('S1 service routine');
 try{
  const result=await api('POST','/api/internal/routine-requests',{fromBotId:t.bot.id,fromThreadId:t.threadId,action:'create',routine:{name:'Created by routine',instructions:'Fixture work',schedule:{type:'interval',everyMinutes:60}}},t.auth);
  expect(result.status,JSON.stringify(result.body)).toBe(201);
  expect(result.body.autoApproved).toBe(true);
  expect((await messages(t.threadId)).filter(m=>m.card?.routineRequest)).toHaveLength(0);
 }finally{await api('POST',`/api/bots/${t.bot.id}/interrupt`,{threadId:t.threadId});}
},60000);
it('S2 a No limits webhook requests browser setup with a notice and no hold',async()=>{
 const t=await webhookTurn('S2 service browser');
 try{
  const result=await api('POST','/api/internal/request-browser-connection',{reason:'Fixture browser'},t.auth);
  expect(result.status,JSON.stringify(result.body)).toBe(201);
  expect(result.body.pending).toBe(false);
  expect((await messages(t.threadId)).filter(m=>m.card?.browserSetup)).toHaveLength(0);
 }finally{await api('POST',`/api/bots/${t.bot.id}/interrupt`,{threadId:t.threadId});}
},60000);
it('S3 a No limits turn loads folder instructions without a folder trust card',async()=>{
 const b=await makeBot('S3 service folder','fuigo');
 const desk=join(fixture.info.dataDir,'workspaces',b.id,'threads',b.threadId);mkdirSync(desk,{recursive:true});writeFileSync(join(desk,'AGENTS.md'),'# Fixture instructions\nsvc-folder-witness\n');
 expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId:b.threadId,text:'Read the folder instructions'})).status).toBe(202);
 try{
  await expect.poll(async()=>{const rows=await messages(b.threadId);return rows.some(m=>m.card?.folderTrust)?'card':rows.some(m=>m.role==='bot'&&m.text?.includes('svc-folder-witness'))?'trusted':'waiting';},{timeout:30000}).toBe('trusted');
  expect((await messages(b.threadId)).filter(m=>m.card?.folderTrust)).toHaveLength(0);
 }finally{await api('POST',`/api/bots/${b.id}/interrupt`,{threadId:b.threadId});}
},60000);

it('S5 No limits bot creation and update apply immediately while the routine is running',async()=>{
 const t=await routineTurn('S5 service team',true);
 try{
  let target='';
  for(let i=0;i<5;i++){
   const made=await api('POST','/api/internal/create-bot',{fromBotId:t.bot.id,fromThreadId:t.threadId,name:`Svc operator ${i}`,role:'Fixture worker',instructions:'Do fixture work'},t.auth);
   expect(made.status,JSON.stringify(made.body)).toBe(201);expect(made.body.staged).not.toBe(true);target=made.body.id;
  }
  const get=await api('POST','/api/internal/bot-management',{fromBotId:t.bot.id,targetBotId:target,action:'get'},t.auth);
  expect(get.status,JSON.stringify(get.body)).toBe(200);
  const updated=await api('POST','/api/internal/bot-management',{fromBotId:t.bot.id,targetBotId:target,action:'update',revision:get.body.bot.revision,instructions:'Applied while the routine is still running'},t.auth);
  expect(updated.status,JSON.stringify(updated.body)).toBe(200);expect(updated.body.pendingReview).not.toBe(true);
  const saved=(await api('GET',`/api/bots/${target}`)).body.bot;
  expect(saved.description).toBe('Applied while the routine is still running');expect(saved.staged).toBeUndefined();expect(saved.pendingRevision).toBeUndefined();
 }finally{await api('POST',`/api/bots/${t.bot.id}/interrupt`,{threadId:t.threadId});}
},60000);

it('N7 No limits overrides saved Do not trust for this turn and preserves the saved rule',async()=>{
 const b=await makeBot('N7 saved reject','fuigo');
 const folder=join(fixture.info.dataDir,'n7-rejected-folder');
 expect((await api('PATCH',`/api/bots/${b.id}`,{cwd:folder})).status).toBe(200);
 const record=()=>api('GET',`/api/folder-trust?bot=${b.id}&thread=${b.threadId}`);
 expect((await record()).body.record).toMatchObject({decision:'reject',source:'card'});
 expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId:b.threadId,text:'Read the folder instructions'})).status).toBe(202);
 try{
  await expect.poll(async()=>(await messages(b.threadId)).some(m=>m.role==='bot'&&m.text?.includes('svc-rejected-folder-witness')),{timeout:30000}).toBe(true);
  await expect.poll(async()=>(await api('GET','/api/bots?messages=0')).body.bots.find((bot:any)=>bot.id===b.id)?.busy,{timeout:30000}).toBe(false);
  const rows=await messages(b.threadId);
  expect(rows.filter(m=>m.card?.folderTrust)).toHaveLength(0);
  expect(rows.filter(m=>m.role==='bot').map(m=>m.text??'').join('\n')).toContain('svc-rejected-folder-witness');
  expect((await record()).body.record).toMatchObject({decision:'reject',source:'card'});
  expect((await api('PATCH',`/api/bots/${b.id}/tasks/${b.threadId}`,{autoApprove:false,fullAccess:false,noLimits:false})).status).toBe(200);
  expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId:b.threadId,text:'Read the saved rejected folder at Ask'})).status).toBe(202);
  await expect.poll(async()=>(await messages(b.threadId)).some(m=>m.role==='bot'&&m.text?.includes('agents: withheld')),{timeout:30000}).toBe(true);
  expect((await record()).body.record).toMatchObject({decision:'reject',source:'card'});
 }finally{await api('POST',`/api/bots/${b.id}/interrupt`,{threadId:b.threadId});}
},60000);

it('X3 No limits unattended questions and widgets run, with a real question rather than permission',async()=>{
 const t=await webhookTurn('X3 questions widgets');
 try{
  const asked=await api('POST','/api/internal/ask-user',{questions:[{question:'Which fixture?',options:[{label:'One'},{label:'Two'}]}]},t.auth);
  expect(asked.status,JSON.stringify(asked.body)).toBe(201);
  const shown=await api('POST','/api/internal/show-widget',{widget:{type:'Card',title:'Fixture',children:[]}},t.auth);
  expect(shown.status,JSON.stringify(shown.body)).toBe(201);
  const rows=await messages(t.threadId);expect(rows.some(m=>m.id===asked.body.messageId)).toBe(true);expect(rows.some(m=>m.id===shown.body.messageId)).toBe(true);
  expect(rows.filter(m=>m.card?.approvalId&&!m.card?.questions)).toHaveLength(0);
 }finally{await api('POST',`/api/bots/${t.bot.id}/interrupt`,{threadId:t.threadId});}
},60000);
it('D5 a No limits turn can propose a routine with eight old proposals still open',async()=>{
 const t=await routineTurn('D5 proposal capacity');
 try{
  for(let i=0;i<8;i++){
   const result=await api('POST','/api/internal/routine-requests',{fromBotId:t.bot.id,fromThreadId:t.threadId,action:'create',routine:{name:`Held wipe proposal ${i}`,instructions:'rm -rf ~',schedule:{type:'interval',everyMinutes:60}}},t.auth);
   expect(result.status,JSON.stringify(result.body)).toBe(201);
  }
  expect((await messages(t.threadId)).filter(m=>m.card?.routineRequest&&!m.card?.answered&&!m.card?.dismissed)).toHaveLength(8);
  const result=await api('POST','/api/internal/routine-requests',{fromBotId:t.bot.id,fromThreadId:t.threadId,action:'create',routine:{name:'Ninth runs',instructions:'Fixture work',schedule:{type:'interval',everyMinutes:60}}},t.auth);
  expect(result.status,JSON.stringify(result.body)).toBe(201);expect(result.body.autoApproved).toBe(true);
  expect((await messages(t.threadId)).filter(m=>m.card?.routineRequest&&!m.card?.answered&&!m.card?.dismissed)).toHaveLength(8);
 }finally{await api('POST',`/api/bots/${t.bot.id}/interrupt`,{threadId:t.threadId});}
},60000);

it('H5 own tools use recovered owner policy even when content provenance remains other-human',async()=>{
 const bot=await makeBot('H5 content recovery');
 expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'__fixture_hold_authority__ H5 content recovery'})).status).toBe(202);
 let dump:any;
 await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(value=>value.includes('H5 content recovery'));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN);}catch{return false;}},{timeout:30000}).toBe(true);
 try{
  const auth={authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN};
  const result=await api('POST','/api/internal/routine-requests',{fromBotId:bot.id,fromThreadId:bot.threadId,action:'create',routine:{name:'Owner recovery routine',instructions:'Fixture work',schedule:{type:'interval',everyMinutes:60}}},auth);
  expect(result.status,JSON.stringify(result.body)).toBe(201);expect(result.body.autoApproved).toBe(true);
  expect((await messages(bot.threadId)).filter(message=>message.card?.routineRequest)).toHaveLength(0);
 }finally{await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});}
},60000);

it('N7 No limits overrides Fuigo own saved no for this process and preserves the native record for Ask',async()=>{
 const b=await makeBot('N7 native saved reject','fuigo');
 const folder=join(fixture.info.dataDir,'n7-native-rejected-folder');
 const nativeFile=join(fixture.info.dataDir,'.fuigo','trusted_folders.toml');
 const before=readFileSync(nativeFile,'utf8');
 expect((await api('PATCH',`/api/bots/${b.id}`,{cwd:folder})).status).toBe(200);
 expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId:b.threadId,text:'Read native rejected folder instructions'})).status).toBe(202);
 await expect.poll(async()=>(await messages(b.threadId)).some(m=>m.role==='bot'&&m.text?.includes('svc-native-rejected-folder-witness')),{timeout:30000}).toBe(true);
 await expect.poll(async()=>(await api('GET','/api/bots?messages=0')).body.bots.find((bot:any)=>bot.id===b.id)?.busy,{timeout:30000}).toBe(false);
 expect(readFileSync(nativeFile,'utf8')).toBe(before);
 expect((await api('PATCH',`/api/bots/${b.id}/tasks/${b.threadId}`,{autoApprove:false,fullAccess:false,noLimits:false})).status).toBe(200);
 expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId:b.threadId,text:'Read it at Ask'})).status).toBe(202);
 await expect.poll(async()=>(await messages(b.threadId)).some(m=>m.role==='bot'&&m.text?.includes('agents: withheld')),{timeout:30000}).toBe(true);
 expect(readFileSync(nativeFile,'utf8')).toBe(before);
 expect((await messages(b.threadId)).filter(m=>m.card?.folderTrust)).toHaveLength(0);
});
