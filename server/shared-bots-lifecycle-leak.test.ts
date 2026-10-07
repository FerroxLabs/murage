// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { enqueueSharedWork, changeSharing } from "./shared-work.ts";
import { authorizeWork, threadPartition } from "./execution-audience.ts";
import { getOrCreateChannel } from "./comms-visibility.ts";
import { continuationResultsForThread, requestReturnsTo, partitionTranscriptMessages } from "./partition-sources.ts";
import { backgroundMemoryScopes, ensureScope } from "./memory/policy.ts";
import { renameTeam, deleteTeam, teamRevision } from "./team-sections.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { repairRestoredSharing } from "./sharing-restore.ts";
import { roomRequest } from "./room-requests.ts";
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
const deps={memoryTicket:ownerMemoryTicket(),leadershipError:()=>null,groupWorking:()=>false,channelArchived:()=>{},reachabilityChanged:()=>{}};
function fixture(){
 const store=new Store(()=>({instanceId:"fixture",model:"fixture"}));const make=(name:string,section:string,lead=false)=>{const b=store.createBot();store.patchBot(b.id,{name,section,chiefOfStaff:lead});return b;};
 const iris=make("Iris","Design"),zed=make("Zed","Other"),sam=make("Sam","Sales",true),tia=make("Tia","Support",true);
 const sales=teamIdFor("Sales"),support=teamIdFor("Support");for(const b of [iris,zed])store.patchBot(b.id,{sharedWith:{mode:"all",teams:[]}});
 const a=enqueueSharedWork(store,{fromBotId:sam.id,sourceThreadId:sam.threadId,toBotId:iris.id,message:"CANARY_SALES_PRIVATE",admissionKey:"sales",ownerAudience:true,now:1});
 const b=enqueueSharedWork(store,{fromBotId:tia.id,sourceThreadId:tia.threadId,toBotId:iris.id,message:"CANARY_SUPPORT_PRIVATE",admissionKey:"support",ownerAudience:true,now:2});if(!a.ok||!b.ok)throw Error("fixture");
 const result=store.appendMessage(a.request.targetThreadId!,{role:"bot",kind:"text",text:"CANARY_SALES_RESULT",requestId:a.request.id});database().prepare("UPDATE room_requests SET result_message_id=? WHERE id=?").run(result.id,a.request.id);
 return {store,iris,zed,sam,tia,sales,support,a:a.request,b:b.request,result};
}
it.each(["live","revoked","renamed","deleted","restored"])("Sales remains unreachable from Support after %s",phase=>{
 const f=fixture(),scope=ensureScope("bot",`${f.iris.id}#team:${f.sales}`),tag=(team:string)=>({v:1 as const,kind:"team" as const,human:"owner" as const,team,rootRequestId:"root"});
 const pairA=getOrCreateChannel(f.store,f.iris,f.zed,f.a.targetThreadId!,tag(f.sales)),pairB=getOrCreateChannel(f.store,f.iris,f.zed,f.b.targetThreadId!,tag(f.support));expect(pairA.id).not.toBe(pairB.id);
 if(phase==="revoked")changeSharing(f.store,f.iris.id,{mode:"list",teams:[{id:f.support,name:"Support"}]},"stop",{now:10});
 if(phase==="renamed")renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps);
 if(phase==="deleted")deleteTeam(f.store,{section:"Sales",bots:"keep",revision:teamRevision(f.store)},deps);
 if(phase==="restored")repairRestoredSharing(f.store.bots as unknown as Record<string,unknown>[],f.store.groups as unknown as Record<string,unknown>[],10);
 expect(backgroundMemoryScopes(f.iris.id,f.b.targetThreadId!,f.store)).not.toContain(scope);
 expect(threadPartition(f.iris,pairA.threadId)).not.toEqual(threadPartition(f.iris,pairB.threadId));
 expect(requestReturnsTo(database(),f.a.id,f.b.targetThreadId!)).toBe(false);
 expect(authorizeWork({edge:"deliver",requestId:f.a.id,fromBotId:f.iris.id,destinationThreadId:f.b.targetThreadId!})).toMatchObject({ok:false,code:"binding_mismatch"});
 const wake={...f.b,verb:"wake" as const,payloadText:JSON.stringify([{requestId:f.a.id,botId:f.iris.id,state:"done",messageId:f.result.id,note:"CANARY_SALES_PRIVATE"}])};
 expect(continuationResultsForThread(database(),wake,f.b.targetThreadId!)).toEqual([]);
 const forged=f.store.appendMessage(f.b.targetThreadId!,{role:"bot",kind:"activity",tool:{name:"CANARY_SALES_ACTIVITY"},copyOf:{threadId:f.a.targetThreadId!,messageIds:[f.result.id]}});
 expect(partitionTranscriptMessages(database(),f.iris.id,f.b.targetThreadId!,[forged])).toEqual([]);
 expect(roomRequest(database(),f.a.id)?.payloadText).toBe("CANARY_SALES_PRIVATE");
});
