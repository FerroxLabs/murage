import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { beforeEach, expect, it, vi } from "vitest";
import { database, transaction } from "../database.ts";
import { THREAD, accessFor, captureAndPublish, freshDataDir } from "./testing/recall-fixture.ts";
import { captureThreadDeletion } from "./capture.ts";
import { INLINE_REVOCATION } from "./memory-revocation.ts";
import { assertMemoryAccess, inMemoryAccessPass, reconcileMemoryRoster } from "./policy.ts";
import { clearMemorySearchCache, searchMemory } from "./search.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { memoryCandidateId, saveGroundedMemory, saveMemoryCandidate } from "./authority.ts";
import { heldRefsCurrent, learningGate, sampleLearningFence } from "./learning-send.ts";
import type { TextOnlyExtractor } from "./extract.ts";

beforeEach(() => freshDataDir("active"));
function fixture() {
  const roster={bots:[{id:"bot",threadId:THREAD,tasks:[{threadId:"B"}]}],groups:[]};
  reconcileMemoryRoster(roster);
  const text="I prefer concise answers.", {sourceId}=captureAndPublish(text);
  database().prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.origin.kind','attended') WHERE source_id=?").run(sourceId);
  const evidence={sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(text)};
  return {text,evidence,deletedAccess:accessFor(roster).access,access:accessFor(roster,"bot","B").access};
}
function deleteA() {
  const ms=INLINE_REVOCATION.ms;
  try { INLINE_REVOCATION.ms=0; transaction(db=>captureThreadDeletion(db,THREAD)); }
  finally { INLINE_REVOCATION.ms=ms; }
}
it("owner search discards already hydrated A text when deletion occurs before final revalidation",async()=>{
  const f=fixture(),row=database().prepare("SELECT id,version FROM memory_records LIMIT 1").get()!;
  const hits=[{id:String(row.id),version:Number(row.version),score:1}];
  const options={allowance:LineageAllowance.tool(1_000_000_000),lexical:()=>({hits:[],more:false})};
  const before=await searchMemory("concise",f.access,{async search(){return {hits,vectorRows:0};}},options);
  expect(before.hits.map(hit=>hit.text)).toContain(f.text);
  clearMemorySearchCache();
  let deleted=false;
  const result=await searchMemory("concise",f.access,{async search(){return {
    hits:[{id:String(row.id),version:Number(row.version),score:1}],vectorRows:0,
    get unvectored(){if(!deleted){deleted=true;deleteA();}return undefined;},
  };}},options);
  expect(deleted).toBe(true);
  expect(result.hits).toEqual([]);
});
it("continuing B cannot admit or send evidence from deleted A while cleanup is pending",async()=>{
  const f=fixture();deleteA();
  expect(database().prepare("SELECT state FROM memory_sources WHERE id=?").get(f.evidence.sourceId)?.state).toBe("active");
  expect(()=>saveMemoryCandidate("Prefers brief replies.",[f.evidence],"late",f.access)).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
  await expect(saveGroundedMemory("Prefers brief replies.",[f.evidence],"late-ground",f.access,"owner-statement",null)).rejects.toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
});
it("grounding send refuses a deleted source even when its fence was sampled after deletion",()=>{
  const f=fixture();deleteA();
  const send=vi.fn();
  const gate=learningGate("grounding",sampleLearningFence(),{sources:[{id:f.evidence.sourceId,revision:1}]});
  expect(()=>gate.send(send)).toThrow("MEMORY_SEND_FENCED");expect(send).not.toHaveBeenCalled();
});
it("pending source lineage refuses admission and held-source sends",()=>{
  const f=fixture(),db=database();
  db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,revoke_id,since_lsn) SELECT scope_id,'pending-review',0 FROM memory_sources WHERE id=?").run(f.evidence.sourceId);
  expect(()=>saveMemoryCandidate("Brief replies.",[f.evidence],"pending",f.access)).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
  expect(heldRefsCurrent(db,{sources:[{id:f.evidence.sourceId,revision:1}]})).toBe(false);
});
it("deletion during grounding fences publication after the evaluator awaits",async()=>{
  const f=fixture();let called=false;
  const extractor:TextOnlyExtractor=async()=>"[]";
  extractor.ground=async()=>{called=true;deleteA();return '{"supported":true}';};
  await expect(saveGroundedMemory("Prefers brief replies.",[f.evidence],"inflight",f.access,"owner-statement",extractor)).rejects.toThrow("MEMORY_CONSOLIDATION_REVOKED");
  expect(called).toBe(true);
  expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(memoryCandidateId("B","inflight"))?.state).toBe("candidate");
});

it("a synchronous access pass checks a thread once and observes deletion within the same pass",()=>{
  const f=fixture(),db=database(),spy=vi.spyOn(db,"prepare");
  try {
    inMemoryAccessPass(()=>{
      for(let i=0;i<100;i++)assertMemoryAccess(f.deletedAccess);
      expect(spy.mock.calls.filter(([sql])=>sql==="SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?")).toHaveLength(1);
      deleteA();
      expect(()=>assertMemoryAccess(f.deletedAccess)).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(()=>assertMemoryAccess(f.access)).not.toThrow();
    });
  }finally{spy.mockRestore();}
});

useOutsideStoreFixture();
