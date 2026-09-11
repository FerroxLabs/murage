import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { guardTurnDispatch, RetiredTurnRegistry } from "../turn-dispatch-guard.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { buildMemoryBundle, supersededThreadCheckpoint } from "./bundle.ts";
import { threadCheckpointId } from "./checkpoints.ts";
import { buildMemoryBundleAfterReset, MemoryDispatchReceipt } from "./dispatch.ts";
import { forgetMemory } from "./forget.ts";
import { archiveMemoryRecord } from "./retention.ts";
import { continuationMemoryRevoked, filterMemoryReplay } from "./disclosures.ts";
import { ownerMemoryTicket } from "./authority.ts";

const threadId="7f00a32e-17a4-426b-bdc6-910220ba66c9";
const roster={bots:[{id:"bot",threadId}],groups:[]};
const bridge={search:async()=>({hits:[],vectorRows:0})};
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);setMemoryMode("capture");});
function fixture(){
  const registry=new InternalCapabilities(),generation=registry.begin("bot",threadId);
  const token=registry.mint({botId:"bot",threadId,generation,depth:0,kind:"memory",skillAuthoring:false});
  return {registry,access:memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster)};
}
function checkpoint(text:string){
  const sourceId=`message:${threadId}:${randomUUID()}`;
  captureSource(database(),{id:sourceId,threadId,messageId:randomUUID(),kind:"text",speaker:"owner",outcome:"recorded",text});
  const work=claimMemoryJob("dispatch-reset-fixture");
  if(!work)throw Error("No actual capture job");
  publishMemoryWork(work,"dispatch-reset-fixture",captureWork(work));
  const result=refreshMemoryCheckpoint(work.id);
  if(result.status!=="updated")throw Error("Expected actual checkpoint publication");
  return {sourceId,id:result.checkpointId,version:result.version};
}

// Until Q1-T5 §4.1 a selected checkpoint that rolled over before receipt
// construction failed preparation with MEMORY_RECORD_UNAVAILABLE. The thread's
// own checkpoint rolls on every captured message in that thread, so that
// supersession is now staleness (bundle.ts supersededThreadCheckpoint): the
// receipt prepares the version it selected and discloses exactly that.
it("prepares a bundle whose own-thread checkpoint rolled over during reset as stale, not revoked",async()=>{
  const f=fixture(),first=checkpoint("Verified initial result.");
  const before=await buildMemoryBundle("result",f.access,bridge);
  expect(before.recordVersions).toContainEqual({id:first.id,version:first.version});
  await Promise.resolve().then(()=>checkpoint("Verified later result."));
  expect(database().prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(first.id,first.version)?.state).toBe("archived");
  const receipt=new MemoryDispatchReceipt(before,f.access,"fixture");
  expect(()=>receipt.assertCurrent()).not.toThrow();
  expect(JSON.parse(String(database().prepare("SELECT record_versions FROM memory_disclosures WHERE bundle_id=?").get(before.bundleId)?.record_versions))).toContainEqual({id:first.id,version:first.version});
});

it("treats the thread's own checkpoint superseded inside the dispatch window as stale: the accepted turn runs and its reply stays replayable",async()=>{
  const f=fixture(),first=checkpoint("Verified initial result.");
  const bundle=await buildMemoryBundleAfterReset("result",f.access,bridge,async()=>{});
  expect(bundle.recordVersions).toContainEqual({id:first.id,version:first.version});
  const receipt=new MemoryDispatchReceipt(bundle,f.access,"fixture");
  receipt.assertCurrent();
  // The turn's own prompt capture completes in the worker while the provider is still starting.
  expect(checkpoint("The turn's own prompt, captured meanwhile.")).toMatchObject({id:first.id,version:first.version+1});
  expect(database().prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(first.id,first.version)?.state).toBe("archived");
  expect(()=>receipt.assertCurrent()).not.toThrow();
  let stopped=false;
  const guarded=await guardTurnDispatch(Promise.resolve({turnId:"accepted-provider"}),()=>false,async()=>{stopped=true;},()=>receipt.accepted());
  expect(guarded).toEqual({value:{turnId:"accepted-provider"},cancelled:false});
  expect(stopped).toBe(false);
  expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)?.state).toBe("delivered");
  receipt.sessionStarted("native");receipt.output("reply-1");receipt.completed(true);
  // The reply's own capture rolls the checkpoint again; the next turn still
  // replays this reply and may resume the native session.
  expect(checkpoint("The reply, captured.")).toMatchObject({id:first.id,version:first.version+2});
  const next=fixture();
  expect(filterMemoryReplay(threadId,[{id:"reply-1"}],next.access).map(message=>message.id)).toEqual(["reply-1"]);
  expect(continuationMemoryRevoked(threadId,"fixture","native",next.access)).toBe(false);
  expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)?.state).toBe("delivered");
});

it("keeps every other revocation of a disclosed checkpoint fail-closed",async()=>{
  const prepared=async(text:string)=>{
    const f=fixture(),first=checkpoint(text),bundle=await buildMemoryBundle("result",f.access,bridge);
    expect(bundle.recordVersions).toContainEqual({id:first.id,version:first.version});
    return {f,first,receipt:new MemoryDispatchReceipt(bundle,f.access,"fixture")};
  };
  // Archived without a successor is not supersession.
  {const {first,receipt}=await prepared("Archived, no successor.");
    database().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(first.id,first.version);
    expect(()=>receipt.assertCurrent()).toThrow("MEMORY_RECORD_UNAVAILABLE");
    expect(()=>receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");}
  // A superseded version whose evidence source retired is not disclosable.
  {const {first,receipt}=await prepared("Retired evidence.");checkpoint("Roll.");
    database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(first.sourceId);
    expect(()=>receipt.assertCurrent()).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
    expect(()=>receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");}
  // A tombstoned version stays refused even with a newer active version.
  {const {first,receipt}=await prepared("Tombstoned version.");checkpoint("Roll.");
    database().prepare("INSERT INTO memory_tombstones VALUES(?,'record',?,?,NULL,0,'fixture',?)").run(randomUUID(),first.id,first.version,Date.now());
    expect(()=>receipt.assertCurrent()).toThrow("MEMORY_RECORD_UNAVAILABLE");
    expect(()=>receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");}
  // An owner forget moves the deletion epoch: refused before any record check.
  {const {first,receipt}=await prepared("Forgotten evidence.");checkpoint("Roll.");
    forgetMemory(ownerMemoryTicket(),{kind:"source",id:first.sourceId,revision:1});
    expect(()=>receipt.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(()=>receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");}
  // An owner archive moves the policy revision, successor or not.
  {const {first,receipt}=await prepared("Owner-archived.");
    archiveMemoryRecord(ownerMemoryTicket(),first.id,first.version);
    expect(()=>receipt.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(()=>receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");}
});

it("recognizes only the current thread's own checkpoint as superseded",()=>{
  const otherThread="0c5a7e0e-2f0d-4b7e-9c2a-6d4e1f3a8b90";
  const wider={bots:[{id:"bot",threadId},{id:"other",threadId:otherThread}],groups:[]};
  reconcileMemoryRoster(wider);
  const first=checkpoint("Own thread evidence.");checkpoint("Roll.");
  const registry=new InternalCapabilities();
  const access=(botId:string,thread:string)=>{const generation=registry.begin(botId,thread);const token=registry.mint({botId,threadId:thread,generation,depth:0,kind:"memory",skillAuthoring:false});return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>wider);};
  expect(supersededThreadCheckpoint(first.id,first.version,access("bot",threadId))).toBe(true);
  expect(supersededThreadCheckpoint(first.id,first.version,access("other",otherThread))).toBe(false);
  expect(supersededThreadCheckpoint(first.id,first.version+1,access("bot",threadId))).toBe(false);
});

// RED2E: a room member's turn is claimed for the room thread (server/index.ts
// runGroupMemberTurn → turnMemoryAccess(bot.id, threadId, …)), so the room
// thread's checkpoint is that turn's own. It rolls on every captured message
// in the room — the member's prompt and reply included — and that roll inside
// the member's dispatch window is the same self-inflicted cancel as in a bot's
// own thread. Recognition is keyed by the dispatched thread, never by the
// member: another room's checkpoint and the member's own-thread checkpoint
// are not recognized, and owner forget/archive still revoke.
const roomThread="1d2e3f40-6b1c-4d8e-9f0a-2b3c4d5e6f70", roomTaskThread="3f405162-8d3e-4fa0-b12c-4d5e6f708192", otherRoomThread="2e3f4051-7c2d-4e9f-a01b-3c4d5e6f7081", otherBotThread="0c5a7e0e-2f0d-4b7e-9c2a-6d4e1f3a8b90";
const roomRoster={bots:[{id:"bot",threadId},{id:"other",threadId:otherBotThread}],groups:[{id:"room",threadId:roomThread,memberIds:["bot","other"],tasks:[{threadId:roomTaskThread}]},{id:"other-room",threadId:otherRoomThread,memberIds:["other"]}]};
function roomFixture(botId:string,thread:string){
  const registry=new InternalCapabilities(),generation=registry.begin(botId,thread);
  const token=registry.mint({botId,threadId:thread,generation,depth:0,kind:"memory",skillAuthoring:false});
  return {registry,access:memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roomRoster)};
}
function roomCheckpoint(thread:string,text:string,speaker="owner"){
  const sourceId=`message:${thread}:${randomUUID()}`;
  captureSource(database(),{id:sourceId,threadId:thread,messageId:randomUUID(),kind:"text",speaker,outcome:"recorded",text});
  const work=claimMemoryJob("dispatch-reset-fixture");
  if(!work)throw Error("No actual capture job");
  publishMemoryWork(work,"dispatch-reset-fixture",captureWork(work));
  const result=refreshMemoryCheckpoint(work.id);
  if(result.status!=="updated")throw Error("Expected actual checkpoint publication");
  return {sourceId,id:result.checkpointId,version:result.version};
}

it("treats the room checkpoint superseded inside a member's dispatch window as stale: the member turn runs and its reply stays replayable for the next member",async()=>{
  reconcileMemoryRoster(roomRoster);
  const member=roomFixture("bot",roomThread),first=roomCheckpoint(roomThread,"Room evidence.");
  expect(first.id).toBe(threadCheckpointId(String(database().prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key=?").get(roomThread)!.id),roomThread));
  const bundle=await buildMemoryBundleAfterReset("evidence",member.access,bridge,async()=>{});
  expect(bundle.recordVersions).toContainEqual({id:first.id,version:first.version});
  const receipt=new MemoryDispatchReceipt(bundle,member.access,"fixture");
  receipt.assertCurrent();
  // The member's own prompt capture completes in the worker while the provider is still starting.
  expect(roomCheckpoint(roomThread,"The member's prompt, captured meanwhile.")).toMatchObject({id:first.id,version:first.version+1});
  expect(database().prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(first.id,first.version)?.state).toBe("archived");
  expect(supersededThreadCheckpoint(first.id,first.version,member.access)).toBe(true);
  expect(()=>receipt.assertCurrent()).not.toThrow();
  let stopped=false;
  const guarded=await guardTurnDispatch(Promise.resolve({turnId:"accepted-provider"}),()=>false,async()=>{stopped=true;},()=>receipt.accepted());
  expect(guarded).toEqual({value:{turnId:"accepted-provider"},cancelled:false});
  expect(stopped).toBe(false);
  expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)?.state).toBe("delivered");
  receipt.sessionStarted("native");receipt.output("member-reply");receipt.completed(true);
  // The reply's capture rolls the room checkpoint again; the next turn in the
  // room — by this member or by the other one — still replays that reply.
  expect(roomCheckpoint(roomThread,"The member's reply, captured.","bot")).toMatchObject({id:first.id,version:first.version+2});
  for(const botId of ["bot","other"]){
    const next=roomFixture(botId,roomThread);
    expect(filterMemoryReplay(roomThread,[{id:"member-reply"}],next.access).map(message=>message.id)).toEqual(["member-reply"]);
  }
  expect(continuationMemoryRevoked(roomThread,"fixture","native",roomFixture("bot",roomThread).access)).toBe(false);
  expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)?.state).toBe("delivered");
});

it("recognizes exactly the dispatched room's checkpoint for a member turn",()=>{
  reconcileMemoryRoster(roomRoster);
  const room=roomCheckpoint(roomThread,"Room evidence.");roomCheckpoint(roomThread,"Roll.");
  const own=roomCheckpoint(threadId,"Own-thread evidence.");roomCheckpoint(threadId,"Roll.");
  const elsewhere=roomCheckpoint(otherRoomThread,"Other room evidence.");roomCheckpoint(otherRoomThread,"Roll.");
  expect(supersededThreadCheckpoint(room.id,room.version,roomFixture("bot",roomThread).access)).toBe(true);
  expect(supersededThreadCheckpoint(room.id,room.version,roomFixture("other",roomThread).access)).toBe(true);
  // The member's own-thread checkpoint is not the room turn's, and the room's
  // is not the member's own-thread turn's.
  expect(supersededThreadCheckpoint(own.id,own.version,roomFixture("bot",roomThread).access)).toBe(false);
  expect(supersededThreadCheckpoint(room.id,room.version,roomFixture("bot",threadId).access)).toBe(false);
  // Another room's checkpoint is never recognized, whoever is dispatched.
  expect(supersededThreadCheckpoint(elsewhere.id,elsewhere.version,roomFixture("bot",roomThread).access)).toBe(false);
  expect(supersededThreadCheckpoint(elsewhere.id,elsewhere.version,roomFixture("other",roomThread).access)).toBe(false);
  expect(supersededThreadCheckpoint(room.id,room.version,roomFixture("other",otherRoomThread).access)).toBe(false);
  // The current version is not superseded.
  expect(supersededThreadCheckpoint(room.id,room.version+1,roomFixture("bot",roomThread).access)).toBe(false);
  // A room task thread is its own dispatched group thread: a member turn in
  // the task recognizes the task's checkpoint, not the room's main-thread
  // checkpoint, and a main-thread member turn does not recognize the task's.
  const task=roomCheckpoint(roomTaskThread,"Room task evidence.");roomCheckpoint(roomTaskThread,"Roll.");
  expect(task.id).not.toBe(room.id);
  expect(supersededThreadCheckpoint(task.id,task.version,roomFixture("bot",roomTaskThread).access)).toBe(true);
  expect(supersededThreadCheckpoint(task.id,task.version,roomFixture("other",roomTaskThread).access)).toBe(true);
  expect(supersededThreadCheckpoint(room.id,room.version,roomFixture("bot",roomTaskThread).access)).toBe(false);
  expect(supersededThreadCheckpoint(task.id,task.version,roomFixture("bot",roomThread).access)).toBe(false);
});

it("keeps owner revocation of a disclosed room checkpoint fail-closed for the member turn",async()=>{
  reconcileMemoryRoster(roomRoster);
  const prepared=async(text:string)=>{
    const member=roomFixture("bot",roomThread),first=roomCheckpoint(roomThread,text),bundle=await buildMemoryBundle("evidence",member.access,bridge);
    expect(bundle.recordVersions).toContainEqual({id:first.id,version:first.version});
    return {first,receipt:new MemoryDispatchReceipt(bundle,member.access,"fixture")};
  };
  // An owner forget of the room evidence moves the deletion epoch.
  {const {first,receipt}=await prepared("Forgotten room evidence.");roomCheckpoint(roomThread,"Roll.");
    forgetMemory(ownerMemoryTicket(),{kind:"source",id:first.sourceId,revision:1});
    expect(()=>receipt.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(()=>receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");}
  // An owner archive of the room checkpoint moves the policy revision.
  {const {first,receipt}=await prepared("Owner-archived room checkpoint.");
    archiveMemoryRecord(ownerMemoryTicket(),first.id,first.version);
    expect(()=>receipt.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(()=>receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");}
  // Archived without a successor is not supersession.
  {const {first,receipt}=await prepared("Archived room checkpoint, no successor.");
    database().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(first.id,first.version);
    expect(()=>receipt.assertCurrent()).toThrow("MEMORY_RECORD_UNAVAILABLE");
    expect(()=>receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");}
});

it("builds after checkpoint rollover during reset and prepares the current version without a provider retry",async()=>{
  const f=fixture(),first=checkpoint("Verified initial result.");let resets=0;
  const bundle=await buildMemoryBundleAfterReset("result",f.access,bridge,async()=>{
    resets++;await Promise.resolve();checkpoint("Verified later result.");
  });
  expect(resets).toBe(1);
  expect(bundle.recordVersions).toContainEqual({id:first.id,version:first.version+1});
  expect(bundle.recordVersions).not.toContainEqual({id:first.id,version:first.version});
  const receipt=new MemoryDispatchReceipt(bundle,f.access,"fixture");
  expect(()=>receipt.assertCurrent()).not.toThrow();
  expect(database().prepare("SELECT count(*) AS n FROM memory_disclosures").get()?.n).toBe(1);
});

it("retains original authority when the turn is revoked during session reset",async()=>{
  const f=fixture();checkpoint("Retain evidence.");
  await expect(buildMemoryBundleAfterReset("result",f.access,bridge,async()=>{
    f.registry.revokeThread(threadId);
  })).rejects.toThrow("MEMORY_UNAUTHORIZED");
  expect(database().prepare("SELECT count(*) AS n FROM memory_disclosures").get()?.n).toBe(0);
});

it("refuses forgotten evidence during reset through the original deletion epoch",async()=>{
  const f=fixture(),first=checkpoint("Forget this evidence.");
  await expect(buildMemoryBundleAfterReset("result",f.access,bridge,async()=>{
    forgetMemory(ownerMemoryTicket(),{kind:"source",id:first.sourceId,revision:1});
  })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
});

it("never drops a mandatory pin whose supporting evidence retires during reset",async()=>{
  const f=fixture(),first=checkpoint("Mandatory backed-up constraint.");
  database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=? AND version=?").run(first.id,first.version);
  await expect(buildMemoryBundleAfterReset("result",f.access,bridge,async()=>{
    database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(first.sourceId);
  })).rejects.toThrow("MEMORY_PIN_UNAVAILABLE");
});

it("uses post-reset bundle preparation in both real dispatch paths before receipt construction",()=>{
  const source=readFileSync(new URL("../index.ts",import.meta.url),"utf8");
  const direct=source.slice(source.indexOf("      let memoryReceipt: MemoryDispatchReceipt | undefined;"),source.indexOf("      if (!markDirectTurnDispatching"));
  const roomStart=source.indexOf("  const prepareRoomMemory=async()=>{");
  const room=source.slice(roomStart,source.indexOf("  let providerTurnId",roomStart));
  expect(direct).toContain("bundle=await buildMemoryBundleAfterReset(query,access,memoryWorker");
  expect(room).toContain("const bundle=await buildMemoryBundleAfterReset(query,access,memoryWorker");
  for(const block of [direct,room]){
    const reset=block.indexOf("buildMemoryBundleAfterReset(");
    expect(reset).toBeGreaterThan(-1);
    expect(block.lastIndexOf("filterMemoryReplay(")).toBeGreaterThan(reset);
    expect(block.indexOf("new MemoryDispatchReceipt(")).toBeGreaterThan(reset);
  }
});

it("retires an accepted provider and awaits interruption when true forgetting invalidates its memory receipt",async()=>{
  const f=fixture(),source=checkpoint("Evidence that the owner may forget.");
  const bundle=await buildMemoryBundle("result",f.access,bridge),receipt=new MemoryDispatchReceipt(bundle,f.access,"fixture");
  let acceptProvider!:(value:{turnId:string})=>void;
  const provider=new Promise<{turnId:string}>(resolve=>{acceptProvider=resolve;});
  let finishStop!:()=>void;
  const stop=new Promise<void>(resolve=>{finishStop=resolve;});
  const retired=new RetiredTurnRegistry();let released=false;
  const guarded=guardTurnDispatch(provider,()=>false,async accepted=>{
    retired.retire(accepted.turnId);await stop;
  },()=>receipt.accepted()).catch(error=>{released=true;throw error;});
  const failure=expect(guarded).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  forgetMemory(ownerMemoryTicket(),{kind:"source",id:source.sourceId,revision:1});
  acceptProvider({turnId:"accepted-provider"});
  await Promise.resolve();await Promise.resolve();
  expect(retired.has("accepted-provider")).toBe(true);expect(released).toBe(false);
  finishStop();await failure;expect(released).toBe(true);
  expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)?.state).not.toBe("delivered");
});
