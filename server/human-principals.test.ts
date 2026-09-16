import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { ensureScope, memoryAccess, assertMemoryAccess, reconcileMemoryRoster } from "./memory/policy.ts";
import { writeBotIdentity } from "./memory/identity.ts";
import { hydrateMemoryRecord } from "./memory/bundle.ts";
import { searchMemory } from "./memory/search.ts";
import { getOrCreateChannel, mirrorExchange } from "./comms-visibility.ts";
import { observeVerifiedHuman, linkHumanBinding, resolveHumanBinding, humanTask, threadHumanPrincipal, revokeHumanConnection, shareHumanScope, assertHumanPrincipal, bindHumanThread, resolveHumanDelivery, humanBindingStatus } from "./human-principals.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
const fresh=()=>new Store(()=>({instanceId:"fixture",model:"fixture"}));
function person(userId="UOTHER"){
  const id=observeVerifiedHuman({platform:"slack",authorityId:"TEAM",connectionId:"connection-"+userId,userId});
  linkHumanBinding(ownerMemoryTicket(),{bindingId:id,expectedRevision:1,as:"person"});
  return resolveHumanBinding(id);
}
function access(store:Store,botId:string,threadId:string){
  const roster=()=>({bots:store.bots,groups:store.groups});reconcileMemoryRoster(roster());
  const principal=threadHumanPrincipal(threadId),registry=new InternalCapabilities(),generation=registry.begin(botId,threadId,undefined,principal);
  const token=registry.mint({botId,threadId,generation,depth:0,kind:"memory",skillAuthoring:false,humanPrincipal:principal});
  return {registry,token,access:memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,roster)};
}
it("requires owner linking and preserves old owner transcript attribution",()=>{
  const store=fresh(),bot=store.createBot();store.appendMessage(bot.threadId,{role:"user",kind:"text",text:"OWNER_PRIVATE_CANARY"});
  const id=observeVerifiedHuman({platform:"telegram",authorityId:"123",connectionId:"123",userId:"456"});
  expect(()=>resolveHumanBinding(id)).toThrow("HUMAN_LINK_REQUIRED");
  expect(()=>linkHumanBinding({}, {bindingId:id,expectedRevision:1,as:"owner"})).toThrow("MEMORY_OWNER_REQUIRED");
  const principal=person();expect(()=>bindHumanThread(bot.threadId,principal)).toThrow("HUMAN_THREAD_NOT_EMPTY");
  expect(threadHumanPrincipal(bot.threadId).personId).toBe("workspace-owner");
});
it("separates two people, three bots, delegated mirrors and native cursors across restart",()=>{
  const store=fresh(),bots=[store.createBot(),store.createBot(),store.createBot()],principal=person();
  for(const bot of bots){store.setResumeCursor(bot.id,"fixture","OWNER_SESSION",bot.threadId);store.patchBot(bot.id,{autoApprove:true,computer:"local",browser:true,composio:true});}
  const ownerThread=bots[0].threadId,task=humanTask(store,bots[0].id,principal)!;
  expect(task.threadId).not.toBe(ownerThread);expect(task.resumeCursors).toEqual({});
  expect(store.projectBotForTask(bots[0].id,task.threadId)).toMatchObject({autoApprove:false,alwaysAllow:[],computer:"off",browser:false,composio:false});
  const room=getOrCreateChannel(store,bots[0],bots[1],task.threadId);
  mirrorExchange({store,broadcast:()=>{}},bots[0],bots[1],"PERSON_PRIVATE_CANARY",room,task.threadId);
  expect(threadHumanPrincipal(room.threadId)).toEqual(principal);
  expect(store.messagesFor(bots[1].threadId).some(message=>message.text?.includes("PERSON_PRIVATE_CANARY"))).toBe(false);
  const peer=humanTask(store,bots[1].id,principal)!;store.appendMessage(peer.threadId,{role:"user",kind:"text",text:"PERSON_PRIVATE_CANARY"});
  expect(database().prepare("SELECT speaker FROM memory_sources WHERE thread_id=? AND kind='text'").get(peer.threadId)?.speaker).toBe("person:"+principal.personId);
  const restored=fresh();expect(humanTask(restored,bots[0].id,principal)?.threadId).toBe(task.threadId);
  expect(restored.projectBotForTask(bots[0].id,ownerThread)?.resumeCursors.fixture).toBe("OWNER_SESSION");
  expect(humanTask(restored,bots[2].id,principal)?.resumeCursors).toEqual({});
});
it("allows explicit room sharing but rejects private canon on get and search even with a broad bot grant",async()=>{
  const store=fresh(),bot=store.createBot(),peer=store.createBot(),principal=person(),task=humanTask(store,bot.id,principal)!;
  const room=store.createGroup("Shared project",[bot.id,peer.id]);
  const ticket=ownerMemoryTicket(),roster={bots:store.bots,groups:store.groups};
  const canon=writeBotIdentity(ticket,{action:"identity-write",botId:bot.id,kind:"character-canon",key:"private",expectedVersion:0,text:"OWNER_CANON_CANARY",basis:"fiction",audience:"owner-private"},roster);
  shareHumanScope(ticket,{personId:principal.personId,scopeId:ensureScope("room",room.id),granted:true});
  shareHumanScope(ticket,{personId:principal.personId,scopeId:ensureScope("bot",bot.id),granted:true});
  const context=access(store,bot.id,task.threadId);
  expect(()=>assertMemoryAccess(context.access,ensureScope("room",room.id))).not.toThrow();
  expect(()=>assertMemoryAccess(context.access,ensureScope("conversation",bot.threadId))).toThrow("MEMORY_SCOPE_DENIED");
  expect(()=>hydrateMemoryRecord(canon.id,canon.version,context.access)).toThrow("MEMORY_SCOPE_DENIED");
  const result=await searchMemory("OWNER_CANON_CANARY",context.access,{search:async()=>({hits:[{id:canon.id,version:canon.version,score:1,text:canon.text}],vectorRows:0})});
  expect(JSON.stringify(result)).not.toContain("OWNER_CANON_CANARY");
  shareHumanScope(ticket,{personId:principal.personId,scopeId:ensureScope("room",room.id),granted:false});
  expect(()=>assertMemoryAccess(context.access)).toThrow("MEMORY_CONTEXT_REVOKED");
});
it("reads back owner person shares so people controls never assume a grant",()=>{
  const store=fresh(),bot=store.createBot(),peer=store.createBot(),principal=person(),room=store.createGroup("Shared project",[bot.id,peer.id]);
  const ticket=ownerMemoryTicket(),scopeId=ensureScope("room",room.id);
  expect(humanBindingStatus(ticket).shares).toEqual([]);
  shareHumanScope(ticket,{personId:principal.personId,scopeId,granted:true});
  expect(humanBindingStatus(ticket).shares).toEqual([{personId:principal.personId,scopeId,granted:true,revision:1}]);
  shareHumanScope(ticket,{personId:principal.personId,scopeId,granted:false});
  expect(humanBindingStatus(ticket).shares).toEqual([{personId:principal.personId,scopeId,granted:false,revision:2}]);
});
it("relinking and channel revocation invalidate capabilities and never reuse the old task",()=>{
  const store=fresh(),bot=store.createBot(),principal=person(),task=humanTask(store,bot.id,principal)!;
  const context=access(store,bot.id,task.threadId);store.setResumeCursor(bot.id,"fixture","PERSON_SESSION",task.threadId);
  linkHumanBinding(ownerMemoryTicket(),{bindingId:principal.bindingId,expectedRevision:principal.revision,as:"person"});
  expect(context.registry.resolve(`Bearer ${context.token}`)).toBeNull();expect(()=>assertHumanPrincipal(principal)).toThrow("HUMAN_BINDING_REVOKED");
  const replacement=resolveHumanBinding(principal.bindingId),next=humanTask(store,bot.id,replacement)!;
  expect(next.threadId).not.toBe(task.threadId);expect(next.resumeCursors).toEqual({});
  revokeHumanConnection("slack","connection-UOTHER");expect(()=>resolveHumanBinding(principal.bindingId)).toThrow("HUMAN_LINK_REQUIRED");
  observeVerifiedHuman({platform:"slack",authorityId:"TEAM",connectionId:"connection-UOTHER",userId:"UOTHER"});
  expect(()=>resolveHumanBinding(principal.bindingId)).toThrow("HUMAN_LINK_REQUIRED");
});

it("freezes refused and admitted deliveries so retries cannot change human after linking",()=>{
  const id=observeVerifiedHuman({platform:"discord",authorityId:"app",connectionId:"connection",userId:"sender"});
  expect(()=>resolveHumanDelivery(id,"unlinked")).toThrow("HUMAN_LINK_REQUIRED");
  linkHumanBinding(ownerMemoryTicket(),{bindingId:id,expectedRevision:1,as:"person"});
  expect(()=>resolveHumanDelivery(id,"unlinked")).toThrow("HUMAN_LINK_REQUIRED");
  const principal=resolveHumanDelivery(id,"admitted");expect(resolveHumanDelivery(id,"admitted")).toEqual(principal);
  linkHumanBinding(ownerMemoryTicket(),{bindingId:id,expectedRevision:principal.revision,as:"person"});
  expect(()=>resolveHumanDelivery(id,"admitted")).toThrow("HUMAN_BINDING_REVOKED");
  expect(resolveHumanDelivery(id,"fresh").personId).not.toBe(principal.personId);
});
