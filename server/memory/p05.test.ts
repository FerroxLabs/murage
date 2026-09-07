import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { mergeDestinationMemoryDeletions, pauseRestoredMemory } from "./restore.ts";
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
