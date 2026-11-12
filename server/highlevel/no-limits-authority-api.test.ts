// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../../scripts/control-murage.ts';
import { raiseLevel } from '../testing/raise-level.ts';
import { defaultHighLevelFamilies } from '../../shared/highlevel.ts';

let fixture: VerificationServer;
let desktop: Record<string, string>;
const evidence: unknown[] = [];
const connectionId = 'hl_fixture1';
const instrumentation = `
const fs=await import('node:fs'),path=await import('node:path');
const dir=process.env.MURAGE_DATA_DIR,askDir=path.join(dir,'ask');fs.mkdirSync(askDir,{recursive:true});
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(url.endsWith('/server/highlevel/host.ts')){let source=fs.readFileSync(new URL(url),'utf8').replaceAll('if (error instanceof HighLevelError) status = error.status;', "console.error('HL fixture request failure', error); if (error instanceof HighLevelError) status = error.status;");return {format:'module-typescript',shortCircuit:true,source};}
 if(!url.endsWith('/server/highlevel/actions.ts'))return next(url,context);
 let source=fs.readFileSync(new URL(url),'utf8');
 // A one-action inventory makes the overlapping-writes case exercise the old
 // owner-clearance ceiling without creating two thousand fixture actions.
 source=source.replace('export const ACTION_MAX_IDENTITIES = 2_000;', 'export const ACTION_MAX_IDENTITIES = 1;');
 source=source.replace('options.now ?? Date.now','options.now ?? (() => Date.now() + (globalThis.__hlActionClockOffset ?? 0))');
 return {format:'module-typescript',shortCircuit:true,source};
}});
const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL('../drivers/builtIn.ts', import.meta.url).href)});
const {makeAskDriver}=await import(${JSON.stringify(new URL('../testing/fake-ask-driver.ts', import.meta.url).href)});
const driver=makeAskDriver(),create=driver.create;
driver.create=async function(input){
 const instance=await create.call(this,input),send=instance.adapter.sendTurn;
 instance.adapter.sendTurn=async function(turn){
  if(turn.integrations?.highlevel)fs.writeFileSync(path.join(dir,turn.threadId+'.env.json'),JSON.stringify(turn.integrations.highlevel.env));
  return send.call(this,turn);
 };return instance;
};BUILT_IN_DRIVERS.push(driver);
const {PHONE_JOBS_ENGINES}=await import(${JSON.stringify(new URL('../phone-jobs-engines.ts', import.meta.url).href)});
PHONE_JOBS_ENGINES.fakeAsk={mounts:true,where:'fixture'};
const {PrivateTokenLeaseSource}=await import(${JSON.stringify(new URL('./private-token.ts', import.meta.url).href)});
const view={connectionId:'hl_fixture1',locationId:'loc_fixture',companyId:'co_fixture',epoch:1,state:'connected',scopes:['contacts.readonly','contacts.write']};
PrivateTokenLeaseSource.prototype.ownerView=function(){return {...view,confirmedAt:new Date().toISOString()};};
PrivateTokenLeaseSource.prototype.connection=async function(id){return id===view.connectionId?{...view}:undefined;};
PrivateTokenLeaseSource.prototype.lease=async function(request){return {...view,leaseId:'fixture',requestId:request.requestId,connectionEpoch:1,credentialVersion:1,accessToken:'fixture-only-token',discardAt:Date.now()+60000};};
const originalFetch=globalThis.fetch;
let notes=0;
globalThis.fetch=async function(input,init){
 const url=new URL(String(input));if(url.hostname!=='services.leadconnectorhq.com')return originalFetch(input,init);
 const method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;
 fs.appendFileSync(path.join(dir,'provider.jsonl'),JSON.stringify({method,path:url.pathname,body})+'\\n');
 if(method==='POST'&&url.pathname.endsWith('/notes')){
  const id='note_'+(++notes);
  if(fs.existsSync(path.join(dir,'hold-provider')))while(!fs.existsSync(path.join(dir,'release-provider')))await new Promise(r=>setTimeout(r,10));
  return Response.json({note:{id,body:body.body}},{status:201});
 }
 if(url.pathname.endsWith('/notes'))return Response.json({notes:[]});
 if(url.pathname.startsWith('/contacts/'))return Response.json({contact:{id:url.pathname.split('/')[2],locationId:view.locationId,firstName:'Fixture'}});
 return Response.json({error:'unexpected fixture request'},{status:418});
};
// Advance only the action journal's clock, after the host has proposed its
// policy action. This simulates a slow authority read without wall-clock waits.
const {HighLevelHost}=await import(${JSON.stringify(new URL('./host.ts', import.meta.url).href)});
const configure=HighLevelHost.prototype.configureReview;HighLevelHost.prototype.configureReview=function(hooks){const onReview=hooks.onReview;return configure.call(this,{...hooks,onReview:(...args)=>{try{return onReview(...args);}catch(e){console.error('fixture HighLevel review callback',e);throw e;}}});};
const {HighLevelActions}=await import(${JSON.stringify(new URL('./actions.ts', import.meta.url).href)});
const propose=HighLevelActions.prototype.propose;
HighLevelActions.prototype.propose=function(...args){const review=propose.apply(this,args);if(fs.existsSync(path.join(dir,'expire-policy')))globalThis.__hlActionClockOffset=20*60*1000;return review;};
const file=path.join(dir,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
cfg.instances.hl={driver:'fakeAsk',displayName:'HighLevel fixture',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'1'}};
fs.writeFileSync(file,JSON.stringify(cfg));
`;
async function api(method: string, path: string, body?: unknown, headers = desktop) {
 const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result={status:response.status,body:await response.json() as any};
 if(!path.includes('secret'))evidence.push({method,path,...result});
 return result;
}
async function mounted(noLimits=false,denyRead=false){
 const created=await api('POST','/api/bots',{name:'GNL-HL authority',modelSelection:{instanceId:'hl',model:'ask-1'}});expect(created.status).toBe(201);
 const bot=created.body.bot;
 expect((await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,autoReview:'off'})).status).toBe(200);
 expect((await api('PUT',`/api/highlevel/bots/${bot.id}/access`,{grants:[{connectionId,families:{...defaultHighLevelFamilies(),contacts:'full'}}],...(denyRead?{denyRules:['HIGHLEVEL:R']}:{})})).status).toBe(200);
 if(noLimits)expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 writeFileSync(join(fixture.info.dataDir,'ask','hold'),'');
 expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'GNL-HL authority witness',sendId:crypto.randomUUID()})).status).toBe(202);
 const envFile=join(fixture.info.dataDir,bot.threadId+'.env.json');
 await expect.poll(()=>existsSync(envFile),{timeout:30000}).toBe(true);
 const token=JSON.parse(readFileSync(envFile,'utf8')).MURAGE_CONTROL_TOKEN;
 let n=0;
 const call=(contactId='contact_1',rpcId?:string)=>api('POST','/api/internal/highlevel/mcp',{jsonrpc:'2.0',id:rpcId??`note-${++n}`,method:'tools/call',params:{name:'HIGHLEVEL_CONTACTS',arguments:{operation:'contacts.notes.create',args:{contactId,body:'GNL-HL note'}}}},{authorization:'Bearer '+token});
 const stop=()=>api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});
 const read=()=>api('POST','/api/internal/highlevel/mcp',{jsonrpc:'2.0',id:'read-contact',method:'tools/call',params:{name:'HIGHLEVEL_CONTACTS',arguments:{operation:'contacts.get',args:{contactId:'contact_1'}}}},{authorization:'Bearer '+token});
 return {bot,call,read,stop};
}
const messages=async(threadId:string)=>(await api('GET',`/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const provider=()=>{try{return readFileSync(join(fixture.info.dataDir,'provider.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}};
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation,dumpLog:true});
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret',undefined,{})).body.secret};
},90000);
afterAll(async()=>{
 mkdirSync('evidence/gnl-hl',{recursive:true});if(fixture)writeFileSync('evidence/gnl-hl/authority-server.log',readFileSync(fixture.info.logPath));writeFileSync('evidence/gnl-hl/authority-workflow.json',JSON.stringify({fixture:fixture?.info,provider:fixture?provider():[],evidence},null,2));await fixture?.close();
});
it('GNL-HL below No limits keeps exact desktop review and sends once',async()=>{
 const h=await mounted();let pending:ReturnType<typeof h.call>|undefined;
 try{
  pending=h.call();
  let card:any;
  await expect.poll(async()=>{card=(await messages(h.bot.threadId)).find(m=>m.card?.requestId?.startsWith('highlevel-'));return Boolean(card);}).toBe(true);
  const actionId=card.card.requestId.slice('highlevel-'.length);
  const values=await api('GET',`/api/highlevel/reviews/${actionId}`);expect(values.status).toBe(200);
  const before=provider().filter(r=>r.method==='POST').length;
  expect((await api('POST',`/api/threads/${h.bot.threadId}/respond`,{requestId:card.card.requestId,behavior:'allow',reviewDigest:'wrong'})).body.outcome).toBe('unavailable');
  expect(provider().filter(r=>r.method==='POST')).toHaveLength(before);
  expect((await api('POST',`/api/threads/${h.bot.threadId}/respond`,{requestId:card.card.requestId,behavior:'allow',reviewDigest:values.body.reviewDigest})).body.outcome).toBe('allowed-once');
  expect((await pending).body.result).not.toMatchObject({isError:true});
  expect(provider().filter(r=>r.method==='POST')).toHaveLength(before+1);
 }finally{await h.stop();await pending;}
},60000);
it('GNL-HL F2 pending Ask action runs and its card closes on live No limits upgrade',async()=>{
 const h=await mounted();let pending:ReturnType<typeof h.call>|undefined;
 try{
  pending=h.call('contact_1','upgraded-note');
  await expect.poll(async()=>(await messages(h.bot.threadId)).some(m=>m.card?.requestId?.startsWith('highlevel-'))).toBe(true);
  const before=provider().filter(r=>r.method==='POST').length;
  expect((await raiseLevel(api,h.bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
  await expect.poll(()=>provider().filter(r=>r.method==='POST').length,{timeout:5000}).toBe(before+1);
  expect((await pending).body.result).not.toMatchObject({isError:true});
  expect((await h.call('contact_1','upgraded-note')).body.result).not.toMatchObject({isError:true});
  expect(provider().filter(r=>r.method==='POST')).toHaveLength(before+1);
  const cards=(await messages(h.bot.threadId)).filter(m=>m.card?.requestId?.startsWith('highlevel-'));
  expect(cards).toHaveLength(1);expect(cards[0].card.answered).toBeTruthy();
  expect((await api('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===h.bot.id).tasks.find((t:any)=>t.threadId===h.bot.threadId).activity).not.toBe('waiting-on-you');
 }finally{await h.stop();await pending;}
},60000);
it('GNL-HL F2 pending denied read releases its result on live No limits upgrade',async()=>{
 const h=await mounted(false,true);let pending:ReturnType<typeof h.read>|undefined;
 try{
  pending=h.read();
  await expect.poll(async()=>(await messages(h.bot.threadId)).some(m=>m.card?.requestId?.startsWith('highlevel-'))).toBe(true);
  expect((await raiseLevel(api,h.bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
  let completed=false;void pending.then(()=>{completed=true;});
  await expect.poll(()=>completed,{timeout:5000}).toBe(true);
  expect((await pending).body.result).not.toMatchObject({isError:true});
  expect(JSON.stringify((await pending).body.result)).toContain('Fixture');
  expect((await messages(h.bot.threadId)).filter(m=>m.card?.requestId?.startsWith('highlevel-')&&!m.card.answered)).toHaveLength(0);
 }finally{await h.stop();await pending;}
},60000);
it('GNL-HL F2 overlapping No limits policy writes both dispatch without owner review',async()=>{
 const h=await mounted(true);let first:ReturnType<typeof h.call>|undefined;
 try{
  const before=provider().filter(r=>r.method==='POST').length;
  writeFileSync(join(fixture.info.dataDir,'hold-provider'),'');first=h.call();
  await expect.poll(()=>provider().filter(r=>r.method==='POST').length).toBe(before+1);
  const second=h.call('contact_2');
  await expect.poll(()=>provider().filter(r=>r.method==='POST').length,{timeout:5000}).toBe(before+2);
  writeFileSync(join(fixture.info.dataDir,'release-provider'),'');
  expect((await first).body.result).not.toMatchObject({isError:true});expect((await second).body.result).not.toMatchObject({isError:true});
  expect((await messages(h.bot.threadId)).filter(m=>m.card?.requestId?.startsWith('highlevel-'))).toHaveLength(0);
 }finally{writeFileSync(join(fixture.info.dataDir,'release-provider'),'');await h.stop();await first;}
},60000);
it('GNL-HL F2 No limits policy write survives the human review TTL',async()=>{
 const h=await mounted(true);
 try{
  writeFileSync(join(fixture.info.dataDir,'expire-policy'),'');
  const before=provider().filter(r=>r.method==='POST').length;
  const result=await h.call();expect(result.body.result).not.toMatchObject({isError:true});
  expect(provider().filter(r=>r.method==='POST')).toHaveLength(before+1);
  expect((await messages(h.bot.threadId)).filter(m=>m.card?.requestId?.startsWith('highlevel-'))).toHaveLength(0);
 }finally{await h.stop();}
},60000);
