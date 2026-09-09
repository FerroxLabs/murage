import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database, closeDatabase, transaction } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { memoryOwnerRoute, memoryOwnerStatus } from "./settings.ts";
import { MemoryIndex } from "./index.ts";
import type { MemoryRecord } from "../../shared/memory.ts";

const roster={bots:[{id:"a",threadId:"ta"},{id:"b",threadId:"tb"}],groups:[]};
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);});
const action=(body:unknown)=>memoryOwnerRoute("/api/memory/action",body,ownerMemoryTicket(),roster) as Promise<{records:MemoryRecord[];nextCursor?:string;searchMode:string}>;

it("pages 3000 records with indexed keyword search, Important and Recent without crossing bot audiences",async()=>{
  const scopeId=ensureScope("bot","a"),other=ensureScope("bot","b");
  const rows=Array.from({length:3000},(_,n)=>({id:`row-${String(n).padStart(4,"0")}`,version:1,scopeId,text:n===1234?"orchidneedle durable note":`Durable note ${n}`,deleted:false}));
  transaction(db=>{
    for(const [n,row] of rows.entries()){
      db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',?,?,NULL,NULL,?)").run(row.id,scopeId,row.text,n===10?1:0,n,n);
      db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'indexed','unavailable',NULL)").run(row.id);
    }
    db.prepare("INSERT INTO memory_records VALUES('other',1,?,'fact','PRIVATE_OTHER','owner-statement','active',0,1,NULL,NULL,1)").run(other);
  });
  const index=new MemoryIndex(join(DATA_DIR,"memory-index.db"));index.upsert(rows);index.close();
  const first=await action({action:"list",botId:"a",view:"recent"});
  expect(first.records).toHaveLength(50);expect(first.records[0].id).toBe("row-2999");expect(first.nextCursor).toBeTruthy();
  const next=await action({action:"list",botId:"a",view:"recent",cursor:first.nextCursor});
  expect(next.records).toHaveLength(50);expect(next.records[0].id).toBe("row-2949");
  expect(new Set([...first.records,...next.records].map(row=>row.id)).size).toBe(100);
  const found=await action({action:"list",botId:"a",query:"orchidneedle"});
  expect(found.searchMode).toBe("indexed");expect(found.records.map(row=>row.id)).toEqual(["row-1234"]);
  const important=await action({action:"list",botId:"a",view:"important"});
  expect(important.records.map(row=>row.id)).toEqual(["row-0010"]);
  await expect(action({action:"list",botId:"a",scopeId:other})).rejects.toThrow("MEMORY_SCOPE_DENIED");
  expect((await action({action:"list",botId:"b"})).records.map(row=>row.id)).toEqual(["other"]);
});

it("shows candidate search and an explicit source-text fallback before projection",async()=>{
  const scope=ensureScope("bot","a");
  database().prepare("INSERT INTO memory_records VALUES('candidate',1,?,'fact','reviewneedle','assistant-inference','candidate',0,1,NULL,NULL,1)").run(scope);
  const found=await action({action:"list",botId:"a",view:"review",query:"reviewneedle"});
  expect(found).toMatchObject({searchMode:"source-text",searchNotice:expect.stringContaining("catching up")});
  expect(found.records.map(row=>row.id)).toEqual(["candidate"]);
  expect((await action({action:"list",botId:"a",view:"recent"})).records).toEqual([]);
});

it("requires an explicit owner action to enable Off and import private notes",async()=>{
  database().exec("UPDATE memory_meta SET mode='off'");
  writeFileSync(join(ensureWorkspace("a"),"MEMORY.md"),"Owner enabled notebook");
  const ticket=ownerMemoryTicket();
  const result=await memoryOwnerRoute("/api/memory/action",{action:"enable-and-import"},ticket,roster);
  expect(result).toMatchObject({imported:1,status:{mode:"active",configuration:{extractorInstanceId:null}}});
  expect(memoryOwnerStatus(ticket,roster).mode).toBe("active");
  await expect(memoryOwnerRoute("/api/memory/action",{action:"enable-and-import"},{},roster)).rejects.toThrow("MEMORY_OWNER_REQUIRED");
});

it("pages source conflicts separately and keeps their bot boundary",async()=>{
  const scope=ensureScope("bot","a"),db=database();
  for(let n=0;n<55;n++)db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','notebook-link',0,'granted',?)").run(`link-${String(n).padStart(2,"0")}`,scope,JSON.stringify({selection:{kind:"bot",botId:"a",topic:`${n}.md`},status:"needs-review",error:"MEMORY_IMPORT_REVIEW_CONFLICT"}));
  const route=(body:unknown)=>memoryOwnerRoute("/api/memory/action",body,ownerMemoryTicket(),roster) as Promise<{links:unknown[];nextCursor?:string}>;
  const first=await route({action:"import-review-list",botId:"a"});expect(first.links).toHaveLength(50);
  expect((await route({action:"import-review-list",botId:"a",cursor:first.nextCursor})).links).toHaveLength(5);
  expect((await route({action:"import-review-list",botId:"b"})).links).toEqual([]);
});
