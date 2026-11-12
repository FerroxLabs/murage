// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { raiseLevel } from './testing/raise-level.ts';
let fixture: VerificationServer, desktop: Record<string,string>;
const evidence: unknown[] = [];
// Seed an isolated paired device; all dispatch, RPC, job, poll, lease and result paths run unchanged.
const instrumentation = `
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';process.env.FAKE_CLAUDE_MODE='hang';
process.env.MURAGE_PHONE_CALL_SECRETS=JSON.stringify({key:'fixture-only',origin:'https://api.vapi.ai'});
const fs=await import('node:fs'),path=await import('node:path');
const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
cfg.features={...cfg.features,phoneTools:true};fs.writeFileSync(file,JSON.stringify(cfg));
const baseline=${JSON.stringify(process.env.GNL_MOUNTS_BASELINE==='1')};
const mutant=${JSON.stringify(process.env.GNL_MOUNTS_MUTANT??'')};
const sourceFor=url=>{
 const original=new URL(url),relative=path.relative(process.cwd(),original.pathname),saved=path.join(process.cwd(),'.gnl-mounts-base',relative);
 let source=fs.readFileSync(baseline&&fs.existsSync(saved)?saved:original,'utf8');
 const change=(before,after)=>{if(!source.includes(before))throw Error('mutant anchor missing: '+mutant);source=source.replace(before,after);};
 if(mutant==='f1-mount'&&relative==='server/index.ts')change('serviceNoLimits(dispatchClaimId, threadId, bot.id) && phonesOfferedNow()', 'false && phonesOfferedNow()');
 if(mutant==='f2-decline'&&relative==='server/event-limit.ts')change('if (!noLimits && ctx.routines.eventKindDeclined', 'if (ctx.routines.eventKindDeclined');
 if(mutant==='f3-child'&&relative==='server/app-trigger-zero.ts'){
 change('if (context.generation ? serviceNoLimits(context.generation, context.threadId) : serviceThreadNoLimits(context.threadId)) return null;', '');
 change('const run = appRunFor(context.threadId);', 'const run = wiring!.lineage.findByThread(context.threadId);');
 }
 if(mutant==='f4-role'&&relative==='server/bot-management.ts')change('const noLimits = Boolean(options.threadId && serviceThreadNoLimits(options.threadId, sender.id));', 'const noLimits = false;');
 return source;
};
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(url.endsWith('/server/index.ts')){
 let source=sourceFor(url);
 source=source.replace('phoneRegistryOnce = new PhoneRegistry(database(), () => Date.now());',\`phoneRegistryOnce = new PhoneRegistry(database(), () => Date.now());phoneRegistryOnce.put('11111111-1111-4111-8111-111111111111',{...JSON.parse(fsForFixture.readFileSync(new URL('../apps/mobile/contract/phone-jobs.json',import.meta.url),'utf8')).registration.valid,name:'Fixture phone'});\`);
 source=source.replace('const internalEventId = internalOwner.eventId;',\`const internalEventId = internalOwner.eventId;
 if(internalEventId && store.bot(internalClaim.botId)?.name==='F2 saved decline')routines.declineEventKind(internalEventId,'handoff');\`);
 source=source.replace('internalTurnOwners.get(threadId)!.triggerMessageId = userMessage.id;',\`internalTurnOwners.get(threadId)!.triggerMessageId = userMessage.id;
 if(bot.name.startsWith('F3 app')){
 const apps=appTriggerStore(),runId=dispatchClaimId;
 apps.create({runId,batchId:runId,triggerId:'fixture-trigger',routineId:'fixture-app-routine',botId:bot.id,ownerAccountId:'fixture-owner',subscriptionId:'fixture-subscription',policyDigest:'fixture-policy',billingRef:'fixture-no-billing',now:Date.now()});
 apps.update(runId,{state:'running',submitted:true,threadId,generation:dispatchClaimId},Date.now());
 }\`);
 source=source.replace('const partitionCaller = store.bot(internalClaim.botId);',\`const partitionCaller = store.bot(internalClaim.botId);
 if(partitionCaller?.name==='F4 partition'){
 partitionCaller.partitionedAt=1;
 store.taskByThread(partitionCaller.id,internalClaim.threadId).sharedWork={teamId:'fixture-other-team',createdAt:Date.now()};
 }\`);
 source="import * as fsForFixture from 'node:fs';\\n"+source;
 return {format:'module-typescript',shortCircuit:true,source};
 }
 if(url.endsWith('/server/phones/rpc.ts'))return {format:'module-typescript',shortCircuit:true,source:sourceFor(url).replace('} catch {','} catch (error) { console.error("fixture phone RPC", error);')};
 const saved=url.startsWith('file:')?path.join(process.cwd(),'.gnl-mounts-base',path.relative(process.cwd(),new URL(url).pathname)):'';
 if((baseline&&fs.existsSync(saved))||(mutant&&url.startsWith('file:')&&['/server/event-limit.ts','/server/app-trigger-zero.ts','/server/bot-management.ts'].some(s=>url.endsWith(s))))return {format:'module-typescript',shortCircuit:true,source:sourceFor(url)};
 return next(url,context);
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
 expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off',browser:false,composio:false,autoReview:'off',phoneApps:{calendar:'read',location:'approximate'}})).status).toBe(200);
 if(noLimits)expect((await raiseLevel(api,b.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 return b;
}
async function turn(b:any,routine=false){
 const marker='__fixture_hold_authority__ '+b.name;
 let threadId=b.threadId;
 if(routine){
 const made=await api('POST','/api/routines',{botId:b.id,name:b.name,prompt:marker,permissionMode:'unlimited',enabled:false,schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});expect(made.status).toBe(201);
 const started=await api('POST',`/api/routines/${made.body.routine.id}/run`,{});expect(started.status).toBe(201);
 threadId=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===started.body.run.id).threadId;
 }else expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId,text:marker})).status).toBe(202);
 let dump:any;
 await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(l=>l.includes(marker));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig?.mcpServers?.agents);}catch{return false;}},{timeout:30000}).toBe(true);
 return {b,threadId,dump,auth:{authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}};
}
async function webhookTurn(b:any){
 const marker='__fixture_hold_authority__ '+b.name;
 const hook=await api('POST','/api/webhooks',{name:b.name,prompt:marker,botId:b.id,runOn:'ember'});expect(hook.status).toBe(201);
 const delivered=await fetch(hook.body.credential.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixture:'ping'})});expect(delivered.status).toBe(202);
 const runId=(await delivered.json() as any).runId;
 let dump:any;
 await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(l=>l.includes(marker));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig?.mcpServers?.agents);}catch{return false;}},{timeout:30000}).toBe(true);
 const run=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===runId);
 return {b,threadId:run.threadId,dump,auth:{authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}};
}
async function delegate(t:any,target:any,message:string){return api('POST','/api/internal/delegate-bot',{fromBotId:t.b.id,fromThreadId:t.threadId,toBotId:target.id,message},t.auth);}
async function noCards(t:any){const rows=(await api('GET',`/api/threads/${t.threadId}/messages?limit=200`)).body.messages;expect(rows.filter((m:any)=>m.card&&!m.card.intake&&!m.card.answered)).toEqual([]);}
async function deviceCall(auth:Record<string,string>,tool:string,args:unknown,result:unknown,beforeLease?:()=>Promise<unknown>){
 const headers={'x-murage-phone-device':'11111111-1111-4111-8111-111111111111','x-murage-phone-scope':'jobs'};
 const pending=api('POST','/api/internal/device/call',{tool,args},auth);
 const polled=await api('GET','/api/phones/self/jobs',undefined,headers);expect(polled.status).toBe(200);
 const job=polled.body.jobs[0];expect(job).toBeDefined();expect(job.permission).toBe('run');if(beforeLease)await beforeLease();
 const leased=await api('POST',`/api/phones/self/jobs/${job.operationId}/lease`,{offerId:job.offerId},headers);expect(leased.body.active).toBe(true);
 const done=await api('POST',`/api/phones/self/jobs/${job.operationId}/result`,{leaseToken:leased.body.leaseToken,ok:true,result},headers);expect(done.status,JSON.stringify(done.body)).toBe(200);
 expect((await pending).body).toMatchObject({ok:true});
}
async function stop(t:any){await api('POST',`/api/bots/${t.b.id}/interrupt`,{threadId:t.threadId});}
beforeAll(async()=>{fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation,dumpLog:true});desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret',undefined,{})).body.secret};},120000);
afterAll(async()=>{mkdirSync('evidence/gnl-mounts',{recursive:true});if(fixture)writeFileSync('evidence/gnl-mounts/server.log',readFileSync(fixture.info.logPath));writeFileSync('evidence/gnl-mounts/workflows.json',JSON.stringify({fixture:fixture?.info,evidence},(key,value)=>/token|secret|credential|authorization/i.test(key)?'[redacted]':value,2));await fixture?.close();});
it('F1 No limits routine mounts phone jobs and call tools, bypasses grants and precision',async()=>{
 const t=await turn(await bot('F1 phones'),true);
 try{
 const servers=t.dump.mcpConfig.mcpServers;
 expect(servers.phoneJobs,'routine must mount phone jobs').toBeDefined();
 const auth={authorization:'Bearer '+servers.phoneJobs.env.MURAGE_CONTROL_TOKEN};
 await deviceCall(auth,'phone_calendar_add',{title:'Fixture',start:'2026-11-12T20:00:00Z',end:'2026-11-12T21:00:00Z'},{id:'fixture-event',writeOnly:false},()=>api('PATCH',`/api/bots/${t.b.id}`,{phoneApps:{}}));
 await deviceCall(auth,'phone_location_get',{precision:'precise'},{lat:1,lon:2,accuracyMeters:5,precision:'precise',at:'2026-11-12T20:00:00Z'});
 const registration={...JSON.parse(readFileSync(new URL('../apps/mobile/contract/phone-jobs.json',import.meta.url),'utf8')).registration.valid,name:'Fixture phone'};
 const phone={'x-murage-phone-device':'11111111-1111-4111-8111-111111111111','x-murage-phone-scope':'jobs'};
 expect((await api('PUT','/api/phones/self',{...registration,capabilities:{calendar:'full'}},phone)).status).toBe(200);
 const unavailable=await api('POST','/api/internal/device/call',{tool:'phone_location_get',args:{precision:'precise'}},auth);expect(unavailable.body).toMatchObject({ok:false,code:'unsupported'});expect(unavailable.body.text).toContain("phone's app permissions");
 expect((await api('PUT','/api/phones/self',registration,phone)).status).toBe(200);
 const call=await api('POST','/api/internal/phone/phone_call_result',{call:'fixture-unknown'},t.auth);expect(call.status).toBe(200);expect(call.body).toEqual({error:'not_found'});
 }finally{await stop(t);}
},60000);
it('F1 lower levels retain granular phone grants',async()=>{
 const t=await turn(await bot('F1 lower',false));try{
 const s=t.dump.mcpConfig.mcpServers.phoneJobs;expect(s).toBeDefined();
 const out=await api('POST','/api/internal/device/call',{tool:'phone_location_get',args:{precision:'precise'}},{authorization:'Bearer '+s.env.MURAGE_CONTROL_TOKEN});expect(out.body).toMatchObject({ok:false,code:'refused'});
 }finally{await stop(t);}
},60000);

it('F2 No limits ignores a saved event Not now through a real webhook handoff',async()=>{
 const b=await bot('F2 saved decline'),target=await bot('F2 decline peer');
 const t=await webhookTurn(b);try{const out=await delegate(t,target,'Continue after the saved decline');expect(out.status,JSON.stringify(out.body)).toBe(200);expect(out.body).toMatchObject({queued:true});await noCards(t);}finally{await stop(t);}
},60000);
it('F2 No limits admits more than per-turn and root handoff allowances',async()=>{
 const t=await turn(await bot('F2 budgets'));const target=await bot('F2 budget peer');
 try{for(let i=0;i<36;i++){const out=await delegate(t,target,`Fixture job ${i}`);expect(out.status,JSON.stringify(out.body)).toBe(200);expect(out.body,`handoff ${i}: ${JSON.stringify(out.body)}`).toMatchObject({queued:true});}const one=await delegate(t,target,'Same payload'),two=await delegate(t,target,'Same payload');expect(one.body).toMatchObject({queued:true});expect(two.body).toMatchObject({queued:true});expect(two.body.taskId).not.toBe(one.body.taskId);await noCards(t);}finally{await stop(t);}
},60000);
it('F3 No limits app-event lineage admits ask and delegate without a refusal card',async()=>{
 const t=await turn(await bot('F3 app unlimited'));const target=await bot('F3 peer');
 try{
 const out=await delegate(t,target,'App-event delegation');expect(out.body).toMatchObject({queued:true});
 // A busy target makes ask use its durable queue path, including the recovered child guard.
 const busy=await turn(target);
 try{const asked=await api('POST','/api/internal/ask-bot',{fromBotId:t.b.id,fromThreadId:t.threadId,toBotId:target.id,message:'App-event ask'},t.auth);expect(asked.body.code).not.toBe('app_child_not_allowed');expect(asked.body.error).toBeUndefined();}finally{await stop(busy);}
 await noCards(t);
 }finally{await stop(t);}
},60000);
it('F3 lower-level app-event lineage still refuses children',async()=>{
 const t=await turn(await bot('F3 app ask',false));const target=await bot('F3 lower peer');try{
 const out=await delegate(t,target,'Lower-level app event');expect(out.status).toBe(403);expect(out.body.code).toBe('app_child_not_allowed');
 }finally{await stop(t);}
},60000);
it('F4 ordinary No limits bot creates and manages bots and schedules across rosters',async()=>{
 const b=await bot('F4 ordinary'),target=await bot('F4 other team');expect((await api('PATCH',`/api/bots/${target.id}`,{section:'Other fixture team'})).status).toBe(200);
 const t=await turn(b);try{
 const created=await api('POST','/api/internal/create-bot',{fromBotId:b.id,fromThreadId:t.threadId,name:'F4 created',role:'Fixture worker',instructions:'Only fixture work'},t.auth);expect(created.status,JSON.stringify(created.body)).toBe(201);expect(created.body.staged).not.toBe(true);
 const get=await api('POST','/api/internal/bot-management',{fromBotId:b.id,targetBotId:target.id,action:'get'},t.auth);expect(get.status,JSON.stringify(get.body)).toBe(200);
 const updated=await api('POST','/api/internal/bot-management',{fromBotId:b.id,targetBotId:target.id,action:'update',revision:get.body.bot.revision,instructions:'Changed by ordinary No limits bot'},t.auth);expect(updated.status,JSON.stringify(updated.body)).toBe(200);
 expect((await api('GET',`/api/bots/${target.id}`)).body.bot.description).toBe('Changed by ordinary No limits bot');
 const routine=await api('POST','/api/internal/routine-requests',{fromBotId:b.id,fromThreadId:t.threadId,action:'create',forBotId:target.id,routine:{name:'Cross roster fixture',instructions:'Only fixture work',schedule:{type:'interval',everyMinutes:60}}},t.auth);expect(routine.status,JSON.stringify(routine.body)).toBe(201);expect(routine.body.autoApproved).toBe(true);await noCards(t);
 }finally{await stop(t);}
},60000);
it('F1 a switched-off phone feature stays off with one settings line and no card',async()=>{
 const t=await turn(await bot('F1 phone off'));
 try{
 const server=t.dump.mcpConfig.mcpServers.phoneJobs;expect(server).toBeDefined();
 expect((await api('PATCH','/api/config',{features:{phoneTools:false}})).status).toBe(200);
 const out=await api('POST','/api/internal/device/call',{tool:'phone_location_get',args:{precision:'precise'}},{authorization:'Bearer '+server.env.MURAGE_CONTROL_TOKEN});
 expect(out.body).toMatchObject({ok:false,code:'off'});expect(out.body.text).toMatch(/^Phone tools are off\..*Settings/);expect(out.body.text.split('\n')).toHaveLength(1);await noCards(t);
 }finally{await api('PATCH','/api/config',{features:{phoneTools:true}});await stop(t);}
},60000);

it('F2 No limits handoffs continue beyond the old chain depth',async()=>{
 const bots=[];for(let i=0;i<4;i++)bots.push(await bot(`F2 chain ${i}`));
 let t=await turn(bots[0]);
 try{for(let i=1;i<4;i++){
 const marker=`__fixture_hold_authority__ F2 chain hop ${i}`;
 const out=await delegate(t,bots[i],marker);expect(out.body,JSON.stringify(out.body)).toMatchObject({queued:true});
 writeFileSync(`${fixture.fixtureFinishGateDir}/${t.dump.pid}`,'finish');
 let dump:any;
 await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(l=>l.includes(marker));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig?.mcpServers?.agents);}catch{return false;}},{timeout:30000}).toBe(true);
 const env=dump.mcpConfig.mcpServers.agents.env;
 t={b:bots[i],threadId:env.MURAGE_THREAD_ID,dump,auth:{authorization:'Bearer '+env.MURAGE_COMMS_TOKEN}};
 }await noCards(t);
 }finally{await stop(t);}
},120000);

it('F4 No limits own tools bypass source partitions and list bots across rosters',async()=>{
 const t=await turn(await bot('F4 partition')),target=await bot('F4 partition target');
 expect((await api('PATCH',`/api/bots/${target.id}`,{section:'Another fixture section'})).status).toBe(200);
 try{
 const roster=await api('GET',`/api/internal/agents?self=${t.b.id}`,undefined,t.auth);expect(roster.status).toBe(200);expect(roster.body.bots.map((b:any)=>b.id)).toContain(target.id);
 const get=await api('POST','/api/internal/bot-management',{fromBotId:t.b.id,targetBotId:target.id,action:'get'},t.auth);expect(get.status,JSON.stringify(get.body)).toBe(200);expect(get.body.bot.id).toBe(target.id);
 const changed=await api('POST','/api/internal/bot-management',{fromBotId:t.b.id,targetBotId:target.id,action:'update',revision:get.body.bot.revision,instructions:'Managed from a partition'},t.auth);expect(changed.status,JSON.stringify(changed.body)).toBe(200);await noCards(t);
 }finally{await stop(t);}
},60000);
