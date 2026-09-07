import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { isMemoryOverviewQuery, selectMemoryEvidence } from "./relevance.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { searchMemory } from "./search.ts";
import { buildMemoryBundle, hydrateMemoryRecord } from "./bundle.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});

it("requires an exact opaque reference rather than a nearby topic or identifier prefix",()=>{
  const rows=[{text:"Incident retention_bucket_20 has a recovery note.",similarity:0.99},{text:"The retention policy is thirty days.",similarity:0.9}];
  expect(selectMemoryEvidence("Show retention_bucket_2.",rows)).toEqual([]);
  const exact={text:"retention_bucket_2 is the approved recovery location.",similarity:0.3};
  expect(selectMemoryEvidence("Show retention_bucket_2.",[...rows,exact])).toEqual([exact]);
  expect(selectMemoryEvidence("Find incident INC-431.",[{text:"INC-432 is closed.",similarity:0.99}])).toEqual([]);
});

it("retains multiple supported query facets and discards weak unrelated semantic neighbors",()=>{
  const schedule={text:"Recovery snapshots are made nightly.",similarity:0.92};
  const retention={text:"Snapshots are retained for thirty days.",similarity:0.48};
  const inventory={text:"Office inventory has an ordinary administrative note.",similarity:0.2};
  expect(selectMemoryEvidence("How often are recovery snapshots made and how long are snapshots retained?",[schedule,retention,inventory])).toEqual([schedule,retention]);
});

it("does not treat the existing policy as proof of an approved replacement",()=>{
  const original={text:"Documents require two reviewers.",similarity:0.96};
  expect(selectMemoryEvidence("What approved replacement exists for the document review policy?",[original])).toEqual([]);
  expect(selectMemoryEvidence("Replace the document review policy with one reviewer.",[original])).toEqual([original]);
});

it("keeps real positive counterevidence despite a user's negated premise and keeps source denials attributed",()=>{
  const positive={text:"The board approved a replacement requiring one reviewer.",similarity:0.8};
  const negative={text:"No replacement for the review policy was approved.",similarity:0.78};
  const original={text:"The review policy requires two reviewers.",similarity:0.95};
  expect(selectMemoryEvidence("Nobody approved a new policy. Which replacement did the board approve?",[original,positive])).toEqual([positive]);
  expect(selectMemoryEvidence("What approved replacement exists?",[negative])).toEqual([negative]);
});

it("preserves independent multilingual semantic evidence and honest keyword-only fallback",()=>{
  const semantic={text:"Snapshots run every night.",similarity:0.12};
  expect(selectMemoryEvidence("สำรองข้อมูลเมื่อใด",[semantic])).toEqual([semantic]);
  const lexical={text:"Nightly backup retention is thirty days.",lexical:true};
  expect(selectMemoryEvidence("backup retention",[lexical])).toEqual([lexical]);
});

it("applies the same optional gate to canonical search and bundle while preserving pins and explicit get",async()=>{
  const roster={bots:[{id:"bot",threadId:"thread"}],groups:[]};reconcileMemoryRoster(roster);
  const scope=ensureScope("bot","bot");
  database().prepare("INSERT INTO memory_records VALUES('rule',1,?,'fact','The existing policy requires two reviewers.','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  const registry=new InternalCapabilities(),generation=registry.begin("bot","thread"),token=registry.mint({botId:"bot",threadId:"thread",generation,depth:0,kind:"memory",skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const bridge={search:async()=>({hits:[{id:"rule",version:1,score:0.032,similarity:0.95}],vectorRows:1})};
  const query="What approved replacement exists?";
  expect((await searchMemory(query,access,bridge)).hits).toEqual([]);
  expect((await buildMemoryBundle(query,access,bridge)).evidence).toEqual([]);
  expect(hydrateMemoryRecord("rule",1,access).text).toContain("two reviewers");
  database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id='rule'").run();
  expect((await buildMemoryBundle(query,access,bridge)).pinned.map(record=>record.id)).toEqual(["rule"]);
});


it("treats topic-free scope overviews as listings without admitting topical queries",()=>{
  const rule={text:"Operator notes redact account secrets.",similarity:-0.03};
  for(const query of ["List our active constraints", "นโยบายปัจจุบันมีอะไรบ้าง", "当前规则有哪些"]){
    expect(isMemoryOverviewQuery(query)).toBe(true);
    expect(selectMemoryEvidence(query,[rule])).toEqual([rule]);
  }
  for(const query of ["What is the current policy for overseas shipping?", "Show the rules for orbital flight", "Which replacement was approved?"]){expect(isMemoryOverviewQuery(query)).toBe(false);}
});

it("distinguishes rules governing changes from evidence of an adopted replacement",()=>{
  const rule={text:"Database migration requires a recovery checkpoint.",similarity:0.8};
  expect(selectMemoryEvidence("What is the current rule for database migration?",[rule])).toEqual([rule]);
  const conditional={text:"Sessions are reset when account permissions change.",similarity:0.9};
  expect(selectMemoryEvidence("What approved replacement exists?",[conditional])).toEqual([]);
  const approved={text:"The revised policy was adopted as the replacement last week.",similarity:0.7};
  expect(selectMemoryEvidence("What approved replacement exists?",[conditional,approved])).toEqual([approved]);
});

it("does not use missing-decision audit annotations as procedural evidence",()=>{
  const note={text:"Warehouse stocktake entry 42. No approval decision was documented.",similarity:0.96};
  const rule={text:"Compare earlier decisions with the active requirements before acting.",similarity:0.8};
  expect(selectMemoryEvidence("How do we compare earlier decisions with active requirements?",[note,rule])).toEqual([rule]);
  expect(selectMemoryEvidence("Was any approval decision documented?",[note])).toEqual([note]);
  const negative={text:"Do not grant access without approval.",similarity:0.8};
  expect(selectMemoryEvidence("What approval is required to grant access?",[negative])).toEqual([negative]);
});
