import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect,it } from "vitest";
import { MemoryIndex } from "./index.ts";

it("replaces and deletes exact FTS keys without retaining stale text",()=>{
  const root=mkdtempSync(join(tmpdir(),"memory-index-keys-")),index=new MemoryIndex(join(root,"index.db"));
  try{
    const row={id:"one:version",version:2,scopeId:"scope",text:"originalneedle",deleted:false};
    index.upsert([row,{...row,id:"other",text:"preservedneedle"}]);
    index.upsert([{...row,text:"replacementneedle"}]);
    const allowed=[{id:row.id,version:2},{id:"other",version:2}];
    expect(index.search("originalneedle",allowed,null,"unused").hits).toEqual([]);
    expect(index.search("replacementneedle",allowed,null,"unused").hits.map(h=>h.id)).toEqual([row.id]);
    index.upsert([{...row,deleted:true}]);
    expect(index.search("replacementneedle",allowed,null,"unused").hits).toEqual([]);
    expect(index.search("preservedneedle",allowed,null,"unused").hits.map(h=>h.id)).toEqual(["other"]);
  }finally{index.close();rmSync(root,{recursive:true,force:true});}
});
it("backfills legacy FTS rowids independently of ordinary entry rowids",()=>{
  const root=mkdtempSync(join(tmpdir(),"memory-index-legacy-")),path=join(root,"index.db"),db=new DatabaseSync(path);
  db.exec("CREATE TABLE entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version)); CREATE VIRTUAL TABLE lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');");
  db.prepare("INSERT INTO entries VALUES('legacy',1,'scope','oldneedle')").run();
  db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(42,'legacy',1.0,'oldneedle')").run();db.close();
  const index=new MemoryIndex(path);
  try{
    index.upsert([{id:"legacy",version:1,scopeId:"scope",text:"newneedle",deleted:false}]);
    expect(index.search("oldneedle",[{id:"legacy",version:1}],null,"unused").hits).toEqual([]);
    expect(index.search("newneedle",[{id:"legacy",version:1}],null,"unused").hits.map(h=>h.id)).toEqual(["legacy"]);
  }finally{index.close();rmSync(root,{recursive:true,force:true});}
});


it("bounds resident vectors by the authorized set despite unrelated retained vectors",()=>{
  const root=mkdtempSync(join(tmpdir(),"memory-index-scope-capacity-")),path=join(root,"index.db"),index=new MemoryIndex(path),db=new DatabaseSync(path);
  try{
    db.exec("BEGIN");const insert=db.prepare("INSERT INTO vectors VALUES(?,1,'model',0,?)");
    for(let i=0;i<12001;i++)insert.run(`record-${i}`,Buffer.from(new Float32Array([1,0]).buffer));db.exec("COMMIT");
    const first=index.search("semantic",[{id:"record-0",version:1}],[1,0],"model");
    expect(first.vectorRows).toBe(1);expect(first.hits.map(row=>row.id)).toEqual(["record-0"]);
    const second=index.search("semantic",[{id:"record-12000",version:1}],[1,0],"model");
    expect(second.vectorRows).toBe(1);expect(second.hits.map(row=>row.id)).toEqual(["record-12000"]);
    // A genuinely over-limit authorized set still fails closed at the same cap.
    expect(()=>index.search("semantic",Array.from({length:12001},(_,i)=>({id:`record-${i}`,version:1})),[1,0],"model")).toThrow("MEMORY_SEMANTIC_CAPACITY");
  }finally{db.close();index.close();rmSync(root,{recursive:true,force:true});}
});


it("does not cache authority from a mutable allowed-set argument",()=>{
  const root=mkdtempSync(join(tmpdir(),"memory-index-mutable-scope-")),index=new MemoryIndex(join(root,"index.db"));
  try{
    index.upsert(["first","second"].map(id=>({id,version:1,scopeId:id,text:"sharedneedle",deleted:false})));
    const allowed=[{id:"first",version:1}];
    expect(index.search("sharedneedle",allowed,null,"none").hits.map(r=>r.id)).toEqual(["first"]);
    allowed[0]={id:"second",version:1};
    expect(index.search("sharedneedle",allowed,null,"none").hits.map(r=>r.id)).toEqual(["second"]);
    Object.freeze(allowed[0]);Object.freeze(allowed);
    expect(index.search("sharedneedle",allowed,null,"none").hits.map(r=>r.id)).toEqual(["second"]);
  }finally{index.close();rmSync(root,{recursive:true,force:true});}
});
