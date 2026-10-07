// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { commitMemoryImport, memoryNotebookLinks, previewMemoryImport, stopTrackingMemoryNotebook, syncTrackedMemoryImports } from "./import.ts";

const roster={bots:[{id:"a",threadId:"thread-a"}],groups:[]};
beforeEach(()=>{
  closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
  reconcileMemoryRoster(roster);database().exec("UPDATE memory_meta SET mode='active'");
});
afterEach(()=>{closeDatabase();vi.useRealTimers();});
function seed(){
  const path=join(ensureWorkspace("a"),"MEMORY.md"),ticket=ownerMemoryTicket();
  writeFileSync(path,"Original notebook");
  const preview=previewMemoryImport(ticket,[{kind:"bot",botId:"a"}],roster);
  commitMemoryImport(ticket,preview.previewId,roster,true);
  return {path,ticket};
}
function poll(){vi.setSystemTime(Date.now()+10_001);syncTrackedMemoryImports(roster);}
function intent(){return String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='notebook-link'").get()!.intent);}
function changes(){return Number(database().prepare("SELECT total_changes() AS n").get()!.n);}

it("unchanged notebook checks write nothing and durable transitions still persist",()=>{
  const {path}=seed(),before=intent(),count=changes();
  for(let n=0;n<100;n++)poll();
  expect(changes()-count).toBe(0);
  expect(intent()).toBe(before);
  expect(memoryNotebookLinks()[0].checkedAt).toBe(Date.now());
  const text="Updated notebook context",hash=createHash("sha256").update(text).digest("hex");
  writeFileSync(path,text);poll();
  expect(JSON.parse(intent())).toMatchObject({hash,status:"current",checkedAt:Date.now()});
  expect(database().prepare("SELECT revision,content_hash FROM memory_sources").get()).toMatchObject({revision:2,content_hash:hash});
  expect(database().prepare("SELECT count(*) AS n FROM memory_source_versions").get()?.n).toBe(2);
  rmSync(path);poll();
  expect(JSON.parse(intent())).toMatchObject({status:"needs-review",error:"MEMORY_IMPORT_FILE_UNREADABLE"});
  const reviewed=intent(),reviewCount=changes();poll();
  expect(intent()).toBe(reviewed);expect(changes()).toBe(reviewCount);
  writeFileSync(path,text);poll();
  expect(JSON.parse(intent())).toMatchObject({hash,status:"current",checkedAt:Date.now()});
  expect(JSON.parse(intent()).error).toBeUndefined();
  expect(database().prepare("SELECT revision FROM memory_sources").get()?.revision).toBe(2);
});

it("rechecks a reopened database and clears checks for revoked links",()=>{
  const {path,ticket}=seed();syncTrackedMemoryImports(roster);
  writeFileSync(path,"Changed before restart");
  syncTrackedMemoryImports(roster);expect(database().prepare("SELECT revision FROM memory_sources").get()?.revision).toBe(1);
  closeDatabase();syncTrackedMemoryImports(roster);
  expect(database().prepare("SELECT revision FROM memory_sources").get()?.revision).toBe(2);
  stopTrackingMemoryNotebook(ticket,memoryNotebookLinks()[0].id);
  expect(memoryNotebookLinks()).toEqual([]);
});
