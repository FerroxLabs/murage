// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { searchMemory } from "./search.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";

const threadId="7f00a32e-17a4-426b-bdc6-910220ba66c9";
const roster={bots:[{id:"bot",threadId}],groups:[]};
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);setMemoryMode("capture");});
function complete(text:string,options:{id?:string;speaker?:string;kind?:string;outcome?:string;turnId?:string}={}){
  const id=options.id??`message:${threadId}:${randomUUID()}`;
  const messageId=randomUUID();storeAnchorMessage(database(),threadId,messageId,text,options.speaker&&options.speaker!=="owner"?"bot":"user");
  captureSource(database(),{id,threadId,messageId,origin:{kind:"attended"},kind:options.kind??"text",speaker:options.speaker??"owner",outcome:options.outcome??"recorded",turnId:options.turnId,text});
  const work=claimMemoryJob("p09-worker")!;if(!work)throw new Error("fixture did not claim a real capture job");
  publishMemoryWork(work,"p09-worker",captureWork(work));return {id,jobId:work.id,revision:work.revision};
}
function access(){const registry=new InternalCapabilities(),generation=registry.begin("bot",threadId),token=registry.mint({botId:"bot",threadId,generation,depth:0,kind:"memory",skillAuthoring:false});return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);}

// U37 (audit 01-3): excluding a thread retires its sources, and historical reads accept retired sources, so before this a
// historical search still returned what the excluded thread said. Every mode now refuses evidence from an excluded thread.
it("a thread excluded from memory is not readable through historical search either", async () => {
  complete("The excluded thread mentioned the harbour gate code");
  const record = database().prepare("SELECT id,version FROM memory_records WHERE kind='source'").get()!;
  const bridge = { search: async () => ({ hits: [{ id: String(record.id), version: Number(record.version), score: 1 }], vectorRows: 0 }) };
  const historical = () => searchMemory("harbour", access(), bridge, { allowance: LineageAllowance.tool(1_000_000_000), historical: true });
  expect((await historical()).hits.map(hit => hit.id)).toEqual([record.id]);
  await memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds: [threadId] }, ownerMemoryTicket(), roster);
  expect(database().prepare("SELECT state FROM memory_sources").get()?.state).toBe("retired");
  expect((await searchMemory("harbour", access(), bridge, { allowance: LineageAllowance.tool(1_000_000_000) })).hits).toEqual([]);
  expect((await historical()).hits).toEqual([]);
  // the owner bringing the thread back into memory makes its history readable again
  await memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds: [] }, ownerMemoryTicket(), roster);
  expect((await historical()).hits.map(hit => hit.id)).toEqual([record.id]);
});
