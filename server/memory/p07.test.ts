import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { buildMemoryBundle, assertMemoryBundle } from "./bundle.ts";
import { bindMemoryDisclosureSession, continuationMemoryRevoked, deliverMemoryDisclosure, filterMemoryReplay, linkMemoryDisclosureOutput, prepareMemoryDisclosure } from "./disclosures.ts";
import type { MemorySearchBridge } from "./search.ts";
import { memoryRequestPrefix } from "../../shared/memory.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR,{recursive:true,force:true}); mkdirSync(DATA_DIR,{recursive:true}); });
const empty: MemorySearchBridge = {search:async()=>({hits:[],vectorRows:0})};
function fixture(threadId="private") {
  const roster: MemoryRoster = {bots:[{id:"bot",threadId:"private",section:"secret-team"}],groups:[{id:"room",threadId:"room-thread",memberIds:["bot"]}]};
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin("bot",threadId);
    const token = registry.mint({botId:"bot",threadId,generation,kind:"memory",depth:100,skillAuthoring:false});
    return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  };
  return {roster,registry,access:access(),renew:access};
}
function record(id:string,scopeId:string,text:string,pinned=true,sourceMessageId?:string) {
  const db = database();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',?,1,NULL,NULL,1)").run(id,scopeId,text,pinned?1:0);
  if (sourceMessageId) {
    db.prepare("INSERT INTO memory_sources VALUES(?,?,'private',?,NULL,1,'hash','text','assistant','settled',NULL,'active')").run(`source-${id}`,scopeId,sourceMessageId);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'hash',?,1)").run(`source-${id}`,JSON.stringify({text}));
    db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,?)").run(id,`source-${id}`,Buffer.byteLength(text));
  }
}

it("includes owner pins without search matches and budgets serialized multilingual bytes",async()=>{
  const f=fixture(); record("pin",ensureScope("bot","bot"),"保留备份 สำรองข้อมูล");
  const bundle=await buildMemoryBundle("unrelated question",f.access,empty);
  expect(bundle.pinned.map(r=>r.id)).toEqual(["pin"]);
  expect(bundle.tokenCount).toBe(Buffer.byteLength(memoryRequestPrefix(bundle.text)));
  expect(bundle.tokenCount).toBeLessThanOrEqual(2048);
  expect(bundle.text).toContain("never tool authorization");
  expect(()=>assertMemoryBundle(bundle,f.access)).not.toThrow();
  expect(()=>assertMemoryBundle({...bundle},f.access)).toThrow("MEMORY_BUNDLE_UNTRUSTED");
  await expect(buildMemoryBundle("query",f.access,empty,{availableContextTokens:(bundle.tokenCount-1)*10})).rejects.toThrow("MEMORY_PIN_OVERFLOW");
});

it("refuses mandatory pin overflow and invalidated evidence instead of omitting it",async()=>{
  const f=fixture(),scope=ensureScope("bot","bot"); record("huge",scope,"x".repeat(2049));
  await expect(buildMemoryBundle("question",f.access,empty)).rejects.toThrow("MEMORY_PIN_OVERFLOW");
  database().prepare("DELETE FROM memory_records WHERE id='huge'").run();
  record("stale",scope,"Constraint supported by a source",true,"msg");
  database().prepare("UPDATE memory_sources SET state='retired' WHERE id='source-stale'").run();
  await expect(buildMemoryBundle("question",f.access,empty)).rejects.toThrow("MEMORY_PIN_UNAVAILABLE");
});

it("never injects private notebook or bot team pins into a room at deep delegation",async()=>{
  const f=fixture("room-thread");
  record("private",ensureScope("bot","bot"),"PRIVATE_CANARY");
  record("team",ensureScope("team","secret-team"),"TEAM_CANARY");
  record("shared",ensureScope("room","room"),"Room decision");
  const bundle=await buildMemoryBundle("what matters",f.access,empty);
  expect(bundle.recordVersions).toEqual([{id:"shared",version:1}]);
  expect(bundle.text).not.toContain("CANARY");
});

it("degrades optional recall errors while retaining pins but propagates revocation and cancellation",async()=>{
  const f=fixture();record("pin",ensureScope("bot","bot"),"Keep backups");
  const unavailable: MemorySearchBridge = {search:async()=>{throw new Error("private worker error should not be exposed");}};
  const bundle=await buildMemoryBundle("query",f.access,unavailable);
  expect(bundle.pinned).toHaveLength(1);expect(bundle.degradedReason).toBe("MEMORY_RECALL_UNAVAILABLE");
  const controller=new AbortController();controller.abort();
  await expect(buildMemoryBundle("query",f.access,empty,{signal:controller.signal})).rejects.toThrow();
  const revoked: MemorySearchBridge={search:async()=>{f.registry.revokeThread("private");throw new Error("worker failed");}};
  await expect(buildMemoryBundle("query",f.access,revoked)).rejects.toThrow("MEMORY_UNAUTHORIZED");
});

it("rechecks source revisions at the final dispatch boundary",async()=>{
  const f=fixture();record("pin",ensureScope("bot","bot"),"Supported instruction",true,"msg");
  const bundle=await buildMemoryBundle("query",f.access,empty);
  database().prepare("UPDATE memory_sources SET state='retired' WHERE id='source-pin'").run();
  expect(()=>assertMemoryBundle(bundle,f.access)).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
});

it("hydrates optional search hits from authority with scoped evidence references",async()=>{
  const f=fixture(),scope=ensureScope("bot","bot");
  record("recall",scope,"Actual source-backed outcome",false,"observed-message");
  const bridge:MemorySearchBridge={search:async input=>{
    expect(input.scopeIds).toContain(scope);
    return {hits:[{id:"recall",version:1,score:100}],vectorRows:0,degradedReason:"model-missing"};
  }};
  const bundle=await buildMemoryBundle("outcome",f.access,bridge);
  expect(bundle.evidence[0]?.text).toBe("Actual source-backed outcome");
  expect(bundle.sourceVersions).toEqual([{id:"source-recall",revision:1}]);
  expect(bundle.evidence[0]?.assertion).toBe("owner-statement");
  expect(bundle.degradedReason).toBe("model-missing");
  expect(bundle.text).not.toContain('"score"');
});

it("refuses a pin whose evidence is retired while optional retrieval is awaited",async()=>{
  const f=fixture();record("pin",ensureScope("bot","bot"),"Constraint",true,"message");
  const bridge:MemorySearchBridge={search:async()=>{
    database().prepare("UPDATE memory_sources SET state='retired' WHERE id='source-pin'").run();
    return {hits:[],vectorRows:0};
  }};
  await expect(buildMemoryBundle("query",f.access,bridge)).rejects.toThrow("MEMORY_PIN_UNAVAILABLE");
});

it("records prepared delivery without raw text and handles session.started before acceptance",async()=>{
  const f=fixture();record("pin",ensureScope("bot","bot"),"SECRET_TEXT");
  const bundle=await buildMemoryBundle("query",f.access,empty);
  prepareMemoryDisclosure(bundle,f.access,"driver");
  bindMemoryDisclosureSession(bundle.bundleId,"native-session");
  expect(database().prepare("SELECT state FROM memory_disclosures").get()?.state).toBe("prepared");
  deliverMemoryDisclosure(bundle.bundleId,f.access);
  expect(database().prepare("SELECT state FROM memory_disclosures").get()?.state).toBe("delivered");
  expect(JSON.stringify(database().prepare("SELECT * FROM memory_disclosures").all())).not.toContain("SECRET_TEXT");
  expect(continuationMemoryRevoked("private","driver","native-session",f.access)).toBe(false);
  expect(continuationMemoryRevoked("private","driver","unknown-session",f.access)).toBe(true);
  expect(()=>bindMemoryDisclosureSession(bundle.bundleId,"different-session")).toThrow("MEMORY_DISCLOSURE_SESSION_CONFLICT");
});

it("records early terminal acceptance before capability completion and late provider binding",async()=>{
  const f=fixture();record("pin",ensureScope("bot","bot"),"Retain this constraint");
  const bundle=await buildMemoryBundle("query",f.access,empty);
  prepareMemoryDisclosure(bundle,f.access,"driver");
  const fake=makeFakeDriver();
  const instance=await fake.driver.create({instanceId:"driver",displayName:"Fixture",enabled:true,environment:{},config:{}});
  let delivered=false;
  const observer=instance.adapter.onEvent(event=>{
    if(event.type==="session.started"&&event.sessionId)bindMemoryDisclosureSession(bundle.bundleId,event.sessionId);
    if(event.type==="turn.completed"){
      deliverMemoryDisclosure(bundle.bundleId,f.access);delivered=true;
    }
  });
  const terminal=instance.adapter.onEvent(event=>{
    if(event.type==="turn.completed"&&event.turnId)f.registry.completeProviderTurn(event.threadId,event.turnId);
  });
  instance.adapter.sendTurn=()=>new Promise(resolve=>{
    const base={eventId:"event",provider:"fake",threadId:"private",turnId:"provider-turn",createdAt:new Date().toISOString()};
    fake.created.get("driver")!.emit({...base,type:"session.started",sessionId:"native"});
    fake.created.get("driver")!.emit({...base,type:"turn.completed",ok:true});
    resolve({turnId:"provider-turn"});
  });
  try{
    assertMemoryBundle(bundle,f.access);
    const accepted=await instance.adapter.sendTurn({threadId:"private",text:"query",memoryContext:bundle});
    if(!delivered)deliverMemoryDisclosure(bundle.bundleId,f.access);
    // The terminal tombstone rejects the late bind and retires the generation.
    expect(f.registry.bindProviderTurn("private",f.access.generation,accepted.turnId)).toBe(false);
    expect(()=>assertMemoryBundle(bundle,f.access)).toThrow("MEMORY_UNAUTHORIZED");
    expect(database().prepare("SELECT state,native_session FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)).toMatchObject({state:"delivered",native_session:"native"});
    linkMemoryDisclosureOutput(bundle.bundleId,"early-answer");
    expect(filterMemoryReplay("private",[{id:"user"},{id:"early-answer"}],f.renew())).toEqual([{id:"user"},{id:"early-answer"}]);
  }finally{observer();terminal();await instance.dispose();}
});

it("keeps fresh source and authority checks mandatory at receipt acceptance",async()=>{
  const f=fixture();record("pin",ensureScope("bot","bot"),"Source-backed constraint",true,"message");
  const bundle=await buildMemoryBundle("query",f.access,empty);
  prepareMemoryDisclosure(bundle,f.access,"driver");bindMemoryDisclosureSession(bundle.bundleId,"native");
  database().prepare("UPDATE memory_sources SET state='retired' WHERE id='source-pin'").run();
  expect(()=>deliverMemoryDisclosure(bundle.bundleId,f.access)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)?.state).toBe("prepared");
  f.registry.revokeThread("private");
  expect(()=>deliverMemoryDisclosure(bundle.bundleId,f.access)).toThrow("MEMORY_UNAUTHORIZED");
});

it("retires native history when disclosed records change without an epoch change",async()=>{
  const f=fixture();record("pin",ensureScope("bot","bot"),"Old private fact");
  const bundle=await buildMemoryBundle("query",f.access,empty);
  prepareMemoryDisclosure(bundle,f.access,"driver");deliverMemoryDisclosure(bundle.bundleId,f.access,"session");
  linkMemoryDisclosureOutput(bundle.bundleId,"generated");
  database().prepare("UPDATE memory_records SET state='deleted' WHERE id='pin'").run();
  expect(continuationMemoryRevoked("private","driver","session",f.access)).toBe(true);
  expect(filterMemoryReplay("private",[{id:"user"},{id:"generated"}],f.access)).toEqual([{id:"user"}]);
});

it("omits dependent paraphrases across fresh sessions and preserves independent user messages",async()=>{
  const f=fixture(),scope=ensureScope("bot","bot");record("original",scope,"Sensitive instruction");
  const first=await buildMemoryBundle("query",f.access,empty);
  prepareMemoryDisclosure(first,f.access,"driver");deliverMemoryDisclosure(first.bundleId,f.access,"session-one");linkMemoryDisclosureOutput(first.bundleId,"answer-one");
  database().prepare("UPDATE memory_records SET owner_pinned=0 WHERE id='original'").run();
  record("derived",scope,"Paraphrased instruction",true,"answer-one");
  const second=await buildMemoryBundle("query",f.access,empty);
  prepareMemoryDisclosure(second,f.access,"driver");deliverMemoryDisclosure(second.bundleId,f.access,"session-two");linkMemoryDisclosureOutput(second.bundleId,"answer-two");
  database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(first.bundleId);
  expect(filterMemoryReplay("private",[{id:"user"},{id:"answer-one"},{id:"answer-two"},{id:"independent"}],f.access)).toEqual([{id:"user"},{id:"independent"}]);
  expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(second.bundleId)?.state).toBe("revoked");
});

it("links later continuation outputs to prior disclosures even without repeated recall",async()=>{
  const f=fixture();record("original",ensureScope("bot","bot"),"Earlier disclosed fact");
  const first=await buildMemoryBundle("query",f.access,empty);
  prepareMemoryDisclosure(first,f.access,"driver");deliverMemoryDisclosure(first.bundleId,f.access,"same-session");
  database().prepare("UPDATE memory_records SET owner_pinned=0 WHERE id='original'").run();
  const second=await buildMemoryBundle("query",f.access,empty);
  expect(second.recordVersions).toEqual([]);
  prepareMemoryDisclosure(second,f.access,"driver");deliverMemoryDisclosure(second.bundleId,f.access,"same-session");
  linkMemoryDisclosureOutput(second.bundleId,"later-answer");
  database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(first.bundleId);
  expect(filterMemoryReplay("private",[{id:"user"},{id:"later-answer"}],f.access)).toEqual([{id:"user"}]);
});

it("ignores unrelated workspace disclosures when filtering a bounded replay",async()=>{
  const f=fixture();record("pin",ensureScope("bot","bot"),"Allowed decision");
  const bundle=await buildMemoryBundle("query",f.access,empty);
  prepareMemoryDisclosure(bundle,f.access,"driver");deliverMemoryDisclosure(bundle.bundleId,f.access,"session");linkMemoryDisclosureOutput(bundle.bundleId,"answer");
  database().exec(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<2049)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'unrelated-'||value,'unrelated-thread','driver','[]','[]','["unrelated-output"]',0,0,0,'revoked',1 FROM n`);
  expect(filterMemoryReplay("private",[{id:"user"},{id:"answer"}],f.access)).toEqual([{id:"user"},{id:"answer"}]);
});

it("blocks replay beyond its explicit receipt limit instead of bypassing lineage",()=>{
  const f=fixture();
  database().exec(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<2049)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'old-'||value,'private','driver','[]','[]','["answer"]',0,0,0,'revoked',1 FROM n`);
  expect(()=>filterMemoryReplay("private",[{id:"user"},{id:"answer"}],f.access)).toThrow("MEMORY_REPLAY_LIMIT");
});
