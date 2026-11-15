import { expect, it } from "vitest";
import { MergePredictor, mergeRoute, structureMergePages } from "./memw-steps.ts";

it.each([[259,"merge"],[1800,"tier"],[4000,"floor"]] as const)("prices %s input pages before selecting the %s merge route",(pages,route)=>{
  const predictor=new MergePredictor(4096);
  const predict=predictor.pred.bind(predictor) as (table:string,text:number,pages:number)=>number;
  const price=predict("lexical",0,pages);
  expect(price,"merge input pages missing from write reserve").toBe((2*pages+2*64+16)*4120);
  expect(mergeRoute(price,4096)).toBe(route);
});

it("counts inclusive leaf ranges of the in-progress merge and fails closed past the segment ceiling",()=>{
  // Three segments, the first two already merging: [10,12] + [20,25] = 9 pages.
  expect(structureMergePages(Uint8Array.from([0,0,0,0,1,3,0,2,3,1,10,12,2,20,25,3,35,40]))).toBe(9);
  expect(structureMergePages(Uint8Array.from([0,0,0,0,1,0x8f,0x51,0]))).toBeNull();
  expect(structureMergePages(Uint8Array.from([0,0,0,0,1,3,0,2]))).toBeNull();
});

it("reserves the actual WAL rise of a common-term merge after 200k replacements", async()=>{
  const { DatabaseSync }=await import("node:sqlite");
  const { mkdtempSync,statSync }=await import("node:fs");
  const { tmpdir }=await import("node:os");
  const { join }=await import("node:path");
  const { removeTempDirSync }=await import("../testing/cleanup.ts");
  const root=mkdtempSync(join(tmpdir(),"memw-page-merge-")),path=join(root,"index.db"),db=new DatabaseSync(path);
  try{
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE VIRTUAL TABLE lexical USING fts5(text); INSERT INTO lexical(lexical,rank) VALUES('automerge',0); INSERT INTO lexical(lexical,rank) VALUES('usermerge',2); INSERT INTO lexical(lexical,rank) VALUES('crisismerge',1999)");
    const put=db.prepare("INSERT OR REPLACE INTO lexical(rowid,text) VALUES(?,'common')");
    for(let pass=0;pass<2;pass++){
      db.exec("BEGIN");for(let i=1;i<=200_000;i++)put.run(i);db.exec("COMMIT");
    }
    const pages=structureMergePages(db.prepare("SELECT block FROM lexical_data WHERE id=10").get()!.block as Uint8Array);
    expect(pages).not.toBeNull();
    expect(pages).toBeGreaterThan(100);
    const price=new MergePredictor(4096).pred("lexical",0,pages!);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("INSERT INTO lexical(lexical,rank) VALUES('merge',64)");
    const rise=statSync(`${path}-wal`).size;
    expect(rise,"fixture must execute a merge").toBeGreaterThan(0);
    expect(rise,"WAL merge exceeded page reserve").toBeLessThanOrEqual(price);
    expect(rise,"WAL merge exceeded 12 MiB bound").toBeLessThanOrEqual(12*1024*1024);
    console.log(JSON.stringify({case:"200k-common-term",pages,price,rise}));
  }finally{db.close();removeTempDirSync(root);}
},120_000);
