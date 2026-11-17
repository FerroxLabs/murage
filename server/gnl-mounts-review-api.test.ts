// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { raiseLevel } from './testing/raise-level.ts';
let fixture: VerificationServer, desktop: Record<string,string>;
const evidenceDir=(process.env.MURAGE_TEST_EVIDENCE_DIR??'/tmp/murage-test-evidence')+'/gnl-mounts-review-api.test';
const evidence: unknown[] = [];
// Only fixture state is seeded. Authentication, admission, guards and HTTP handlers run unchanged.
const instrumentation = `
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';process.env.FAKE_CLAUDE_MODE='hang';
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(!url.endsWith('/server/index.ts'))return next(url,context);
 const fs=process.getBuiltinModule('node:fs');let source=fs.readFileSync(new URL(url),'utf8');
 source=source.replace('internalTurnOwners.get(threadId)!.triggerMessageId = userMessage.id;',\`internalTurnOwners.get(threadId)!.triggerMessageId = userMessage.id;
 if(bot.name.startsWith('R3 ')){
 const root=insertRoomRequest(database(),{groupId:'fixture-cap-room',verb:'room_turn',fromKind:'owner',toBotId:bot.id,targetThreadId:threadId,state:'running',admissionKey:'fixture-root:'+dispatchClaimId,now:Date.now(),lineage:{rootThreadId:threadId,origin:'desktop',audienceFingerprint:'fixture',notOwnerAudience:false,unattended:false}}).request;
 turnRequestByGeneration.set(dispatchClaimId,root.id);
 for(let i=0;i<6;i++)insertRoomRequest(database(),{groupId:root.groupId,verb:'wake',fromKind:'murage',toBotId:bot.id,targetThreadId:threadId,state:'running',parentId:root.id,admissionKey:'fixture-wake:'+dispatchClaimId+':'+i,now:Date.now()-31*60_000});
 }
 // Recreate a persisted bot waiting for review after an interrupted creation.
 if(bot.name==='R4 sender'||bot.name==='R4 routine sender')for(const target of store.bots.filter(b=>b.name.startsWith('R4 staged'))){
 const staged=botOutsideWrites.staging('fixture-ended-generation',threadId,bot.id,'unsettled',{autoApprove:false,fullAccess:false,noLimits:false,lead:false,modelSelection:target.modelSelection});
 store.commitBotReview(new Map([[target.id,{...target,staged,...(target.name==='R4 staged ask'?{busy:true}:{})}]]));
 }
 \`);
 return {format:'module-typescript',shortCircuit:true,source};
}});
`;
async function api(method:string,path:string,body?:unknown,headers=desktop){
 const res=await fetch(fixture.info.url+path,{method,signal:AbortSignal.timeout(30000),headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const out={status:res.status,body:await res.json() as any};
 evidence.push({method,path,status:out.status,body:path.includes('secret')?'[redacted]':out.body?.credential?{...out.body,credential:'[redacted]'}:out.body});return out;
}
async function bot(name:string,noLimits=true){
 const instances=await api('GET','/api/instances');const model=instances.body.instances.find((i:any)=>i.instanceId==='verification').models.options[0].id;
 const made=await api('POST','/api/bots',{name,modelSelection:{instanceId:'verification',model}});expect(made.status).toBe(201);
 const b=made.body.bot;
 expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
 if(noLimits)expect((await raiseLevel(api,b.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 return b;
}
async function turn(b:any,routine:boolean|'ask'=false){
 const marker='__fixture_hold_authority__ '+b.name;
 let threadId=b.threadId;
 if(routine){
 const made=await api('POST','/api/routines',{botId:b.id,name:b.name,prompt:marker,permissionMode:typeof routine==='string'?routine:'unlimited',enabled:false,schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});expect(made.status).toBe(201);
 const started=await api('POST',`/api/routines/${made.body.routine.id}/run`,{});expect(started.status).toBe(201);
 threadId=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===started.body.run.id).threadId;
 }else expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId,text:marker})).status).toBe(202);
 let dump:any;
 await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(l=>l.includes(marker));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig?.mcpServers?.agents);}catch{return false;}},{timeout:30000}).toBe(true);
 return {b,threadId,dump,auth:{authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}};
}
async function delegate(t:any,target:any,message:string){return api('POST','/api/internal/delegate-bot',{fromBotId:t.b.id,fromThreadId:t.threadId,toBotId:target.id,message},t.auth);}
async function noCards(t:any){const rows=(await api('GET',`/api/threads/${t.threadId}/messages?limit=200`)).body.messages;expect(rows.filter((m:any)=>m.card&&!m.card.intake&&!m.card.answered)).toEqual([]);}
async function stop(t:any){await api('POST',`/api/bots/${t.b.id}/interrupt`,{threadId:t.threadId});}
beforeAll(async()=>{fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation,dumpLog:true});desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret',undefined,{})).body.secret};},120000);
afterAll(async()=>{mkdirSync(evidenceDir,{recursive:true});if(fixture)writeFileSync(evidenceDir+'/server.log',readFileSync(fixture.info.logPath));writeFileSync(evidenceDir+'/workflows.json',JSON.stringify({fixture:fixture?.info,evidence},(key,value)=>/token|secret|credential|authorization/i.test(key)?'[redacted]':value,2));if(fixture){try{writeFileSync(evidenceDir+'/mount-observations.json',JSON.stringify(readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').map(line=>{const dump=JSON.parse(line);return {pid:dump.pid,prompt:dump.prompt,mounts:Object.keys(dump.fixtureMounts??{})};}),null,2));}catch{/* No engine may have reached its prompt. */}}
await fixture?.close();});

it('R1 ordinary No limits bot moves a peer across teams through bot-management',async()=>{
 const t=await turn(await bot('R1 ordinary')),target=await bot('R1 peer');
 try{
 const get=await api('POST','/api/internal/bot-management',{fromBotId:t.b.id,targetBotId:target.id,action:'get'},t.auth);expect(get.status).toBe(200);
 const moved=await api('POST','/api/internal/bot-management',{fromBotId:t.b.id,targetBotId:target.id,action:'move',section:'R1 destination',revision:get.body.bot.revision,organizationRevision:get.body.organizationRevision},t.auth);
 expect(moved.status,JSON.stringify(moved.body)).toBe(200);expect((await api('GET',`/api/bots/${target.id}`)).body.bot.section).toBe('R1 destination');await noCards(t);
 }finally{await stop(t);}
},60000);
it('R2 No limits automation asks and delegates across restricted team rosters',async()=>{
 const b=await bot('R2 automation'),target=await bot('R2 restricted peer',false);
 expect((await api('PATCH',`/api/bots/${target.id}`,{section:'R2 separate team'})).status).toBe(200);
 const busy=await turn(target),t=await turn(b,true);
 try{for(const route of ['ask-bot','delegate-bot']){
 const out=await api('POST','/api/internal/'+route,{fromBotId:b.id,fromThreadId:t.threadId,toBotId:target.id,message:'__fixture_hold_authority__ R2 dispatched '+route},t.auth);
 expect(out.status,JSON.stringify(out.body)).toBe(200);expect(out.body.taskId,JSON.stringify(out.body)).toEqual(expect.any(String));expect(out.body.error).toBeUndefined();expect(out.body.held).toBeUndefined();
 }
 writeFileSync(`${fixture.fixtureFinishGateDir}/${busy.dump.pid}`,'finish');
 writeFileSync(`${fixture.fixtureFinishGateDir}/${t.dump.pid}`,'finish');
 for(const route of ['ask-bot','delegate-bot']){
   let dispatched:any;
   await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(l=>l.includes('__fixture_hold_authority__ R2 dispatched '+route));if(!line)return false;dispatched=JSON.parse(line);return true;}catch{return false;}},{timeout:30000}).toBe(true);
   writeFileSync(`${fixture.fixtureFinishGateDir}/${dispatched.pid}`,'finish');
 }
 await noCards(t);
 }finally{await stop(t);await stop(busy);}
},120000);
it('R2 lower-level automation retains restricted team rosters',async()=>{
 const b=await bot('R2 lower',false),target=await bot('R2 lower peer');
 await api('PATCH',`/api/bots/${target.id}`,{section:'R2 other lower team'});
 const t=await turn(b,'ask');try{for(const route of ['ask-bot','delegate-bot']){
 const out=await api('POST','/api/internal/'+route,{fromBotId:b.id,fromThreadId:t.threadId,toBotId:target.id,message:'lower work'},t.auth);expect(out.status).toBe(403);
 }}finally{await stop(t);}
},60000);
it('R3 No limits handoffs run after six wakes and thirty minutes without owner continue',async()=>{
 const t=await turn(await bot('R3 cap')),target=await bot('R3 peer');
 try{const out=await delegate(t,target,'Work after old owner-message cap');expect(out.body,JSON.stringify(out.body)).toMatchObject({queued:true});await noCards(t);}finally{await stop(t);}
},60000);
it('R3 lower levels retain the owner-message conversation cap',async()=>{
 const t=await turn(await bot('R3 lower cap',false)),target=await bot('R3 lower peer');
 try{const out=await delegate(t,target,'Lower work after cap');expect(JSON.stringify(out.body)).toContain('continue');expect(out.body.queued).not.toBe(true);}finally{await stop(t);}
},60000);
it('R4 No limits handoffs activate staged targets and run without held allowances',async()=>{
 const a=await bot('R4 staged ask'),d=await bot('R4 staged delegate'),t=await turn(await bot('R4 sender'));
 try{
 // Keep ask on the durable queue path after activating the staged target.
 const delegated=await delegate(t,d,'__fixture_hold_authority__ staged delegate');expect(delegated.body,JSON.stringify(delegated.body)).toMatchObject({queued:true});expect(delegated.body.held).toBeUndefined();
 // Fixture target is busy so ask uses its durable path.
 for(let i=0;i<22;i++){const out=await api('POST','/api/internal/ask-bot',{fromBotId:t.b.id,fromThreadId:t.threadId,toBotId:a.id,message:'staged ask '+i},t.auth);expect(out.body.taskId,JSON.stringify(out.body)).toEqual(expect.any(String));expect(out.body.error).toBeUndefined();expect(out.body.held).toBeUndefined();}
 expect((await api('GET',`/api/bots/${d.id}`)).body.bot.staged).toBeUndefined();await noCards(t);
 }finally{await stop(t);}
},120000);
it('R4 No limits routine creation activates a staged target without owner review',async()=>{
 const target=await bot('R4 staged routine'),t=await turn(await bot('R4 routine sender'));
 try{
 const out=await api('POST','/api/internal/routine-requests',{fromBotId:t.b.id,fromThreadId:t.threadId,action:'create',forBotId:target.id,routine:{name:'R4 scheduled now',instructions:'Fixture only',schedule:{type:'interval',everyMinutes:60}}},t.auth);
 expect(out.status,JSON.stringify(out.body)).toBe(201);expect(out.body.autoApproved).toBe(true);
 const routines=(await api('GET','/api/routines')).body.routines;expect(routines.some((r:any)=>r.botId===target.id&&r.name==='R4 scheduled now')).toBe(true);
 expect((await api('GET',`/api/bots/${target.id}`)).body.bot.staged).toBeUndefined();await noCards(t);
 }finally{await stop(t);}
},60000);
it('R5 No limits own-management lists every routine and webhook beyond 100',async()=>{
 const b=await bot('R5 listings');const routineIds=[],hookIds=[];
 for(let i=0;i<105;i++){
 const r=await api('POST','/api/routines',{botId:b.id,name:'R5 routine '+i,prompt:'Fixture only',enabled:false,schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});expect(r.status).toBe(201);routineIds.push(r.body.routine.id);
 const w=await api('POST','/api/webhooks',{botId:b.id,name:'R5 webhook '+i,prompt:'Fixture only',enabled:false});expect(w.status).toBe(201);hookIds.push(i);
 }
 const t=await turn(b);try{
 const out=await api('GET',`/api/internal/routines?fromBotId=${b.id}&fromThreadId=${t.threadId}`,undefined,t.auth);expect(out.status).toBe(200);
 expect(out.body.routines.map((r:any)=>r.id).sort()).toEqual(routineIds.sort());expect(out.body.webhooks).toHaveLength(105);expect(new Set(out.body.webhooks.map((w:any)=>w.webhookId)).size).toBe(105);await noCards(t);
 }finally{await stop(t);}
},120000);
