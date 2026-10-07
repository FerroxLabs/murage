// A record-level change (approve, correct, archive, pin, learning undo) ended
// every warm session on the machine: each writer revoked every disclosure and
// bumped policy_revision, which every receipt is compared against. Now it ends
// only the sessions that were shown the record; policy and identity changes,
// and forgetting, still end what they always did.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { buildMemoryBundle, hydrateMemoryRecord } from "./bundle.ts";
import { MemoryDispatchReceipt, memoryContinuationChanged } from "./dispatch.ts";
import { bindMemoryDisclosureSession, continuationMemoryRevoked, deliverMemoryDisclosure, noteMemoryLookup, prepareMemoryDisclosure } from "./disclosures.ts";
import { approveMemory, correctMemory, ownerMemoryTicket, pinMemory, renameMemoryTeam } from "./authority.ts";
import { archiveMemoryRecord } from "./retention.ts";
import { forgetMemory } from "./forget.ts";
import type { MemorySearchBridge } from "./search.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR,{recursive:true,force:true}); mkdirSync(DATA_DIR,{recursive:true}); });
const empty: MemorySearchBridge = {search:async()=>({hits:[],vectorRows:0})};

function record(id:string,scopeId:string,text:string,opts:{pinned?:boolean;state?:string;source?:boolean}={}) {
  const db=database();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement',?,?,1,NULL,NULL,1)").run(id,scopeId,text,opts.state??"active",opts.pinned?1:0);
  if(opts.source){
    db.prepare("INSERT INTO memory_sources VALUES(?,?,'private',?,NULL,1,'hash','text','owner','settled',NULL,'active')").run(`source-${id}`,scopeId,`msg-${id}`);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'hash',?,1)").run(`source-${id}`,JSON.stringify({text}));
    db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,?)").run(id,`source-${id}`,Buffer.byteLength(text));
  }
}

/** One warm session that was shown the pinned record `shown`, and records it
 * was never shown: `other` (active, unpinned) and `pending` (a candidate). */
async function world() {
  const roster: MemoryRoster = {bots:[{id:"bot",threadId:"private",section:"team-a"}],groups:[]};
  reconcileMemoryRoster(roster);
  const registry=new InternalCapabilities();
  const access=()=>{
    const generation=registry.begin("bot","private");
    const token=registry.mint({botId:"bot",threadId:"private",generation,kind:"memory",depth:100,skillAuthoring:false});
    return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  };
  const scope=ensureScope("bot","bot");
  record("shown",scope,"The owner keeps backups on Fridays",{pinned:true,source:true});
  record("other",scope,"The owner likes tea");
  record("pending",scope,"The owner plays chess",{state:"candidate"});
  const a=access();
  const bundle=await buildMemoryBundle("anything",a,empty);
  expect(bundle.recordVersions.map(r=>r.id)).toEqual(["shown"]);
  prepareMemoryDisclosure(bundle,a,"claude");
  bindMemoryDisclosureSession(bundle.bundleId,"session-1");
  deliverMemoryDisclosure(bundle.bundleId,a);
  const state=()=>String(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)!.state);
  const revoked=()=>({result:continuationMemoryRevoked("private","claude","session-1",access())});
  return {state,revoked,ticket:ownerMemoryTicket(),access,frame:bundle.bundleId};
}

const policy=()=>Number(database().prepare("SELECT policy_revision FROM memory_meta WHERE id=1").get()!.policy_revision);

it("an unrelated record approved, corrected, archived or pinned leaves a session that was never shown it warm",async()=>{
  const w=await world();
  const before=policy();
  approveMemory(w.ticket,"pending",1);
  correctMemory(w.ticket,"other",1,"The owner likes green tea");
  archiveMemoryRecord(w.ticket,"other",2);
  pinMemory(w.ticket,"pending",1,true);
  expect(policy()).toBe(before);
  expect(w.state()).toBe("delivered");
  expect(w.revoked()).toEqual({result:false});
});

it.each([
  ["correct",(t:object)=>correctMemory(t,"shown",1,"The owner keeps backups on Mondays")],
  ["archive",(t:object)=>{ database().prepare("UPDATE memory_records SET owner_pinned=0 WHERE id='shown'").run(); archiveMemoryRecord(t,"shown",1); }],
  ["pin",(t:object)=>pinMemory(t,"shown",1,false)],
])("the same change (%s) to the record the session WAS shown revokes it",async(_name,change)=>{
  const w=await world();
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  change(w.ticket);
  expect(w.state()).toBe("revoked");
  expect(warn.mock.calls.flat().some(line=>/^memory receipts revoked scope=records cause=\S+ count=1$/.test(String(line)))).toBe(true);
  expect(w.revoked().result).toBe(true);
  warn.mockRestore();
});

it("a forgotten source still revokes the session that cited it",async()=>{
  const w=await world();
  forgetMemory(w.ticket,{kind:"source",id:"source-shown"});
  expect(w.state()).toBe("revoked");
  expect(w.revoked().result).toBe(true);
});

it("a global change (team rename) still revokes everything and logs it",async()=>{
  const w=await world();
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  const before=policy();
  renameMemoryTeam(w.ticket,"team-a","team-b");
  expect(policy()).toBe(before+1);
  expect(w.state()).toBe("revoked");
  expect(warn.mock.calls.flat()).toContain("memory receipts revoked scope=global cause=team-rename count=1");
  expect(w.revoked().result).toBe(true);
  warn.mockRestore();
});

// Fix round 2, hole 1: a revoke that lands while the next turn's bundle search
// awaits, and hits only a :lookup companion of the session, ends the session.
it("a revoke during the bundle search that hits only the session's lookup receipt ends the session (reset, never resume)",async()=>{
  const w=await world();
  expect(noteMemoryLookup(w.frame,`${w.frame}:lookup`,[{id:"other",version:1,evidence:[]}])).toBe(true);
  const a=w.access();
  const next=await buildMemoryBundle("anything",a,empty);
  // same frame as before: only the latest frame was compared
  expect(memoryContinuationChanged(next,"private","claude","session-1")).toBe(false);
  archiveMemoryRecord(w.ticket,"other",1);
  expect(w.state()).toBe("delivered");
  expect(memoryContinuationChanged(next,"private","claude","session-1")).toBe(true);
});
it("a revoke between the dispatch checks and acceptance refuses acceptance into the resumed session",async()=>{
  const w=await world();
  expect(noteMemoryLookup(w.frame,`${w.frame}:lookup`,[{id:"other",version:1,evidence:[]}])).toBe(true);
  const a=w.access();
  const receipt=new MemoryDispatchReceipt(await buildMemoryBundle("anything",a,empty),a,"claude");
  receipt.resumes("session-1");
  receipt.assertCurrent();
  receipt.sessionStarted("session-1");
  archiveMemoryRecord(w.ticket,"other",1);
  expect(()=>receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(w.revoked().result).toBe(true);
});

// Fix round 2, hole 2: a record derived from one the owner then corrected
// (a reveal resting on an edited canon) never gets a fresh receipt.
it("a derived record whose parent is corrected while the search waits cannot be hydrated or receipted",async()=>{
  const w=await world();
  const db=database(),scope=String(db.prepare("SELECT scope_id FROM memory_records WHERE id='shown'").get()!.scope_id);
  record("derived",scope,"Backups are on Fridays, so plan around it",{pinned:true});
  db.prepare("INSERT INTO memory_derivations VALUES('other',1,'derived',1)").run();
  const a=w.access();
  const bundle=await buildMemoryBundle("anything",a,empty);
  expect(bundle.recordVersions.map(r=>r.id)).toContain("derived");
  correctMemory(w.ticket,"other",1,"The owner likes green tea");
  expect(()=>hydrateMemoryRecord("derived",1,w.access())).toThrow("MEMORY_RECORD_UNAVAILABLE");
  expect(()=>prepareMemoryDisclosure(bundle,a,"claude")).toThrow();
  expect(db.prepare("SELECT 1 FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)).toBeUndefined();
});

// Fix round 2, hole 3: a session shown only the source a record was extracted
// from (a quoted reply, working context), in another thread, ends with it.
it("archiving or correcting a record ends receipts that carried only its evidence source, in any thread",async()=>{
  for(const change of ["archive","correct"] as const){
    closeDatabase(); rmSync(DATA_DIR,{recursive:true,force:true}); mkdirSync(DATA_DIR,{recursive:true});
    const w=await world();
    const db=database(),meta=db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('elsewhere:lookup','elsewhere','claude','session-9','[]',?,?,?,0,'delivered',1)")
      .run(JSON.stringify([{id:"source-shown",revision:1}]),meta.policy_revision,meta.deletion_epoch);
    db.prepare("UPDATE memory_records SET owner_pinned=0 WHERE id='shown'").run();
    if(change==="archive")archiveMemoryRecord(w.ticket,"shown",1); else correctMemory(w.ticket,"shown",1,"The owner keeps backups on Mondays");
    expect(String(db.prepare("SELECT state FROM memory_disclosures WHERE bundle_id='elsewhere:lookup'").get()!.state)).toBe("revoked");
  }
});
