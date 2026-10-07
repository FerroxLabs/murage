import { queueDelegation, findDelegationReceipt, _resetPending, _pendingCount } from "./delegations.ts";
import { dispatchProjectUsageTurn, type ProjectUsageRun } from "./project-usage-dispatch.ts";
import { createWorkAdmission, type WorkAdmission } from "./work-admission.ts";
import { createRoomDispatcher } from "./room-dispatcher.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR, saveConfig } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { getOrCreateChannel, mirrorExchange } from "./comms-visibility.ts";
import { enqueueSharedWork, isSharedWorkRow, sharedDispatchOrder, sharedCapacity, changeSharing, clearSharedFinishing, sharedRowAudience, configureSharedDrain, drainSharedWork, sharedRequestRoutineAuthority } from "./shared-work.ts";
import { authorizeWork } from "./execution-audience.ts";
import { roomRequest, insertRoomRequest, completeRequest, type RoomRequest } from "./room-requests.ts";
import { settleSharedWorkOwnerTurn, settleProjectUsage } from "./usage-ledger.ts";
import { createSharedOwnerUsage, type SharedOwnerEvent } from "./shared-owner-usage.ts";
import { requestPeerApproval, resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
 const store = new Store(() => ({instanceId:"fixture",model:"fixture"}));
 const iris = store.createBot(); store.patchBot(iris.id,{name:"Iris",section:"Design",sharedWith:{mode:"all",teams:[]}});
 const teams = ["Sales","Support","Ops"].map(name => {const bot=store.createBot();store.patchBot(bot.id,{name,section:name,chiefOfStaff:true});return {bot,id:teamIdFor(name)};});
 const enqueue=(i=0,key="request",now=1) => enqueueSharedWork(store,{fromBotId:teams[i].bot.id,sourceThreadId:teams[i].bot.threadId,toBotId:iris.id,message:"CANARY_"+i,admissionKey:key,ownerAudience:true,now});
 return {store,iris,teams,enqueue};
}
it("pair rooms are keyed by audience, never refiled and preserve legacy home",()=>{
 const f=fixture(),from=f.teams[0].bot;
 const home=getOrCreateChannel(f.store,from,f.iris,from.threadId,null);
 const tag={v:1 as const,kind:"team" as const,team:f.teams[0].id,human:"owner" as const,rootRequestId:"r"};
 const pair=getOrCreateChannel(f.store,from,f.iris,from.threadId,tag);
 expect(pair.id).not.toBe(home.id);expect(pair.dmAudience).toEqual({kind:"team",teamId:f.teams[0].id});
 f.store.patchBot(from.id,{section:"Other"});expect(getOrCreateChannel(f.store,from,f.iris,from.threadId,tag).section).toBe("Sales");expect(home.dmAudience).toBeUndefined();
});
it("dedupes before the atomic twenty-row cap and preserves policy revision",()=>{
 const f=fixture(); const first=f.enqueue();if(!first.ok)throw Error(first.code);
 const revision=database().prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision;
 for(let i=1;i<20;i++)expect(f.enqueue(0,"req"+i).ok).toBe(true);
 expect(f.enqueue().ok).toBe(true);expect(f.enqueue(0,"overflow")).toMatchObject({ok:false,code:"shared_queue_cap"});
 expect(isSharedWorkRow(first.request)).toBe(true);expect(first.request.deadlineAt).toBe(86400001);expect(first.request.returnThreadId).toBeNull();
 expect(database().prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision).toBe(revision);
});
it("oldest dispatched team first, two shared slots and owner wait retains its slot",()=>{
 const f=fixture();for(let i=0;i<3;i++)f.enqueue(i,"r"+i,i+1);
 database().prepare("UPDATE room_requests SET state='waiting_owner',dispatched_at=10 WHERE admission_key='r0'").run();
 expect(sharedDispatchOrder(f.iris.id).map(r=>r.admissionKey)).toEqual(["r1","r2"]);
 expect(sharedCapacity(f.iris.id,f.teams[0].id)).toBe("shared_team_cap");
 database().prepare("UPDATE room_requests SET state='running',dispatched_at=11 WHERE admission_key='r1'").run();
 expect(sharedCapacity(f.iris.id,f.teams[2].id)).toBe("shared_total_cap");
});
it("revoke finishes only the selected row, cancels queued, re-share reopens",()=>{
 const f=fixture(),run=f.enqueue(),queued=f.enqueue(0,"queued");if(!run.ok||!queued.ok)throw Error("fixture");
 database().prepare("UPDATE room_requests SET state='running',dispatched_at=2 WHERE id=?").run(run.request.id);
 changeSharing(f.store,f.iris.id,{mode:"none",teams:[]},"finish",{now:10});
 const work=f.iris.tasks!.find(t=>t.sharedWork)!;
 expect(work.sharedWork).toMatchObject({closedAt:10,closedReason:"revoked",finishing:{requestId:run.request.id}});
 expect(roomRequest(database(),queued.request.id)?.state).toBe("cancelled");
 expect(authorizeWork({edge:"dispatch",requestId:run.request.id,targetBotId:f.iris.id,targetThreadId:work.threadId,tag:sharedRowAudience(run.request),kind:"shared"})).toMatchObject({ok:true,clause:"finishing"});
 clearSharedFinishing(f.store,f.iris.id,{requestId:run.request.id});expect(work.sharedWork!.finishing).toBeUndefined();
 changeSharing(f.store,f.iris.id,{mode:"all",teams:[]},"finish",{now:11});expect(work.sharedWork!.closedAt).toBeUndefined();
});
it("flag off refuses a new shared start retryably",()=>{
 const f=fixture();saveConfig({features:{botsSharedAcrossTeams:false}});expect(f.enqueue()).toMatchObject({ok:false,code:"shared_paused",retry:"queue"});
});
it("owner and bound request settlement are mutually exclusive and idempotent",()=>{
 const f=fixture(),entry=f.enqueue();if(!entry.ok)throw Error(entry.code);
 const terminal={threadId:entry.request.targetThreadId!,botId:f.iris.id,engine:"fixture",turnGeneration:"generation",at:10,ok:true,usage:{input:1,output:2}};
 expect(settleSharedWorkOwnerTurn(database(),{...terminal,teamId:f.teams[0].id,ownerMessageId:"owner",startedAt:1,boundRequestId:entry.request.id})).toBe(false);
 expect(settleProjectUsage(database(),{...entry.request,dispatchedAt:1},terminal)).toBe(true);
 const owner={...terminal,turnGeneration:"owner-generation",teamId:f.teams[0].id,ownerMessageId:"owner",startedAt:1};
 expect(settleSharedWorkOwnerTurn(database(),owner)).toBe(true);expect(settleSharedWorkOwnerTurn(database(),owner)).toBe(false);
 expect(database().prepare("SELECT count(*) AS n FROM usage_ledger").get()!.n).toBe(2);
});

it("only the shared drain starts shared requests, holds flag-off and resumes on release",()=>{
 const f=fixture(), first=f.enqueue();if(!first.ok)throw Error(first.code);
 const started:string[]=[];
 const admission=createWorkAdmission({restoreReview:()=>false,flags:()=>({autonomy:true,budgets:false}),threadRunning:()=>false,speakingInRoom:()=>false,directThreads:()=>0,maxThreads:3,installCardCap:3,rootCounters:()=>({wakes:0,workMs:0}),askWouldDeadlock:()=>false,reachable:()=>true,dependencyOpen:()=>false,claimWriterRoot:()=>()=>{},now:()=>10});
 const shared={admission,open:()=>true,now:()=>10,changed:()=>{},closed:()=>{},start:(row:RoomRequest)=>{started.push(row.id);}};
 configureSharedDrain(shared);
 const rooms=createRoomDispatcher({db:database,admission,now:()=>10,open:()=>true,roomUsable:()=>{throw Error("shared rows must be skipped first");},roomBusy:()=>false,projectContext:()=>undefined,memberIds:()=>[],audienceStillValid:()=>true,ownerOrigin:()=>true,startOwnerSend:()=>{},startMemberTurn:()=>{throw Error("wrong executor");},onClosed:()=>{},onStillWaiting:()=>{},changed:()=>{}});
 database().prepare("UPDATE room_requests SET verb='wake' WHERE id=?").run(first.request.id);
 rooms.pump();expect(roomRequest(database(),first.request.id)?.state).toBe("queued");
 database().prepare("UPDATE room_requests SET verb='ask' WHERE id=?").run(first.request.id);
 saveConfig({features:{botsSharedAcrossTeams:false}});drainSharedWork(f.iris.id);expect(started).toEqual([]);expect(roomRequest(database(),first.request.id)?.refusal).toBe("shared_paused");
 saveConfig({features:{botsSharedAcrossTeams:true}});drainSharedWork(f.iris.id);expect(started).toEqual([first.request.id]);
});
it("a continuation wake retains the team's occupied slot and completes once",()=>{
 const f=fixture(),first=f.enqueue();if(!first.ok)throw Error(first.code);const db=database();
 db.prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=2 WHERE id=?").run(first.request.id);
 const wake=insertRoomRequest(db,{parentId:first.request.id,groupId:first.request.groupId,targetThreadId:first.request.targetThreadId!,toBotId:f.iris.id,fromKind:"murage",verb:"wake",admissionKey:`wake:${first.request.id}`,now:3}).request;
 const started:string[]=[];const admission=createWorkAdmission({restoreReview:()=>false,flags:()=>({autonomy:true,budgets:true}),threadRunning:()=>false,speakingInRoom:()=>false,directThreads:()=>0,maxThreads:3,installCardCap:3,rootCounters:()=>({wakes:0,workMs:0}),askWouldDeadlock:()=>false,reachable:()=>true,dependencyOpen:()=>false,claimWriterRoot:()=>()=>{},now:()=>4});
 admission.setBudgetGate({check:()=>({ok:true})});
 configureSharedDrain({admission,open:()=>true,now:()=>4,changed:()=>{},closed:()=>{},start:row=>{started.push(row.id);}});drainSharedWork(f.iris.id);expect(roomRequest(db,wake.id)).toMatchObject({state:"running",refusal:null});expect(started).toEqual([wake.id]);
 expect(completeRequest(db,wake.id,{state:"done",now:5}).changed).toBe(true);expect(completeRequest(db,wake.id,{state:"done",now:6}).changed).toBe(false);expect(roomRequest(db,first.request.id)?.state).toBe("done");
});
it("shared expiry returns the line to the requester without starting",()=>{
 const f=fixture(),first=f.enqueue();if(!first.ok)throw Error(first.code);const lines:string[]=[];
 configureSharedDrain({admission:{} as WorkAdmission,open:()=>true,now:()=>86400002,changed:()=>{},closed:(_r,line)=>lines.push(line),start:()=>{throw Error("expired");}});drainSharedWork(f.iris.id);
 expect(roomRequest(database(),first.request.id)?.state).toBe("expired");expect(lines).toEqual(["Iris could not get to this in a day. Ask again."]);
});
it("stop revocation interrupts the selected generation and cancels descendants",()=>{
 const f=fixture(),first=f.enqueue();if(!first.ok)throw Error(first.code);const db=database();db.prepare("UPDATE room_requests SET state='running',dispatched_at=2 WHERE id=?").run(first.request.id);
 const child=insertRoomRequest(db,{parentId:first.request.id,groupId:first.request.groupId,verb:"ask",fromKind:"bot",fromBotId:f.iris.id,toBotId:f.teams[0].bot.id,admissionKey:"child",now:3}).request;
 const stopped:string[]=[];changeSharing(f.store,f.iris.id,{mode:"none",teams:[]},"stop",{now:4,generationFor:()=>"generation",interrupt:(_thread,generation)=>stopped.push(generation!)});
 expect(stopped).toEqual(["generation"]);expect(roomRequest(db,first.request.id)?.state).toBe("cancelled");expect(roomRequest(db,child.id)?.state).toBe("cancelled");
});

it("lazy pair-room and work-task creation together leave policy_revision unchanged",()=>{
 const f=fixture(),before=database().prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision;
 expect(f.enqueue().ok).toBe(true);
 expect(database().prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision).toBe(before);
});

it("a shared row uses held asks and failure settlement without a project group",async()=>{
 const f=fixture(),queued=f.enqueue();if(!queued.ok)throw Error(queued.code);
 database().prepare("UPDATE room_requests SET state='running',dispatched_at=2 WHERE id=?").run(queued.request.id);
 const request=roomRequest(database(),queued.request.id)!;
 const run:ProjectUsageRun={request,generation:"shared-generation",botId:f.iris.id,engine:"fixture"};let failures=0;
 await expect(dispatchProjectUsageTurn({threadId:request.targetThreadId!,text:"work"},run,{bindings:new Map(),pending:new Map(),turns:new Map(),project:false,interrupt:()=>{},send:async input=>{expect(input).toMatchObject({holdPermissionAsks:true,holdProjectAsks:true});throw Error("before acceptance");},failure:failed=>{failures++;settleProjectUsage(database(),failed.request,{threadId:request.targetThreadId!,botId:f.iris.id,engine:"fixture",turnGeneration:run.generation,at:10,ok:false});}})).rejects.toThrow("before acceptance");
 expect(failures).toBe(1);expect(run.settled).toBe(true);expect(database().prepare("SELECT count(*) AS n FROM usage_ledger WHERE request_id=?").get(request.id)?.n).toBe(1);
});

it("concurrent admissions keep the cap, and dispatch order survives a fresh store",async()=>{
 const f=fixture();const accepted=await Promise.all(Array.from({length:24},(_,i)=>Promise.resolve().then(()=>f.enqueue(0,"parallel"+i,i+1))));
 expect(accepted.filter(r=>r.ok)).toHaveLength(20);expect(accepted.filter(r=>!r.ok)).toHaveLength(4);
 const before=sharedDispatchOrder(f.iris.id).map(r=>r.id);closeDatabase();new Store(()=>({instanceId:"fixture",model:"fixture"}));expect(sharedDispatchOrder(f.iris.id).map(r=>r.id)).toEqual(before);
});

it("a team-tagged home member mirrors only into the audience work task",()=>{
 const f=fixture(),bob=f.store.createBot();f.store.patchBot(bob.id,{name:"Bob",section:"Sales"});
 const tag={v:1 as const,kind:"team" as const,human:"owner" as const,team:f.teams[0].id,rootRequestId:"chain"};
 const pair=getOrCreateChannel(f.store,bob,f.iris,bob.threadId,tag);
 mirrorExchange({store:f.store,broadcast:()=>{}},bob,f.iris,"CANARY_SALES_ASK",pair,bob.threadId,tag);
 const work=f.iris.tasks!.find(t=>t.sharedWork?.teamId===f.teams[0].id)!;
 expect(work).toBeDefined();expect(f.store.messagesFor(work.threadId).some(m=>m.tool?.name==="Message from @Bob")).toBe(true);
 expect(f.store.messagesFor(f.iris.threadId).some(m=>m.tool?.name==="Message from @Bob")).toBe(false);
});

it("row admission happens before delegation JSON, so a cap refusal leaves no handoff",()=>{
 const f=fixture(),from=f.teams[0].bot;_resetPending();
 const bus={store:f.store,broadcast:()=>{},prepareDelegation:()=>{throw Error("shared_queue_cap");}};
 expect(()=>queueDelegation(bus,from,{toBotId:f.iris.id,message:"overflow",depth:0},4,from.threadId)).toThrow("shared_queue_cap");
 expect(_pendingCount(from.threadId)).toBe(0);_resetPending();
});

it("a root from a work thread names the newly inserted request, not the source thread",()=>{
 const f=fixture(),first=f.enqueue();if(!first.ok)throw Error(first.code);
 const peer=f.store.createBot();f.store.patchBot(peer.id,{section:"Other",sharedWith:{mode:"all",teams:[]}});
 const next=enqueueSharedWork(f.store,{fromBotId:f.iris.id,sourceThreadId:first.request.targetThreadId!,toBotId:peer.id,message:"root",admissionKey:"work-root",ownerAudience:true,now:3});
 if(!next.ok)throw Error(next.code);expect(sharedRowAudience(next.request)?.rootRequestId).toBe(next.request.id);
});


it("R3c C3: let it finish preserves the queued continuation of the finishing parent",()=>{
 const f=fixture(),first=f.enqueue();if(!first.ok)throw Error(first.code);const db=database();
 db.prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=2 WHERE id=?").run(first.request.id);
 const wake=insertRoomRequest(db,{parentId:first.request.id,groupId:first.request.groupId,targetThreadId:first.request.targetThreadId!,toBotId:f.iris.id,fromKind:"murage",verb:"wake",admissionKey:`wake:${first.request.id}`,now:3}).request;
 changeSharing(f.store,f.iris.id,{mode:"none",teams:[]},"finish",{now:4});
 expect(roomRequest(db,wake.id)?.state).toBe("queued");
 expect(authorizeWork({edge:"dispatch",requestId:wake.id,targetBotId:f.iris.id,targetThreadId:wake.targetThreadId!,tag:sharedRowAudience(wake),kind:"wake"})).toMatchObject({ok:true});
});
it("R3c A6: a parent and its running continuation occupy one shared slot",()=>{
 const f=fixture(),first=f.enqueue();if(!first.ok)throw Error(first.code);const db=database();
 db.prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=2 WHERE id=?").run(first.request.id);
 insertRoomRequest(db,{parentId:first.request.id,groupId:first.request.groupId,targetThreadId:first.request.targetThreadId!,toBotId:f.iris.id,fromKind:"murage",verb:"wake",admissionKey:`wake:${first.request.id}`,state:"running",now:3});
 expect(sharedCapacity(f.iris.id,f.teams[1].id)).toBeNull();
 expect(sharedCapacity(f.iris.id,f.teams[0].id)).toBe("shared_team_cap");
 const second=f.enqueue(1,"second");if(!second.ok)throw Error(second.code);
 db.prepare("UPDATE room_requests SET state='running' WHERE id=?").run(second.request.id);
 expect(sharedCapacity(f.iris.id,f.teams[2].id)).toBe("shared_total_cap");
});


it.each(["expired","unreachable","admission"])("R3c C6: shared drain records a terminal delegation receipt (%s)",reason=>{
 const f=fixture(),queued=f.enqueue(0,"ask:delegation:receipt-"+reason);if(!queued.ok)throw Error(queued.code);
 if(reason==="unreachable") f.store.patchBot(f.iris.id,{hidden:true});
 const admission={admit:()=>({admit:false,reason:"fixture-refusal",retry:"never",line:"Refused by admission"})} as unknown as WorkAdmission;
 configureSharedDrain({admission,open:()=>true,now:()=>reason==="expired"?86400002:10,changed:()=>{},closed:()=>{},start:()=>{throw Error("must not start");}});
 drainSharedWork(f.iris.id);
 expect(roomRequest(database(),queued.request.id)?.state).toBe(reason==="expired"?"expired":"cancelled");
 expect(findDelegationReceipt("receipt-"+reason)).toMatchObject({id:"receipt-"+reason,sourceThreadId:f.teams[0].bot.threadId,toBotId:f.iris.id,status:reason==="expired"?"expired":"failed"});
});
it("R3c A1: a request stopped while it waited on an approval never starts after re-sharing",()=>{
 const f=fixture(),run=f.enqueue();if(!run.ok)throw Error("fixture");
 database().prepare("UPDATE room_requests SET state='waiting_owner',dispatched_at=2 WHERE id=?").run(run.request.id);
 changeSharing(f.store,f.iris.id,{mode:"none",teams:[]},"stop",{now:10});
 expect(roomRequest(database(),run.request.id)?.state).toBe("cancelled");
 changeSharing(f.store,f.iris.id,{mode:"all",teams:[]},"finish",{now:11});
 const work=f.iris.tasks!.find(t=>t.sharedWork)!;expect(work.sharedWork!.closedAt).toBeUndefined();
 expect(authorizeWork({edge:"dispatch",requestId:run.request.id,targetBotId:f.iris.id,targetThreadId:work.threadId,tag:sharedRowAudience(run.request),kind:"shared"})).toMatchObject({ok:false});
});
it("R3c A3: a stale or duplicate completion never settles or ends the newer owner turn",()=>{
 const f=fixture(),work=f.store.createSharedWorkTask(f.iris.id,f.teams[0].id)!,threadId=work.threadId;
 const settled:string[]=[];
 const owner=createSharedOwnerUsage<SharedOwnerEvent>((thread,run,outcome)=>{settled.push(`${run.generation}:${outcome.turnId??"-"}`);
  settleSharedWorkOwnerTurn(database(),{threadId:thread,botId:run.botId,teamId:run.teamId,ownerMessageId:run.messageId,turnGeneration:run.generation,providerTurnId:outcome.turnId,engine:run.engine,startedAt:run.startedAt,at:run.startedAt+5,ok:outcome.ok,usage:outcome.usage as never});});
 const run=(generation:string)=>({generation,botId:f.iris.id,teamId:f.teams[0].id,messageId:"m-"+generation,engine:"fixture",startedAt:1,ownerWaitMs:0,asks:new Set<string>()});
 const done=(turnId:string,input:number)=>({type:"turn.completed",threadId,turnId,ok:true,usage:{input,output:1}});
 owner.begin(threadId,run("A"));owner.accepted(threadId,"A","tA");owner.end(threadId,"A");
 owner.begin(threadId,run("B"));
 owner.observe(done("tA",100),"B");owner.observe(done("tA",100),"B");
 expect(settled).toEqual(["A:-"]);expect(owner.has(threadId)).toBe(true);
 owner.accepted(threadId,"B","tB");owner.observe(done("tA",100),"B");expect(owner.has(threadId)).toBe(true);
 owner.observe(done("tB",7),"B");
 expect(settled).toEqual(["A:-","B:tB"]);
 const rows=database().prepare("SELECT settle_key,turn_id,input,ok FROM usage_ledger WHERE settle_key LIKE 'shared-owner:%' ORDER BY settle_key").all().map(row=>({...row}));
 expect(rows).toEqual([{settle_key:"shared-owner:A",turn_id:null,input:null,ok:0},{settle_key:"shared-owner:B",turn_id:"tB",input:7,ok:1}]);
});

it("R4d: a completion without a provider turn id never settles the newer generation once its turn is named",()=>{
 const f=fixture(),threadId=f.store.createSharedWorkTask(f.iris.id,f.teams[0].id)!.threadId,settled:string[]=[];
 const owner=createSharedOwnerUsage<SharedOwnerEvent>((_thread,run,outcome)=>{settled.push(`${run.generation}:${outcome.turnId??"-"}`);});
 const run=(generation:string)=>({generation,botId:f.iris.id,teamId:f.teams[0].id,messageId:"m-"+generation,engine:"fixture",startedAt:1,ownerWaitMs:0,asks:new Set<string>()});
 owner.begin(threadId,run("A"));owner.accepted(threadId,"A","tA");owner.end(threadId,"A");
 owner.begin(threadId,run("B"));owner.accepted(threadId,"B","tB");
 owner.observe({type:"turn.completed",threadId,ok:true,usage:{input:100,output:1}},"B");
 expect(settled).toEqual(["A:-"]);expect(owner.has(threadId)).toBe(true);
 owner.observe({type:"turn.completed",threadId,turnId:"tB",ok:true,usage:{input:7,output:1}},"B");
 expect(settled).toEqual(["A:-","B:tB"]);
 // an engine that never names its turns still settles on its own id-less completion
 owner.begin(threadId,run("C"));owner.observe({type:"turn.completed",threadId,ok:true},"C");
 expect(settled).toEqual(["A:-","B:tB","C:-"]);
});

it("R4 C (Astra r3 #1): Stop it now cancels the stopped request's approval card, so it can no longer be answered",async()=>{
 const f=fixture(),run=f.enqueue();if(!run.ok)throw Error("fixture");
 database().prepare("UPDATE room_requests SET state='waiting_owner',dispatched_at=2 WHERE id=?").run(run.request.id);
 const bus:ApprovalBus={store:f.store,broadcast:()=>{}};
 const sam=f.teams[0].bot,verdict=requestPeerApproval(bus,sam,f.iris,"CANARY_0","delegate_bot",sam.threadId,run.request.id);
 const card=()=>f.store.messagesFor(sam.threadId).find(m=>m.card?.tool==="delegate_bot")!.card!;
 expect(card().answered).toBeUndefined();
 const closed:string[]=[];
 changeSharing(f.store,f.iris.id,{mode:"none",teams:[]},"stop",{now:10,closeApprovals:thread=>closed.push(thread)});
 await expect(verdict).resolves.toBe("cancelled");
 expect(card()).toMatchObject({answered:"deny",dismissed:true});
 // the owner's late answer finds nothing to decide
 expect(resolvePeerComms(bus,card().requestId!,"allow")).toBe(false);
 expect(closed).toEqual([f.iris.tasks!.find(t=>t.sharedWork)!.threadId]);
 expect(roomRequest(database(),run.request.id)?.state).toBe("cancelled");
});
it("R4 C: Let it finish leaves the finishing request's card open, and another request's card is never touched",async()=>{
 const f=fixture(),run=f.enqueue(),other=f.enqueue(1,"other");if(!run.ok||!other.ok)throw Error("fixture");
 database().prepare("UPDATE room_requests SET state='waiting_owner',dispatched_at=2 WHERE id IN (?,?)").run(run.request.id,other.request.id);
 const bus:ApprovalBus={store:f.store,broadcast:()=>{}};
 const sam=f.teams[0].bot,support=f.teams[1].bot;
 requestPeerApproval(bus,sam,f.iris,"CANARY_0","delegate_bot",sam.threadId,run.request.id);
 requestPeerApproval(bus,support,f.iris,"CANARY_1","delegate_bot",support.threadId,other.request.id);
 changeSharing(f.store,f.iris.id,{mode:"list",teams:[{id:f.teams[1].id,name:"Support"}]},"finish",{now:10});
 for(const bot of [sam,support])expect(f.store.messagesFor(bot.threadId).find(m=>m.card?.tool==="delegate_bot")!.card!.answered).toBeUndefined();
});

// S3b: a shared teammate keeps the ceiling of the routine whose bot asked.
it("records the routine ceiling a shared request was asked under",()=>{
 const f=fixture(),from=f.teams[0].bot;
 const queued=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"pay the invoice",admissionKey:"routine-ask",ownerAudience:true,now:1,routineAuthority:{permissionMode:"ask",triggerSource:"schedule"}});
 expect(queued.ok).toBe(true);
 if(!queued.ok)return;
 expect(sharedRequestRoutineAuthority(queued.request.id)).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 const plain=f.enqueue(1,"plain-ask");
 if(plain.ok)expect(sharedRequestRoutineAuthority(plain.request.id)).toBeUndefined();
});

// S3b gate: the ceiling survives a restart. Before, it lived only in memory,
// so a request still queued when Murage restarted ran at the teammate's own level.
it("a queued shared request keeps its routine ceiling across a restart, and a damaged record falls to Ask",async()=>{
 const f=fixture(),from=f.teams[0].bot;
 const queued=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"send the report",admissionKey:"routine-restart",ownerAudience:true,now:1,routineAuthority:{permissionMode:"auto",triggerSource:"manual"}});
 if(!queued.ok)throw Error(queued.code);
 const plain=f.enqueue(1,"plain-restart");if(!plain.ok)throw Error(plain.code);
 expect(roomRequest(database(),queued.request.id)?.state).toBe("queued");
 // a fresh process: new module graph, same data folder
 closeDatabase();vi.resetModules();
 const fresh=await import("./shared-work.ts");
 expect(fresh.sharedRequestRoutineAuthority(queued.request.id)).toEqual({permissionMode:"auto",triggerSource:"manual"});
 expect(fresh.sharedRequestRoutineAuthority(plain.request.id)).toBeUndefined();
 // a damaged record: every open request is capped at Ask, and the repair is written
 const file=join(DATA_DIR,"shared-routine-authority.json");
 writeFileSync(file,"{not json");
 (await import("./database.ts")).closeDatabase();vi.resetModules();
 const again=await import("./shared-work.ts");
 expect(again.sharedRequestRoutineAuthority(queued.request.id)).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 expect(again.sharedRequestRoutineAuthority(plain.request.id)).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 expect(JSON.parse(readFileSync(file,"utf8"))[queued.request.id]).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 // a finished request's ceiling is dropped
 (await import("./database.ts")).database().prepare("UPDATE room_requests SET state='done' WHERE id=?").run(queued.request.id);
 again.forgetSharedRequestRoutineAuthority(queued.request.id);
 expect(JSON.parse(readFileSync(file,"utf8"))[queued.request.id]).toBeUndefined();
 (await import("./database.ts")).closeDatabase();
});

// INT2 pass-2 finding 1: a wake resumes the shared teammate's work thread. It carries no ceiling of its own, so
// after a restart (empty in-memory maps) only the persisted parent chain can say a routine started it.
function wakeOf(parent: RoomRequest, now = 3) {
 return insertRoomRequest(database(),{parentId:parent.id,groupId:parent.groupId,targetThreadId:parent.targetThreadId!,toBotId:parent.toBotId!,fromKind:"murage",verb:"wake",admissionKey:`wake:${parent.id}`,now}).request;
}
it("a wake after a restart keeps the Ask ceiling of the routine that started its chain, and is a routine turn, not an owner turn",async()=>{
 const f=fixture(),from=f.teams[0].bot;
 f.store.patchBot(f.iris.id,{autoApprove:true,fullAccess:true});
 const asked=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"sweep",admissionKey:"routine-wake",ownerAudience:true,now:1,routineAuthority:{permissionMode:"ask",triggerSource:"schedule"}});
 if(!asked.ok)throw Error(asked.code);
 database().prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=2 WHERE id=?").run(asked.request.id);
 const wake=wakeOf(roomRequest(database(),asked.request.id)!);
 // a fresh process: new module graph, same data folder, nothing in memory
 closeDatabase();vi.resetModules();
 const fresh=await import("./shared-work.ts"),rr=await import("./room-requests.ts"),perms=await import("./routine-permissions.ts"),db=(await import("./database.ts")).database();
 const row=rr.roomRequest(db,wake.id)!;
 const ceiling=fresh.sharedWakeRoutineAuthority(row);
 expect(ceiling).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 // the teammate is Full access; the wake still runs at Ask, judged as a routine turn (never "owner")
 const authority=perms.peerTurnAuthority({autoApprove:true,fullAccess:true},ceiling!);
 expect(authority).toMatchObject({mode:"ask",origin:"routine"});
 expect(perms.botPermissionMode({autoApprove:true,fullAccess:true})).toBe("full");
});
it("a wake takes the LOWEST ceiling anywhere in its persisted ancestry, and a routine-asked ancestor with no record is Ask",async()=>{
 const f=fixture(),from=f.teams[0].bot;
 const top=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"top",admissionKey:"anc-top",ownerAudience:true,now:1,routineAuthority:{permissionMode:"auto",triggerSource:"manual"}});
 if(!top.ok)throw Error(top.code);
 const mid=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"mid",admissionKey:"anc-mid",ownerAudience:true,now:2,parentRequestId:top.request.id,routineAuthority:{permissionMode:"ask",triggerSource:"schedule"}});
 if(!mid.ok)throw Error(mid.code);
 database().prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=3 WHERE id IN (?,?)").run(top.request.id,mid.request.id);
 const wake=wakeOf(roomRequest(database(),mid.request.id)!);
 closeDatabase();vi.resetModules();
 const fresh=await import("./shared-work.ts"),rr=await import("./room-requests.ts"),db=(await import("./database.ts")).database();
 expect(fresh.sharedWakeRoutineAuthority(rr.roomRequest(db,wake.id)!)).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 // a lost record: the ancestor was asked from a routine run thread but its ceiling is gone -> Ask
 const file=join(DATA_DIR,"shared-routine-authority.json");writeFileSync(file,"{}");
 closeDatabase();vi.resetModules();
 const lost=await import("./shared-work.ts"),rr2=await import("./room-requests.ts"),db2=(await import("./database.ts")).database();
 // the recorded provenance survives the lost file (and a failed run): Ask with no live predicate at all
 expect(lost.sharedWakeRoutineAuthority(rr2.roomRequest(db2,wake.id)!)).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 expect(lost.sharedWakeRoutineAuthority(rr2.roomRequest(db2,wake.id)!,{routineSourceThread:()=>true})).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 // the in-memory ceiling can only lower it, never lift the recorded Ask
 expect(lost.sharedWakeRoutineAuthority(rr2.roomRequest(db2,wake.id)!,{live:{permissionMode:"auto",triggerSource:"manual"}})).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 expect(lost.sharedWakeRoutineAuthority(rr2.roomRequest(db2,wake.id)!,{routineSourceThread:()=>true,live:{permissionMode:"full",triggerSource:"manual"}})).toEqual({permissionMode:"ask",triggerSource:"schedule"});
});
it("control: a wake with no routine anywhere in its ancestry is judged exactly as before",async()=>{
 const f=fixture(),plain=f.enqueue(0,"plain-wake");if(!plain.ok)throw Error(plain.code);
 database().prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=2 WHERE id=?").run(plain.request.id);
 const wake=wakeOf(roomRequest(database(),plain.request.id)!);
 closeDatabase();vi.resetModules();
 const fresh=await import("./shared-work.ts"),rr=await import("./room-requests.ts"),db=(await import("./database.ts")).database();
 expect(fresh.sharedWakeRoutineAuthority(rr.roomRequest(db,wake.id)!,{routineSourceThread:()=>false})).toBeUndefined();
});

// INT2 pass-3 finding 1: provenance is persisted with the request, independent of run status and of the file.
async function restartAndWake(wakeId:string,opts:Parameters<typeof import("./shared-work.ts").sharedWakeRoutineAuthority>[1]={},store?:Store){
 closeDatabase();vi.resetModules();
 // the restarted process has its bot store (which says which rows are shared work) before any wake is judged
 if(store)(await import("./execution-audience.ts")).setExecutionStore(store);
 const fresh=await import("./shared-work.ts"),rr=await import("./room-requests.ts"),db=(await import("./database.ts")).database();
 return fresh.sharedWakeRoutineAuthority(rr.roomRequest(db,wakeId)!,opts);
}
it("restart: routine run is failed (predicate false) AND the authority entry is missing -> wake at Ask, origin routine",async()=>{
 const f=fixture(),from=f.teams[0].bot;
 f.store.patchBot(f.iris.id,{autoApprove:true,fullAccess:true});
 const asked=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"sweep",admissionKey:"prov-failed",ownerAudience:true,now:1,routineAuthority:{permissionMode:"ask",triggerSource:"manual"}});
 if(!asked.ok)throw Error(asked.code);
 database().prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=2 WHERE id=?").run(asked.request.id);
 const wake=wakeOf(roomRequest(database(),asked.request.id)!);
 writeFileSync(join(DATA_DIR,"shared-routine-authority.json"),"{}");
 const ceiling=await restartAndWake(wake.id,{routineSourceThread:()=>false});
 expect(ceiling).toEqual({permissionMode:"ask",triggerSource:"schedule"}); // a lost entry is the closed Ask ceiling
 const perms=await import("./routine-permissions.ts");
 expect(perms.peerTurnAuthority({autoApprove:true,fullAccess:true},ceiling!)).toMatchObject({mode:"ask",origin:"routine"});
});
it("restart: an absent authority file is Ask for a routine-derived request, wake and direct",async()=>{
 const f=fixture(),from=f.teams[0].bot;
 const asked=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"sweep",admissionKey:"prov-nofile",ownerAudience:true,now:1,routineAuthority:{permissionMode:"auto",triggerSource:"manual"}});
 if(!asked.ok)throw Error(asked.code);
 database().prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=2 WHERE id=?").run(asked.request.id);
 const wake=wakeOf(roomRequest(database(),asked.request.id)!);
 rmSync(join(DATA_DIR,"shared-routine-authority.json"),{force:true});
 expect(await restartAndWake(wake.id)).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 const again=await import("./shared-work.ts");
 expect(again.sharedRequestRoutineAuthority(asked.request.id)).toEqual({permissionMode:"ask",triggerSource:"schedule"});
});
it("restart: an explicitly non-routine request with no authority entry is unchanged (no ceiling)",async()=>{
 const f=fixture(),plain=f.enqueue(0,"prov-none");if(!plain.ok)throw Error(plain.code);
 database().prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=2 WHERE id=?").run(plain.request.id);
 const wake=wakeOf(roomRequest(database(),plain.request.id)!);
 writeFileSync(join(DATA_DIR,"shared-routine-authority.json"),"{}");
 expect(await restartAndWake(wake.id,{routineSourceThread:()=>false},f.store)).toBeUndefined();
});
it("restart: a missing lower ceiling does not let a broader surviving ancestor win",async()=>{
 const f=fixture(),from=f.teams[0].bot;
 const top=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"top",admissionKey:"low-top",ownerAudience:true,now:1,routineAuthority:{permissionMode:"auto",triggerSource:"manual"}});
 if(!top.ok)throw Error(top.code);
 const mid=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"mid",admissionKey:"low-mid",ownerAudience:true,now:2,parentRequestId:top.request.id,routineAuthority:{permissionMode:"ask",triggerSource:"manual"}});
 if(!mid.ok)throw Error(mid.code);
 database().prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=3 WHERE id IN (?,?)").run(top.request.id,mid.request.id);
 const wake=wakeOf(roomRequest(database(),mid.request.id)!);
 // the lower (mid) record is gone entirely: provenance row and file entry
 database().prepare("DELETE FROM shared_request_provenance WHERE request_id=?").run(mid.request.id);
 const file=join(DATA_DIR,"shared-routine-authority.json"),map=JSON.parse(readFileSync(file,"utf8"));delete map[mid.request.id];writeFileSync(file,JSON.stringify(map));
 expect(await restartAndWake(wake.id,{routineSourceThread:()=>false},f.store)).toEqual({permissionMode:"ask",triggerSource:"schedule"});
});

// INT2 pass-4 finding 2/3: synthetic wakes carry no provenance by design; the table comes from the database initializer.
it("restart: a nonroutine chain W1 -> W2 stays unchanged, and a routine chain through the same wakes is still Ask",async()=>{
 const f=fixture(),from=f.teams[0].bot;
 const plain=f.enqueue(0,"w-plain");if(!plain.ok)throw Error(plain.code);
 const routine=enqueueSharedWork(f.store,{fromBotId:from.id,sourceThreadId:from.threadId,toBotId:f.iris.id,message:"sweep",admissionKey:"w-routine",ownerAudience:true,now:1,routineAuthority:{permissionMode:"ask",triggerSource:"schedule"}});
 if(!routine.ok)throw Error(routine.code);
 database().prepare("UPDATE room_requests SET state='waiting_bot',dispatched_at=2 WHERE id IN (?,?)").run(plain.request.id,routine.request.id);
 const w1=wakeOf(roomRequest(database(),plain.request.id)!),w2=wakeOf(roomRequest(database(),w1.id)!,4);
 const r1=wakeOf(roomRequest(database(),routine.request.id)!),r2=wakeOf(roomRequest(database(),r1.id)!,4);
 closeDatabase();vi.resetModules();
 (await import("./execution-audience.ts")).setExecutionStore(f.store);
 const fresh=await import("./shared-work.ts"),rr=await import("./room-requests.ts"),db=(await import("./database.ts")).database();
 for(const id of [w1.id,w2.id])expect(fresh.sharedWakeRoutineAuthority(rr.roomRequest(db,id)!,{routineSourceThread:()=>false})).toBeUndefined();
 for(const id of [r1.id,r2.id])expect(fresh.sharedWakeRoutineAuthority(rr.roomRequest(db,id)!,{routineSourceThread:()=>false})).toEqual({permissionMode:"ask",triggerSource:"schedule"});
 // the broken-chain fallback is kept
 db.prepare("UPDATE room_requests SET parent_id='gone' WHERE id=?").run(w1.id);
 expect(fresh.sharedWakeRoutineAuthority(rr.roomRequest(db,w2.id)!,{routineSourceThread:()=>false})).toEqual({permissionMode:"ask",triggerSource:"schedule"});
});
it("the provenance table exists from the database initializer, before any shared request",()=>{
 fixture();
 expect(database().prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='shared_request_provenance'").get()).toBeTruthy();
});
