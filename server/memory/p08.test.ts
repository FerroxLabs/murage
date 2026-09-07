import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database, closeDatabase } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { writeSectionContext } from "../section-context.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { memoryOwnerRoute, memoryOwnerStatus } from "./settings.ts";
import { previewMemoryImport, commitMemoryImport } from "./import.ts";
import { captureSource, captureBranchChange } from "./capture.ts";
import { forgetMemory } from "./forget.ts";

const roster={bots:[{id:"a",threadId:"thread-a",section:"Team"},{id:"b",threadId:"thread-b"}],groups:[{id:"room",threadId:"room-thread",memberIds:["a","b"]}]};
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);});
const owner=()=>ownerMemoryTicket();
function notebook(id="a",text="Owner prefers carefully verified backups."){const root=ensureWorkspace(id);writeFileSync(join(root,"MEMORY.md"),text);return root;}
const action=(body:unknown,ticket=owner())=>memoryOwnerRoute("/api/memory/action",body,ticket,roster);

it("requires desktop-issued owner authority and rejects forged action fields",async()=>{
  expect(()=>memoryOwnerStatus({},roster)).toThrow("MEMORY_OWNER_REQUIRED");
  await expect(action({action:"configure",mode:"active"},{})).rejects.toThrow("MEMORY_OWNER_REQUIRED");
  await expect(action({action:"configure",mode:"active",scopeId:"forged"})).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
  expect(memoryOwnerStatus(owner(),roster).model.state).toBe("missing");
  await expect(action({action:"model-download",confirm:false})).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
});

it("imports reviewed notebook bytes privately with source provenance and idempotent retry",async()=>{
  const root=notebook(),ticket=owner();
  const preview=previewMemoryImport(ticket,[{kind:"bot",botId:"a"}],roster);
  const result=commitMemoryImport(ticket,preview.previewId,roster);
  expect(result.imported).toBe(1);expect(result.originals).toBe("preserved");
  expect(commitMemoryImport(ticket,preview.previewId,roster).skipped).toBe(1);
  const stored=database().prepare("SELECT * FROM memory_records").get()!;
  expect(stored.scope_id).toBe(ensureScope("bot","a"));expect(stored.assertion).toBe("unverified-import");expect(stored.owner_pinned).toBe(0);
  const inspected=await action({action:"inspect",id:String(stored.id),version:1}) as {evidence:Array<{path:string;hash:string;text:string}>};
  expect(inspected.evidence[0].path).toBe(join(root,"MEMORY.md"));expect(inspected.evidence[0].hash).toBe(preview.items[0].hash);
  expect(readFileSync(join(root,"MEMORY.md"),"utf8")).toBe(preview.items[0].text);
});

it("rejects symlink topics, directory links and caller-supplied arbitrary paths",async()=>{
  const root=notebook();notebook("b","OTHER_BOT_PRIVATE");
  symlinkSync(join(DATA_DIR,"workspaces","b","MEMORY.md"),join(root,"memory","linked.md"));
  expect(()=>previewMemoryImport(owner(),[{kind:"bot",botId:"a",topic:"linked.md"}],roster)).toThrow("MEMORY_IMPORT_SYMLINK");
  expect(()=>previewMemoryImport(owner(),[{kind:"bot",botId:"a",topic:"../../MEMORY.md"}],roster)).toThrow("MEMORY_IMPORT_TOPIC_DENIED");
  await expect(action({action:"import-preview",selections:[{kind:"bot",botId:"a",path:"/etc/passwd"}]})).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
});

it("rejects file changes after preview and imports explicitly selected team briefs",()=>{
  const root=notebook(),ticket=owner(),preview=previewMemoryImport(ticket,[{kind:"bot",botId:"a"}],roster);
  writeFileSync(join(root,"MEMORY.md"),"Unreviewed replacement");
  expect(()=>commitMemoryImport(ticket,preview.previewId,roster)).toThrow("MEMORY_IMPORT_CHANGED");
  expect(database().prepare("SELECT count(*) AS n FROM memory_sources").get()?.n).toBe(0);
  writeSectionContext("Team","Team-specific brief");
  const team=previewMemoryImport(ticket,[{kind:"section",section:"Team"}],roster);commitMemoryImport(ticket,team.previewId,roster);
  expect(database().prepare("SELECT scope_id FROM memory_records").get()?.scope_id).toBe(ensureScope("team","Team"));
});

it("rolls back a multi-file import when a later source publication fails",()=>{
  const root=notebook();writeFileSync(join(root,"memory","second.md"),"Second note");
  const ticket=owner(),preview=previewMemoryImport(ticket,[{kind:"bot",botId:"a"},{kind:"bot",botId:"a",topic:"second.md"}],roster);
  const second=preview.items[1],id="legacy:"+createHash("sha256").update(JSON.stringify([second.scopeId,second.path])).digest("hex");
  database().exec(`CREATE TEMP TRIGGER reject_second BEFORE INSERT ON memory_sources WHEN NEW.id='${id}' BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END`);
  expect(()=>commitMemoryImport(ticket,preview.previewId,roster)).toThrow("fixture publication failure");
  expect(database().prepare("SELECT count(*) AS n FROM memory_sources").get()?.n).toBe(0);
  expect(database().prepare("SELECT count(*) AS n FROM memory_records").get()?.n).toBe(0);
  database().exec("DROP TRIGGER reject_second");expect(commitMemoryImport(ticket,preview.previewId,roster).imported).toBe(2);
});

it("honors forgotten-source tombstones while preserving and refusing reimport of the original",()=>{
  const root=notebook(),ticket=owner(),preview=previewMemoryImport(ticket,[{kind:"bot",botId:"a"}],roster);
  commitMemoryImport(ticket,preview.previewId,roster);
  const source=String(database().prepare("SELECT id FROM memory_sources").get()!.id);forgetMemory(ticket,{kind:"source",id:source});
  const again=previewMemoryImport(ticket,[{kind:"bot",botId:"a"}],roster);
  expect(()=>commitMemoryImport(ticket,again.previewId,roster)).toThrow("MEMORY_IMPORT_FORGOTTEN");
  expect(readFileSync(join(root,"MEMORY.md"),"utf8")).toBe(preview.items[0].text);
});

it("exposes correction, pinning and explicit shared projections without copying private source text",async()=>{
  notebook();const ticket=owner(),preview=previewMemoryImport(ticket,[{kind:"bot",botId:"a"}],roster),imported=commitMemoryImport(ticket,preview.previewId,roster),id=imported.recordIds[0];
  await action({action:"pin",id,version:1,pinned:true},ticket);
  const corrected=await action({action:"correct",id,version:1,text:"Owner-reviewed replacement"},ticket) as {record:{version:number}};
  expect(corrected.record.version).toBe(2);
  const shared=await action({action:"promote",id,version:2,scopeId:ensureScope("room","room")},ticket) as {record:{id:string;scopeId:string}};
  expect(shared.record.scopeId).toBe(ensureScope("room","room"));
  expect(database().prepare("SELECT count(*) AS n FROM memory_evidence WHERE record_id=?").get(shared.record.id)?.n).toBe(0);
  const listed=await action({action:"list",botId:"b"},ticket) as {records:unknown[]};expect(listed.records).toEqual([]);
});

it("persists mode and owner exclusions with policy revocation and prevents branch reactivation",async()=>{
  const ticket=owner();await action({action:"configure",mode:"active"},ticket);
  const db=database(),before=Number(db.prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision);
  captureSource(db,{id:"source",threadId:"thread-a",messageId:"message",kind:"text",speaker:"owner",outcome:"recorded",text:"Excluded private text"});
  await action({action:"configure",mode:"paused",excludedThreadIds:["thread-a"]},ticket);
  expect(Number(db.prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision)).toBeGreaterThan(before);
  expect(db.prepare("SELECT state FROM memory_sources WHERE id='source'").get()?.state).toBe("retired");
  captureSource(db,{id:"new-source",threadId:"thread-a",kind:"text",speaker:"owner",outcome:"recorded",text:"Do not capture"});
  captureBranchChange(db,"thread-a",null);
  expect(db.prepare("SELECT count(*) AS n FROM memory_sources").get()?.n).toBe(1);
  expect(db.prepare("SELECT state FROM memory_sources WHERE id='source'").get()?.state).toBe("retired");
  await expect(action({action:"configure",extractorInstanceId:"unqualified-cli"},ticket)).rejects.toThrow("MEMORY_EXTRACTOR_UNAVAILABLE");
});

it("rejects a corrupt downloaded asset before declaring the pinned local model ready",async()=>{
  const fetcher=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(new Uint8Array(673),{status:200}));
  try{
    await action({action:"model-download",confirm:true});
    for(let i=0;i<100&&memoryOwnerStatus(owner(),roster).model.state==="downloading";i++)await new Promise(resolve=>setTimeout(resolve,5));
    const status=memoryOwnerStatus(owner(),roster);
    expect(status.model.state).toBe("failed");expect(status.model.error).toBe("MEMORY_MODEL_HASH_MISMATCH");expect(fetcher).toHaveBeenCalledTimes(1);
  }finally{fetcher.mockRestore();}
});
