import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect,it } from "vitest";
import { MemoryIndex, walBytes } from "./index.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

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
  }finally{index.close();removeTempDirSync(root);}
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
  }finally{index.close();removeTempDirSync(root);}
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
  }finally{db.close();index.close();removeTempDirSync(root);}
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
  }finally{index.close();removeTempDirSync(root);}
});

/** The stepped maintenance the helper runs while idle (worker.ts purgeRolledCheckpoints), to the end of its pass. */
const runMaintenance=(index:MemoryIndex)=>{for(let step=0;step<5000;step++)if(index.purgeRolledCheckpoints({maxExamined:40,maxMs:50,mergePages:8,mergeFraction:0}).done)return;throw new Error("maintenance did not finish");};

// 0.1.60 low (Windows RE-TEST 4 L6): after a forget, the raw memory-index.db
// still held copies of the deleted words. The content row was zeroed by
// secure_delete, but FTS5 keeps a deleted document's terms in its index
// segments until they are merged. The file must not contain them once the
// owed merge has run (1.0.3: the merge is the stepped maintenance's, below).
it("leaves no copy of a deleted memory's words anywhere in the file once the owed merge has run",async()=>{
  const {readFileSync,existsSync}=await import("node:fs");
  const root=mkdtempSync(join(tmpdir(),"memory-index-scrub-")),path=join(root,"index.db");
  let index=new MemoryIndex(path);
  try{
    const secret={id:"gone",version:1,scopeId:"scope",text:"zanzibarquokka forgotten sentence",deleted:false};
    index.upsert([secret,{id:"kept",version:1,scopeId:"scope",text:"keptwords stay here",deleted:false}]);
    // Several writes so the index has more than one segment to merge.
    for(let i=0;i<5;i++)index.upsert([{id:`filler-${i}`,version:1,scopeId:"scope",text:`filler text ${i}`,deleted:false}]);
    index.upsert([{...secret,deleted:true}]);
    // The deletion owes a merge; the debt is written in the file, so a restart still owes it.
    expect(index.maintenanceOwed()).toBe(true);
    index.close();index=new MemoryIndex(path);
    expect(index.maintenanceOwed()).toBe(true);
    runMaintenance(index);
    expect(index.maintenanceOwed()).toBe(false);
    expect(index.checkpointNow()).toBe(true);
    index.close();
    const raw=()=>[path,`${path}-wal`].filter(existsSync).map(file=>readFileSync(file).toString("latin1")).join("");
    expect(raw()).not.toContain("zanzibarquokka");
    expect(raw()).toContain("keptwords");
    index=new MemoryIndex(path);
    expect(index.search("keptwords",[{id:"kept",version:1}],null,"unused").hits.map(h=>h.id)).toEqual(["kept"]);
  }finally{index.close();removeTempDirSync(root);}
});

// 1.0.3 rehearsal 2 (REHEARSAL-2.md, memory worker write storm): every batch holding a forget merged the whole word index
// ('optimize') and truncated the log, about 47 MB of writes per 16 deletions on the owner's index, 240 MB/min for as long as a
// drain queued deletions. A forget now writes its own deletion and owes the merge to the stepped maintenance, which pays it in
// bounded steps while the helper is idle, so the cost of forgetting one memory no longer grows with the size of the index.
it("a batch with a forget writes its deletions only: the whole-index merge is owed to the stepped maintenance",()=>{
  const root=mkdtempSync(join(tmpdir(),"memory-index-forget-cost-")),path=join(root,"index.db"),index=new MemoryIndex(path);
  try{
    const entry=(n:number)=>({id:`m-${n}`,version:1,scopeId:"scope",text:Array.from({length:40},(_,w)=>`word${(n*7+w*13)%997} term${n}x${w}`).join(" "),deleted:false});
    for(let at=0;at<3000;at+=100)index.upsert(Array.from({length:100},(_,i)=>entry(at+i)));
    const raw=(index as unknown as {db:{exec(sql:string):void;prepare(sql:string):{get():Record<string,unknown>|undefined}}}).db,exec=raw.exec.bind(raw);
    // compact first, as the owner's index is after its last merge, so the forget is measured against a merged index
    exec("INSERT INTO lexical(lexical) VALUES('optimize')");exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const lexicalBytes=Number(raw.prepare("SELECT sum(length(block)) AS n FROM lexical_data").get()!.n);
    expect(lexicalBytes).toBeGreaterThan(1024*1024);
    const statements:string[]=[];
    raw.exec=(sql:string)=>{statements.push(sql);exec(sql);};
    const before=walBytes(path);
    index.upsert(Array.from({length:16},(_,i)=>({...entry(i),deleted:true})));
    raw.exec=exec;
    const forgetBytes=walBytes(path)-before;
    // no whole-index merge and no log truncation in the batch; the writes are the deletions' own
    expect(statements.filter(sql=>sql.includes("'optimize'")||sql.includes("wal_checkpoint"))).toEqual([]);
    expect(index.maintenanceOwed()).toBe(true);
    for(let i=0;i<16;i++)expect(index.search(`term${i}x3`,[{id:`m-${i}`,version:1}],null,"unused").hits).toEqual([]);
    // what the whole-index merge the earlier build ran per batch costs on this index (the log then also copied into the file)
    const merged=walBytes(path);exec("INSERT INTO lexical(lexical) VALUES('optimize')");
    const optimizeBytes=walBytes(path)-merged;
    expect(optimizeBytes).toBeGreaterThan(lexicalBytes/2);
    expect(forgetBytes).toBeLessThan(optimizeBytes/2);
    // the maintenance pays the debt in steps, and the forgotten words then leave the word index
    runMaintenance(index);
    expect(index.maintenanceOwed()).toBe(false);
    expect(index.search("term20x3",[{id:"m-20",version:1}],null,"unused").hits.map(h=>h.id)).toEqual(["m-20"]);
  }finally{index.close();removeTempDirSync(root);}
},60_000);

it("a record written again over its key owes the merge a deletion owes, and finishRewrite pays it and truncates the log (PASTE-CAPTURE-FIX r2.6, D8)",()=>{
  const root=mkdtempSync(join(tmpdir(),"memory-index-rewrite-")),path=join(root,"index.db"),index=new MemoryIndex(path);
  try{
    const row={id:"fact",version:1,scopeId:"scope",text:"routing 021000021 for payroll",deleted:false}; // secret-scan: fixture
    index.upsert([row,{...row,id:"other",text:"plain words about payroll"}]);
    expect(index.maintenanceOwed()).toBe(false);
    // the scrub's rewrite: the same key, the masked text
    index.upsert([{...row,text:"routing ********* for payroll"}]);
    expect(index.maintenanceOwed()).toBe(true);
    expect(index.search("021000021",[{id:"fact",version:1},{id:"other",version:1}],null,"unused").hits).toEqual([]);
    expect(index.finishRewrite()).toBe(true);
    expect(index.maintenanceOwed()).toBe(false);
    expect(walBytes(path)).toBe(0);
    const reader=new DatabaseSync(path);
    try{
      reader.exec("CREATE VIRTUAL TABLE temp.words USING fts5vocab(main,lexical,'row')");
      expect(reader.prepare("SELECT term FROM temp.words WHERE term='021000021'").get()).toBeUndefined();
      expect(reader.prepare("SELECT count(*) AS n FROM entries WHERE text LIKE '%021000021%'").get()!.n).toBe(0);
    }finally{reader.close();}
    // the old digits are nowhere in the file
    expect(readFileSync(path).includes(Buffer.from("021000021"))).toBe(false);
  }finally{index.close();removeTempDirSync(root);}
});
