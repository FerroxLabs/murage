import {beforeEach,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
const fake=vi.hoisted(()=>{
 vi.resetModules();
 return {scenario:'run',sources:new Map<any,any>(),records:new Map<string,any>(),presented:[] as any[],base:0,
   openRequest:vi.fn(),decide:vi.fn(),executeService:vi.fn(),executeServiceSync:vi.fn(),presentApproval:vi.fn(),presentApprovalSync:vi.fn(),readApproval:vi.fn(),attachQueue:vi.fn(),readTurnPolicy:vi.fn(),answerApproval:vi.fn(),answerApprovalSync:vi.fn(),settle:vi.fn(),lookupApproval:vi.fn(),openApprovals:vi.fn(()=>[])};
});
vi.mock('../decision/index.ts',()=>fake);
import {serviceQueue,ProducerApprovalQueue,requestSkillApproval} from '../narrow-denials.ts';
import {ImageOperations} from '../image-operations.ts';
import {PublishOperations} from '../publish/publish-ops.ts';
import {requestPeerApproval,requestEventLimitApproval} from '../peer-approval.ts';
import {awaitHostComputerConsent} from '../host-computer-consent.ts';
import {BrowserExtensionApprovals} from '../browser-extension-approvals.ts';
import {BrowserExtensionSetup} from '../browser-extension-setup.ts';
import {RoutineRequestService} from '../routine-requests.ts';
import {WebhookManager} from '../webhooks.ts';
import {ownToolGate} from '../outside-own.ts';
import {markTurnOutside,beginOutsideTurn} from '../email/external-marks.ts';
import {RoutineManager} from '../routines.ts';
import {requestMcpEnable} from '../mcp-bot-cards.ts';
import {PhoneJobs} from '../phones/jobs.ts';
import {requestBotAccess,botAccessApprovalQueue,installBotAccessApprovalAccounts} from '../bot-access.ts';
import {EmailSendService} from '../email/send-service.ts';
import {database,transaction} from '../database.ts';
import {setExecutionStore} from '../execution-audience.ts';
import {setMemoryCaptureRoster} from '../memory/capture-scope.ts';
import {setMemoryMode} from '../memory/repository.ts';
import {reconcileMemoryRoster} from '../memory/policy.ts';
import {appendMessage} from '../message-db.ts';
import {askOwnerToShare,shareRequestedExcerpts,roomShareApprovalQueue} from '../room-shares.ts';
import {DATA_DIR} from '../config.ts';
import {classified} from './card-class.test.ts';

let queues:ProducerApprovalQueue[]=[];
let deliveries:Promise<void>[]=[];
const authority:any={claim:{fixture:true},proof:{reference:'isolated-server-source'},identity:{threadId:'thread',generation:'generation'}};
const ownPolicy={bot:{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true},origin:'owner' as const};
const bot:any={id:'bot',name:'Bot',color:'blue',threadId:'thread',chiefOfStaff:true};
const store:any={appendMessage:vi.fn(()=>{throw new Error('direct producer row write');}),messageById:()=>null,bots:[bot],groups:[]};
const bus:any={store,broadcast:()=>{},authorityFor:()=>authority};
const actor:any={authority,botId:'bot',threadId:'thread',generation:'generation',signal:new AbortController().signal,assertActive:()=>{}};
function deliver(ref:any){
 const record=fake.records.get(ref.approvalId);fake.presented.push(record);
 expect(classified(record.action),record.source.service).toBe(true);
 // Transport acknowledges only the exact persisted item. The response is Deny
 // so denied and guest fixtures never perform any service side effect.
 deliveries.push(Promise.resolve().then(async()=>{
  const queue=queues.find(q=>q.pendingApprovals().some(i=>i.approvalId===ref.approvalId))??serviceQueue(record.source.service);
  const item=queue.pendingApprovals().find(i=>i.approvalId===ref.approvalId)!;
  expect(item).toBeDefined();
  const delivery=await queue.respond(item,{behavior:'deny'},{answerId:`answer-${ref.approvalId}`});
  expect(delivery.state,record.source.service).toBe('accepted');record.state='answered';
 }));
}
beforeEach(()=>{
 queues=[];deliveries=[];mkdirSync(DATA_DIR,{recursive:true});fake.base=0;fake.sources.clear();fake.records.clear();fake.presented=[];vi.clearAllMocks();
 fake.openRequest.mockImplementation(source=>{const handle={};fake.sources.set(handle,source);return handle;});
 fake.decide.mockImplementation((handle,base)=>{
  const source=fake.sources.get(handle);
  if(fake.scenario==='guest'){fake.base++;const verdict=base({source});if(verdict.approve)return {kind:'run'};}
  if(fake.scenario==='run')return {kind:'run'};
  const ref={approvalId:randomUUID()};fake.records.set(ref.approvalId,{ref,state:'open',threadId:'thread',botId:'bot',requestId:source.call.approval.queueRef,chatMessageId:randomUUID(),actionHash:'a'.repeat(64),queue:{kind:source.service,ref:source.call.approval.queueRef,epoch:source.call.approval.epoch},action:source.call.approval.action,source});return {kind:'card',ref};
 });
 fake.executeService.mockImplementation(async(handle,operation)=>({kind:'executed',value:await operation(fake.sources.get(handle).call)}));
 fake.executeServiceSync.mockImplementation((handle,operation)=>({kind:'executed',value:operation(fake.sources.get(handle).call)}));
 fake.presentApproval.mockImplementation(async(ref)=>deliver(ref));fake.presentApprovalSync.mockImplementation(ref=>deliver(ref));
 fake.readApproval.mockImplementation(id=>fake.records.get(id));
 fake.readTurnPolicy.mockImplementation(()=>({permission:{noLimits:fake.scenario==='run'}}));
});
const cases:Array<[string,()=>Promise<unknown>|unknown]>=[
 ['image',()=>{const p=new ImageOperations({store,waiting:()=>{}});return (p as any).approve(actor,{connectionId:'fake',provider:'openai',model:'fake',operation:'generate',count:1,referenceCount:0},{prompt:'rm -rf ~'});} ],
 ['image-failure',()=>{const p=new ImageOperations({store,waiting:()=>{},autoApproval:()=>{throw new Error('fixture-reader');}});return (p as any).approve(actor,{connectionId:'fake',provider:'openai',model:'fake',operation:'generate',count:1,referenceCount:0},{prompt:'rm -rf ~'});}],
 ['publish',()=>{const p=new PublishOperations({store,waiting:()=>{},token:()=>undefined,workspaceFor:()=>undefined});return (p as any).approve(actor,{title:'Publish this site?',subtitle:'fixture',held:'rm -rf ~',data:{action:'publish',host:'netlify',url:'https://fixture.example.test'},pushBody:'fixture'});} ],
 ['peer',()=>requestPeerApproval(bus,bot,{...bot,id:'target',name:'Target'},'rm -rf ~','ask_bot')],
 ['event-limit',()=>requestEventLimitApproval(bus,bot,'handoff',4,'event','thread','Target')],
 ['host-computer',()=>awaitHostComputerConsent(bus,bot,'thread',1000)],
 ['browser-action',()=>new BrowserExtensionApprovals(bus).ask({bot,threadId:'thread',bindingId:'binding',generation:1,digest:'a'.repeat(64),summary:'rm -rf ~',call:{tool:'agent_browser_fill',input:{origin:'https://fixture.example.test',text:'rm -rf ~'}}})],
 ['browser-setup',()=>{const s:any={...store,newestMatching:()=>({id:'owner-message',text:'fixture',role:'user'}),keyedCards:()=>[]};return new BrowserExtensionSetup({store:s,authorityFor:()=>authority,owner:()=>bot,startHelper:async()=>{},status:()=>({profiles:[{profileId:'profile',browser:'chrome'}],bindings:[]}),optIn:()=>{},continueTask:async()=>{}}).request('bot','thread','rm -rf ~');}],
 ['routine',async()=>{const routines=new RoutineManager({file:join(DATA_DIR,`${randomUUID()}.json`),botState:()=> 'busy',createTask:()=>null,startTurn:async()=>{}});const p=new RoutineRequestService({store:{...store,messagesFor:()=>[],patchMessage:()=>null},routines});queues.push(p.approvalQueue());return p.propose({authority,botId:'bot',threadId:'thread',proposal:{action:'create',routine:{name:'fixture',instructions:'rm -rf ~',schedule:{type:'weekly',time:'09:00',weekdays:['monday']}}}});}],
 ['webhook',async()=>{const routines=new RoutineManager({file:join(DATA_DIR,`${randomUUID()}.json`),botState:()=> 'busy',createTask:()=>null,startTurn:async()=>{}});const webhooks=new WebhookManager({file:join(DATA_DIR,`${randomUUID()}.json`),botState:()=> 'busy',enqueue:()=>({id:'fixture-run'})});const p=new RoutineRequestService({store:{...store,messagesFor:()=>[],patchMessage:()=>null},routines,webhooks:()=>webhooks});queues.push(p.approvalQueue());return p.propose({authority,botId:'bot',threadId:'thread',proposal:{kind:'webhook',action:'create',webhook:{name:'fixture',instructions:'rm -rf ~'}}});}],
 ['skill',()=>{
  const requestId=randomUUID(),execute=vi.fn();
  const result=requestSkillApproval({authority,ref:requestId,tool:'skill_manage',input:{stagedId:'fixture',sha256:'a'.repeat(64),files:[{path:'SKILL.md',content:'rm -rf ~'}]},action:{tool:'skill_manage',options:['Enable','Deny'],skillRequest:{requestId,stagedId:'fixture',sha256:'a'.repeat(64)}},view:{title:'Enable skill',subtitle:'fixture'},base:{approve:null,source:'no-grant'} as any},execute);
  expect(result.kind).toBe(fake.scenario==='run'?'executed':'card');expect(execute).toHaveBeenCalledTimes(fake.scenario==='run'?1:0);return result;
 }],
 ['mcp',()=>{const execute=vi.fn();const result=requestMcpEnable(authority,'fixture',{command:'fixture',args:[],env:{},enabled:false},'revision',bot,execute);expect(result.kind).toBe(fake.scenario==='run'?'executed':'card');expect(execute).toHaveBeenCalledTimes(fake.scenario==='run'?1:0);return result;}],
 ['phone',async()=>{const p=new PhoneJobs({authorityFor:()=>authority,now:Date.now,setTimer:()=>()=>{},push:{park:()=>{},withdraw:()=>{}},ids:randomUUID,leaseToken:randomUUID});queues.push(p.approvalQueue());const requested=p.request({authority:{botId:'bot',threadId:'thread',generation:'generation'} as any,deviceId:'device',capability:'messages',action:'send_message',args:{text:'rm -rf ~'},say:'fixture',provider:{id:'fake',name:'Fake'}});if(fake.scenario==='run'){const [offer]=await p.poll('device',new AbortController().signal);expect(offer.permission).toBe('run');expect(offer.args).toEqual({text:'rm -rf ~'});}return requested;}],
 ['bot-access',()=>{const target:any={id:'target',name:'Target',threadId:'target-thread',composio:true};const s:any={bot:(id:string)=>id==='target'?target:bot,patchBot:(_id:string,patch:any)=>Object.assign(target,patch)};queues.push(botAccessApprovalQueue(s));return requestBotAccess(s,bot,{botId:'target',revision:0,grants:[{toolkit:'gmail',accountId:'account',tools:['GMAIL_FETCH_EMAILS']}],allowWrites:false},Date.now(),{authority,threadId:'thread',accounts:[{toolkit:'gmail',accountId:'account'}]});}],
 ['room-share',()=>{
  const roster:any={bots:[{...bot,threadId:'share-direct'}],groups:[{id:'share-room',name:'Room',threadId:'thread',memberIds:['bot']}]};
  setExecutionStore({...roster,bot:()=>roster.bots[0],group:()=>roster.groups[0]} as any);
  setMemoryCaptureRoster(()=>roster);setMemoryMode('active');reconcileMemoryRoster(roster);
  appendMessage('share-direct',{id:randomUUID(),at:Date.now(),role:'user',kind:'text',text:'fixture excerpt',origin:'desktop'} as any);
  const db=database();queues.push(roomShareApprovalQueue(db));
  const result=askOwnerToShare(db,roster,{authority,botId:'bot',threadId:'thread',query:'fixture excerpt',from:'my-chats'});
  expect(result.ok).toBe(true);if(result.ok)expect(result.autoRun).toBe(fake.scenario==='run');
  if(result.ok&&result.autoRun&&result.share){
   const append=vi.fn((_thread,line,id,within)=>{within();return {...line,id,at:Date.now()};});
   expect(shareRequestedExcerpts(db,roster,{message:()=>null,append} as any,result.share,f=>transaction(()=>f()))).toMatchObject({ok:true});
  }
 }],
 ['email',async()=>{
   const rows=new Map<string,any>(),payloads=new Map<string,any>();
   const s:any={tx:(f:any)=>f(),getBinding:()=>({state:'active',inboxId:'inbox',policy:'ask'}),sendsByHash:()=>[],insertSend:(r:any)=>rows.set(r.sendId,r),putPayload:(id:string,p:any)=>payloads.set(id,p),getPayload:(id:string)=>payloads.get(id),getSend:(id:string)=>rows.get(id),isApproved:()=>false,casSend:(id:string,rev:number,patch:any)=>{const row=rows.get(id);if(row.revision!==rev)return null;const next={...row,...patch,revision:rev+1};rows.set(id,next);return next;}};
   const client:any={send:async()=>({kind:'ok',body:{status:'sent',message_id:'fixture'},keyId:'fake'})};
   const p=new EmailSendService({store:s,client,installId:'fixture',authorityFor:()=>authority});queues.push(p.approvalQueue());
   return p.submit({botId:'bot',threadId:'thread',generation:1,draft:{kind:'send',to:['recipient@example.test'],cc:[],subject:'rm -rf ~',text:'rm -rf ~',attachments:[],replyTo:null}});
 }],
];
for(const [name,run]of cases)for(const scenario of ['run','deny','guest'])it(`${name}: ${scenario==='run'?'owner RUN, content is data':scenario==='deny'?'deny remains CARD':'guest keeps BASE'} via decision/index`,async()=>{
 fake.scenario=scenario;
 await run();
 await vi.waitFor(()=>expect(fake.sources.size).toBeGreaterThan(0));
 expect(fake.presented.length).toBe(scenario==='run'?0:1);
 expect(fake.base).toBe(scenario==='guest'?1:0);
 const sources=[...fake.sources.values()];expect(sources[0].claim).toBe(authority.claim);
 expect(Object.isFrozen(sources[0].call)).toBe(true);
 await Promise.all(deliveries);
});

for(const outside of ['web page','earlier turn','cloned folder'] as const)it(`Sable S2: owner routine create/run after ${outside} is never refused`,()=>{
 fake.scenario='run';beginOutsideTurn('outside-thread','instance','turn',false);markTurnOutside('outside-thread',outside as any);
 for(const tool of ['propose_routine','propose_routine_action','request_bot_access','register_artifact']){
  expect(ownToolGate({authority,...ownPolicy,threadId:'outside-thread',botId:'bot',tool,lane:true})).toBeNull();
 }
 fake.readTurnPolicy.mockReturnValue({permission:{noLimits:false}});
 // A stale stored policy cannot overrule the current bot and proven origin.
 expect(ownToolGate({authority,...ownPolicy,threadId:'outside-thread',botId:'bot',tool:'propose_routine',lane:true})).toBeNull();
});

it('A2 bot-access retry after durable policy commit and lost queue acknowledgement applies once',async()=>{
 fake.scenario='deny';fake.presentApprovalSync.mockImplementation(()=>{});
 const target:any={id:'target',name:'Target',threadId:'target-thread',composio:true};let afterCommit=false,patches=0;
 const s:any={bot:(id:string)=>id==='target'?target:bot,patchBot:(_id:string,patch:any)=>{Object.assign(target,patch);if(afterCommit){patches++;if(patches===1)throw new Error('fixture lost acknowledgement after commit');}}};
 const accounts=[{toolkit:'gmail',accountId:'account'}];installBotAccessApprovalAccounts(s,()=>accounts);
 const queue=botAccessApprovalQueue(s);
 requestBotAccess(s,bot,{botId:'target',revision:0,grants:[{toolkit:'gmail',accountId:'account',tools:['GMAIL_FETCH_EMAILS']}],allowWrites:false},Date.now(),{authority,threadId:'thread',accounts});
 afterCommit=true;const item=queue.pendingApprovals().find(item=>(item.call.input as any).botId==='target')!;
 expect(await queue.respond(item,{behavior:'allow'},{answerId:'stable'})).toEqual({state:'failed'});
 expect(await queue.respond(item,{behavior:'allow'},{answerId:'stable'})).toEqual({state:'accepted'});
 expect(patches).toBe(1);expect(target.connectedAppAccess.revision).toBe(2);
});

for(const behavior of ['allow','cancel'] as const)it(`B4 queue-first crash before policy write recovers ${behavior}`,async()=>{
 fake.scenario='deny';fake.presentApprovalSync.mockImplementation(()=>{});
 const target:any={id:'target',name:'Target',threadId:'target-thread',composio:true};let crash=true;
 const s:any={bot:(id:string)=>id==='target'?target:bot,patchBot:(_id:string,patch:any)=>{if(crash)throw new Error('crash before policy write');Object.assign(target,patch);}};
 const accounts=[{toolkit:'gmail',accountId:'account'}];installBotAccessApprovalAccounts(s,()=>accounts);
 const queue=botAccessApprovalQueue(s);
 expect(()=>requestBotAccess(s,bot,{botId:'target',revision:0,grants:[{toolkit:'gmail',accountId:'account',tools:['GMAIL_FETCH_EMAILS']}],allowWrites:false},Date.now(),{authority,threadId:'thread',accounts})).toThrow('crash before policy write');
 crash=false;const item=queue.pendingApprovals().at(-1)!;
 const restartedStore={...s};installBotAccessApprovalAccounts(restartedStore,()=>accounts);const restarted=botAccessApprovalQueue(restartedStore);
 if(behavior==='allow'){
  expect(await restarted.respond(item,{behavior:'allow'},{answerId:'recover'})).toEqual({state:'accepted'});
  expect(target.connectedAppAccess.grants[0].tools).toEqual(['GMAIL_FETCH_EMAILS']);
 }else{
  await restarted.cancel(item,'cancelled');
  expect(target.connectedAppAccess.requests).toHaveLength(0);
 }
});

for(const action of ['decline','continue','accept-continue'] as const)it(`B3 settled browser setup ${action} resumes once after index removal`,async()=>{
 fake.scenario='deny';fake.presentApprovalSync.mockImplementation(()=>{});
 let row:any;const continueTask=vi.fn(async()=>{});
 const s:any={...store,newestMatching:()=>({id:'owner',text:'task',role:'user'}),keyedCards:()=>[],keyedCardsEverywhere:()=>row&&!row.card.answered?[{threadId:'thread',message:row}]:[],messageById:()=>row};
 const setup=new BrowserExtensionSetup({store:s,authorityFor:()=>authority,owner:()=>bot,startHelper:async()=>{},status:()=>({profiles:[{profileId:'profile',browser:'chrome'}],bindings:[]}),optIn:()=>{},continueTask});
 setup.request('bot','thread');const item=setup.pendingApprovals().at(-1)!;
 const record=fake.records.get(item.approvalId);row={id:record.chatMessageId,card:{...item.call.approval.action}};
 fake.lookupApproval.mockReturnValue(record);
 fake.answerApproval.mockImplementation(async()=>{expect(await setup.approvalQueue().respond(item,{behavior:action==='decline'?'deny':'allow'},{answerId:'setup-answer'})).toEqual({state:'accepted'});record.state='answered';row.card.answered='allow';});
 if(action==='continue')setup.approvalQueue().updateProgress(item.ref,{decision:'accepted',profileId:'profile'});
 if(action==='accept-continue')await setup.answer('thread',row.id,'accept','profile');
 await setup.answer('thread',row.id,action==='accept-continue'?'continue':action,'profile');await setup.drain();
 expect(continueTask).toHaveBeenCalledTimes(1);await setup.drain();expect(continueTask).toHaveBeenCalledTimes(1);
});

// TODO(s2p-r5): real T1 needs the verifier-issued claim, bound reopen adapter, and same-queue sync delivery.
for (const label of ['Allowed', 'allow', 'settled-by-fixture']) it(`B6 M22 routine settlement stamps terminal metadata without comparing its label: ${label}`,async()=>{
 fake.scenario='deny';fake.presentApproval.mockResolvedValue(undefined);
 let row:any;
 const routines=new RoutineManager({file:join(DATA_DIR,`${randomUUID()}.json`),botState:()=> 'busy',createTask:()=>null,startTurn:async()=>{}});
 const s:any={...store,cardForRequest:()=>row,messagesFor:()=>[],messageById:()=>row,patchMessage:(_t:any,_id:any,patch:any)=>{Object.assign(row,patch);return row;}};
 const p=new RoutineRequestService({store:s,routines});
 const created=await p.propose({authority,botId:'bot',threadId:'thread',proposal:{action:'create',routine:{name:'undoable',instructions:'fixture',schedule:{type:'weekly',time:'09:00',weekdays:['monday']}}}});
 const item=p.pendingApprovals().at(-1)!,record=fake.records.get(item.approvalId);
 row={id:created.messageId,card:{...item.call.approval.action}};fake.lookupApproval.mockReturnValue(record);
 fake.answerApprovalSync.mockImplementation(()=>{record.state='answered';row.card.answered=label;return p.approvalQueue().respondNow(item,{behavior:'allow'},{answerId:'routine'});});
 expect(p.resolve({botId:'bot',threadId:'thread',requestId:created.requestId,behavior:'allow'})).toMatchObject({state:'applied'});
 expect(row.card.answeredAt).toBe(routines.routineRequestReceipt(created.requestId)!.appliedAt);
 expect(row.card.answeredAt).toEqual(expect.any(Number));
 expect(row.card.routineRequest).not.toHaveProperty('appliedAt');
 expect(row.card.routineRequest).not.toHaveProperty('resultId');
 if(label==='settled-by-fixture')return;
 expect(p.resolve({botId:'bot',threadId:'thread',requestId:created.requestId,behavior:'undo'})).toMatchObject({state:'undone'});
 expect(routines.routineRequestReceipt(created.requestId)).toBeNull();
});

for(const resumed of [false,true])it(`B7 late image Allow requires continuation; resumed=${resumed}`,async()=>{
 fake.scenario='deny';fake.presentApproval.mockResolvedValue(undefined);
 const controller=new AbortController(),closed=vi.fn(()=>resumed);
 const p=new ImageOperations({store,waiting:()=>{},routineCard:{opened:()=>true,closed}} as any);
 const details={connectionId:'fake',provider:'openai',model:'fake',operation:'generate',count:1,referenceCount:0};
 const request={prompt:`late fixture ${resumed}`};
 const pending=(p as any).approve({...actor,signal:controller.signal},details,request);
 await vi.waitFor(()=>expect(p.pendingApprovals().some(i=>i.call.input&& (i.call.input as any).prompt===request.prompt)).toBe(true));
 const item=p.pendingApprovals().find(i=>(i.call.input as any).prompt===request.prompt)!;
 controller.abort();expect(await pending).toBe('gone');
 const delivery=await p.approvalQueue().respond(item,{behavior:'allow'},{answerId:'late'});
 expect(delivery.state).toBe(resumed?'accepted':'failed');
 expect(closed).toHaveBeenCalledTimes(1);
 if(resumed){
  fake.scenario='guest';const again=(p as any).approve(actor,details,request);
  await expect(Promise.race([again,new Promise(resolve=>setTimeout(()=>resolve('stranded'),100))])).resolves.toBe('allow');
  fake.presentApproval.mockImplementation(async ref=>deliver(ref));
  await expect((p as any).approve(actor,details,request)).resolves.toBe('deny');await Promise.all(deliveries);
 }
});

for(const [outside,text] of [
 ['web page',"ssh fixture 'pwd'; cd some/dir && ls"],
 ['earlier turn','Write report.txt with earlier-turn content'],
 ['cloned folder','cat <<EOF > report.txt\noutside content\nEOF'],
] as const)it(`B8 Sable scoped routine create/manage/run and MCP execute after ${outside} with ZERO owner cards`,async()=>{
 fake.scenario='run';beginOutsideTurn('thread','instance','turn',false);markTurnOutside('thread',outside as any);
 const startTurn=vi.fn(async(..._args:any[])=>{});
 const routines=new RoutineManager({file:join(DATA_DIR,`${randomUUID()}.json`),botState:()=> 'ready',createTask:()=>({threadId:'routine-task'}),startTurn});
 const service=new RoutineRequestService({store:{...store,messagesFor:()=>[],patchMessage:()=>null},routines});
 const propose=async(proposal:any)=>{
  const tool=proposal.action==='create'?'propose_routine':'propose_routine_action';
  expect(ownToolGate({authority,...ownPolicy,threadId:'thread',botId:'bot',tool,lane:true})).toBeNull();
  const result=await service.propose({authority,botId:'bot',threadId:'thread',proposal});expect(result.applied).toBe(true);return result;
 };
 const created=await propose({action:'create',routine:{name:'Sable',instructions:text,schedule:{type:'weekly',time:'09:00',weekdays:['monday']}}});
 await propose({action:'update',routineId:created.resultId,changes:{instructions:text+' after read'}});
 await propose({action:'run_now',routineId:created.resultId});
 await vi.waitFor(()=>expect(startTurn).toHaveBeenCalledTimes(1));
 expect(startTurn.mock.calls[0]?.[2]).toContain(text);
 const execute=vi.fn();expect(requestMcpEnable(authority,'outside',{command:'fixture',args:[text],env:{},enabled:false},'rev',bot,execute)).toMatchObject({kind:'executed'});expect(execute).toHaveBeenCalledTimes(1);
 expect(fake.presented).toHaveLength(0);expect(store.appendMessage).not.toHaveBeenCalled();routines.stop();
});
it('B6 non-undoable acknowledged receipts are removed by the explicit sweep; RUN leaves none',async()=>{
 fake.scenario='run';fake.presentApproval.mockResolvedValue(undefined);let row:any;
 const routines=new RoutineManager({file:join(DATA_DIR,`${randomUUID()}.json`),botState:()=> 'busy',createTask:()=>null,startTurn:async()=>{}});
 const s:any={...store,cardForRequest:()=>row,messagesFor:()=>[],patchMessage:(_t:any,_id:any,patch:any)=>{Object.assign(row,patch);return row;}};
 const p=new RoutineRequestService({store:s,routines});
 const created=await p.propose({authority,botId:'bot',threadId:'thread',proposal:{action:'create',routine:{name:'cleanup',instructions:'fixture',schedule:{type:'weekly',time:'09:00',weekdays:['monday']}}}});
 expect(routines.routineRequestReceiptOwners()).toHaveLength(0);
 fake.scenario='deny';const requested=await p.propose({authority,botId:'bot',threadId:'thread',proposal:{action:'run_now',routineId:created.resultId!}});
 const item=p.pendingApprovals().at(-1)!,record=fake.records.get(item.approvalId);row={id:requested.messageId,card:{...item.call.approval.action}};fake.lookupApproval.mockReturnValue(record);
 fake.answerApprovalSync.mockImplementation(()=>{const result=p.approvalQueue().respondNow(item,{behavior:'allow'},{answerId:'run-now'});record.state='answered';row.card.answered='allow';return result;});
 expect(p.resolve({botId:'bot',threadId:'thread',requestId:requested.requestId,behavior:'allow'})).toMatchObject({state:'applied'});
 expect(routines.routineRequestReceiptOwners()).toHaveLength(1);
 p.sweepReceipts();
 expect(routines.routineRequestReceiptOwners()).toHaveLength(0);routines.stop();
});
