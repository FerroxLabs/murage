import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backup, DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, updateMessage, deleteThread } from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { ensureScope } from "./policy.ts";
import { createGepaCallLedger } from "./gepa-ledger.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { mergeDestinationMemoryDeletions, mergeOriginalMemoryDeletions, pauseRestoredMemory } from "./restore.ts";
import { inspectInstallationDatabase } from "../installation-database-snapshot.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});setMemoryMode("capture");});
function seed() {
  appendMessage("thread",{id:"source",at:1,role:"user",kind:"text",text:"private retained source"});
  const work=claimMemoryJob("worker")!;publishMemoryWork(work,"worker",captureWork(work));
  return {work,id:String(database().prepare("SELECT id FROM memory_records").get()!.id)};
}
it("forgets derivatives, revokes disclosures and excludes future publications",()=>{
  const {work,id}=seed();const db=database();
  db.prepare("INSERT INTO memory_records SELECT 'derived',1,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at FROM memory_records WHERE id=?").run(id);
  db.prepare("INSERT INTO memory_derivations VALUES(?,1,'derived',1)").run(id);
  db.prepare("INSERT INTO memory_disclosures VALUES('bundle','thread','driver','native',?,'[]','[]',0,0,20,'delivered',1)").run(JSON.stringify([{id:"derived",version:1}]));
  expect(forgetMemory(ownerMemoryTicket(),{kind:"source",id:work.sourceId})).toMatchObject({status:"excluded",derivedCleanup:"pending"});
  expect(db.prepare("SELECT count(*) AS n FROM memory_records WHERE state='deleted'").get()?.n).toBe(2);
  expect(db.prepare("SELECT state FROM memory_disclosures").get()?.state).toBe("revoked");
});
it("does not resurrect deleted records when an old backup is restored",async()=>{
  const {work}=seed();const root=mkdtempSync(join(tmpdir(),"murage-p05-restore-"));
  try {
    const candidate=join(root,"candidate");mkdirSync(candidate);
    await backup(database(),join(candidate,"messages.db"));
    forgetMemory(ownerMemoryTicket(),{kind:"source",id:work.sourceId});closeDatabase();
    const receipt=mergeDestinationMemoryDeletions(DATA_DIR,candidate);
    expect(receipt.merged).toBeGreaterThan(0);
    const restored=new DatabaseSync(join(candidate,"messages.db"));
    try {
      expect(()=>inspectInstallationDatabase(restored)).not.toThrow();
      expect(restored.prepare("SELECT mode FROM memory_meta").get()?.mode).toBe("paused");
      expect(restored.prepare("SELECT state FROM memory_records").get()?.state).toBe("deleted");
    } finally{restored.close();}
  } finally{rmSync(root,{recursive:true,force:true});}
});
it("specific revision forgetting preserves the corrected current source",()=>{
  const {work,id}=seed();
  updateMessage("thread",{id:"source",at:2,role:"user",kind:"text",text:"corrected current source"});
  const next=claimMemoryJob("worker")!;publishMemoryWork(next,"worker",captureWork(next));
  forgetMemory(ownerMemoryTicket(),{kind:"source",id:work.sourceId,revision:1});
  expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(id)?.state).toBe("deleted");
  expect(database().prepare("SELECT state FROM memory_sources").get()?.state).toBe("active");
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='active'").get()?.n).toBe(1);
});
it("pauses leased work during restore and never preserves native continuation",()=>{
  appendMessage("thread",{id:"source",at:1,role:"user",kind:"text",text:"queued"});
  const work=claimMemoryJob("worker")!;
  database().exec("BEGIN IMMEDIATE");pauseRestoredMemory(database());database().exec("COMMIT");
  expect(database().prepare("SELECT status,lease_owner FROM memory_jobs").get()).toMatchObject({status:"pending",lease_owner:null});
  expect(()=>publishMemoryWork(work,"worker",captureWork(work))).toThrow("STALE_MEMORY_LEASE");
});
it("rejects invalid memory JSON shape in an otherwise valid archive schema",()=>{
  seed();database().exec("UPDATE memory_scopes SET audience='42'");
  expect(()=>inspectInstallationDatabase(database())).toThrow("DATABASE_SCHEMA_UNSUPPORTED");
});
it("thread deletion also invalidates derived records",()=>{
  seed();deleteThread("thread");
  expect(database().prepare("SELECT state FROM memory_records").get()?.state).toBe("deleted");
});
it("record forgetting excludes supporting source expansion but not another private scope",()=>{
  const {id}=seed();forgetMemory(ownerMemoryTicket(),{kind:"record",id});
  expect(database().prepare("SELECT state FROM memory_sources WHERE thread_id='thread'").get()?.state).toBe("deleted");
  appendMessage("other",{id:"other",at:1,role:"user",kind:"text",text:"private retained source"});
  expect(database().prepare("SELECT state FROM memory_sources WHERE thread_id='other'").get()?.state).toBe("active");
});

it("Q12 separate paused restore carries current owner deletions without changing the original or pre-forget archive",async()=>{
  const {work,id}=seed(),db=database(),root=mkdtempSync(join(tmpdir(),"murage-q12-deletion-join-"));
  const archive=join(root,"before-forget.db"),candidate=join(root,"separate-restored"),canary="Q12_OPTIMIZER_COPY_CANARY",sharedScope=ensureScope("room","q12-shared-room");
  const hash=(file:string)=>createHash("sha256").update(readFileSync(file)).digest("hex");
  try{
    db.prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=?").run(id);
    db.prepare("INSERT INTO memory_records SELECT 'q12-shared-derived',1,?,kind,text,assertion,state,0,valid_from,valid_to,supersedes_id,created_at FROM memory_records WHERE id=?").run(sharedScope,id);
    db.prepare("INSERT INTO memory_derivations VALUES(?,1,'q12-shared-derived',1)").run(id);
    appendMessage("control-thread",{id:"control-source",at:2,role:"user",kind:"text",text:"Q12 unrelated control survives"});
    const controlWork=claimMemoryJob("worker")!;expect(controlWork.sourceId).not.toBe(work.sourceId);publishMemoryWork(controlWork,"worker",captureWork(controlWork));
    const control=db.prepare("SELECT r.* FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE e.source_id=?").get(controlWork.sourceId)!;
    const scopeId=String(db.prepare("SELECT scope_id FROM memory_records WHERE id=?").get(id)!.scope_id),evidence=[{kind:"source" as const,id:work.sourceId,revision:1}];
    const ledger=createGepaCallLedger({scopeId,jobId:"q12-forget",snapshotDigest:"a".repeat(64),evidence,maxMetricCalls:24,maxReflections:2,assertCurrent:()=>{}});
    ledger.lookupOrReserve("q12-forget:reflect:1","b".repeat(64),"reflect");ledger.complete("q12-forget:reflect:1","b".repeat(64),"```\n"+canary+"\n```");
    const review={evidence,snapshot:{evidence:[{...evidence[0],text:canary}]},receipt:{candidate:canary},status:"complete"};
    const independent={evidence:[],snapshot:{evidence:[]},receipt:{candidate:"Q12_KEEP_CONTROL"},status:"complete"};
    db.prepare("INSERT INTO memory_scope_bindings VALUES('procedure-review:q12',?,'system','procedure-review',1,'granted',?)").run(scopeId,JSON.stringify(review));
    db.prepare("INSERT INTO memory_scope_bindings VALUES('procedure-review:q12-control',?,'system','procedure-review',1,'granted',?)").run(scopeId,JSON.stringify(independent));
    for(const [bundle,records,sources] of [["q12-pin",[{id,version:1}],[]],["q12-derived",[{id:"q12-shared-derived",version:1}],[]],["q12-source",[],[{id:work.sourceId,revision:1}]]] as const){
      db.prepare("INSERT INTO memory_disclosures VALUES(?,'thread','driver','native',?,?,'[]',0,0,20,'delivered',1)").run(bundle,JSON.stringify(records),JSON.stringify(sources));
    }
    const sourceHash=db.prepare("SELECT content_hash FROM memory_sources WHERE id=?").get(work.sourceId)!.content_hash;
    await backup(db,archive);const archiveHash=hash(archive);
    const old=new DatabaseSync(archive,{readOnly:true});try{
      expect(old.prepare("SELECT owner_pinned,state FROM memory_records WHERE id=?").get(id)).toMatchObject({owner_pinned:1,state:"active"});
      expect(old.prepare("SELECT state FROM memory_records WHERE id='q12-shared-derived'").get()?.state).toBe("active");
      expect(old.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='delivered'").get()?.n).toBe(3);
      expect(old.prepare("SELECT count(*) AS n FROM memory_tombstones").get()?.n).toBe(0);
      expect(JSON.stringify(old.prepare("SELECT intent FROM memory_scope_bindings").all())).toContain(canary);
    }finally{old.close();}
    const forgotten=forgetMemory(ownerMemoryTicket(),{kind:"source",id:work.sourceId});expect(forgotten.status).toBe("excluded");
    const tombstones=db.prepare("SELECT * FROM memory_tombstones ORDER BY id").all(),meta=db.prepare("SELECT installation_id,deletion_epoch FROM memory_meta").get()!;
    expect(tombstones.some(row=>row.target_type==="source"&&row.target_id===work.sourceId)).toBe(true);expect(meta.deletion_epoch).toBe(forgotten.deletionEpoch);closeDatabase();
    const originalHash=hash(join(DATA_DIR,"messages.db"));
    mkdirSync(candidate);copyFileSync(archive,join(candidate,"messages.db"));
    const paused=new DatabaseSync(join(candidate,"messages.db"));try{
      paused.exec("BEGIN IMMEDIATE");expect(pauseRestoredMemory(paused)).toBe(true);paused.exec("COMMIT");
      expect(paused.prepare("SELECT mode FROM memory_meta").get()?.mode).toBe("paused");
      expect(paused.prepare("SELECT state FROM memory_records WHERE id=?").get(id)?.state).toBe("active");
      expect(JSON.stringify(paused.prepare("SELECT intent FROM memory_scope_bindings").all())).toContain(canary);
    }finally{paused.close();}
    const reviewFile=join(candidate,"restore-review.json"),candidateBeforeMerge=hash(join(candidate,"messages.db"));
    expect(()=>mergeOriginalMemoryDeletions(DATA_DIR,candidate)).toThrow("INVALID_RESTORE_MEMORY_REVIEW");
    const restoreReview={version:1,status:"review-required",policyVersion:1,snapshotId:"11111111-1111-4111-8111-111111111111",transactionId:"22222222-2222-4222-8222-222222222222",connectionProfileId:"33333333-3333-4333-8333-333333333333",archiveSha256:archiveHash,modifications:[{component:"memory",action:"Restored memory paused"}]};
    for(const invalid of [{...restoreReview,status:"reviewed"},{...restoreReview,modifications:null}]){writeFileSync(reviewFile,JSON.stringify(invalid));expect(()=>mergeOriginalMemoryDeletions(DATA_DIR,candidate)).toThrow("INVALID_RESTORE_MEMORY_REVIEW");expect(hash(join(candidate,"messages.db"))).toBe(candidateBeforeMerge);}
    writeFileSync(reviewFile,JSON.stringify(restoreReview));
    expect(mergeOriginalMemoryDeletions(DATA_DIR,candidate)).toEqual({merged:tombstones.length,history:"destination-ledger-preserved"});
    expect(JSON.parse(readFileSync(reviewFile,"utf8"))).toEqual({...restoreReview,modifications:[...restoreReview.modifications,{component:"messages.db",action:`Current original memory ledger: destination-ledger-preserved; ${tombstones.length} tombstones retained before selection`}]});
    const restored=new DatabaseSync(join(candidate,"messages.db"));try{
      expect(()=>inspectInstallationDatabase(restored)).not.toThrow();
      expect(restored.prepare("SELECT mode,installation_id,deletion_epoch FROM memory_meta").get()).toMatchObject({mode:"paused",...meta});
      expect(restored.prepare("SELECT * FROM memory_tombstones ORDER BY id").all()).toEqual(tombstones);
      expect(restored.prepare("SELECT state,content_hash FROM memory_sources WHERE id=?").get(work.sourceId)).toMatchObject({state:"deleted",content_hash:sourceHash});
      expect(restored.prepare("SELECT id FROM memory_records WHERE id IN (?,'q12-shared-derived') AND state='active'").all(id)).toEqual([]);
      expect(restored.prepare("SELECT state,owner_pinned FROM memory_records WHERE id IN (?,'q12-shared-derived')").all(id)).toEqual([{state:"deleted",owner_pinned:0},{state:"deleted",owner_pinned:0}]);
      expect(restored.prepare("SELECT state FROM memory_disclosures ORDER BY bundle_id").all()).toEqual([{state:"revoked"},{state:"revoked"},{state:"revoked"}]);
      const copies=restored.prepare("SELECT state,intent FROM memory_scope_bindings WHERE id!='procedure-review:q12-control'").all();expect(JSON.stringify(copies)).not.toContain(canary);
      expect(restored.prepare("SELECT state FROM memory_scope_bindings WHERE id LIKE 'gepa-call:%'").get()?.state).toBe("revoked");
      expect(JSON.parse(String(restored.prepare("SELECT intent FROM memory_scope_bindings WHERE id='procedure-review:q12'").get()!.intent))).toMatchObject({status:"cancelled",reason:"MEMORY_EVIDENCE_FORGOTTEN"});
      expect(restored.prepare("SELECT intent FROM memory_scope_bindings WHERE id='procedure-review:q12-control'").get()?.intent).toBe(JSON.stringify(independent));
      expect(restored.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(String(control.id),Number(control.version))).toEqual(control);
      expect(restored.prepare("SELECT state FROM memory_sources WHERE id=?").get(controlWork.sourceId)?.state).toBe("active");
      expect(restored.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='leased'").get()?.n).toBe(0);
    }finally{restored.close();}
    expect(hash(archive)).toBe(archiveHash);expect(hash(join(DATA_DIR,"messages.db"))).toBe(originalHash);
  }finally{closeDatabase();rmSync(root,{recursive:true,force:true});}
});
