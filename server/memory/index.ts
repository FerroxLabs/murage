import { isMemoryOverviewQuery } from "./relevance.ts";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, existsSync, renameSync } from "node:fs";

export interface IndexedMemory {id:string;version:number;scopeId:string;text:string;deleted:boolean;archived?:boolean}
export interface IndexHit {id:string;version:number;score:number;similarity?:number;lexical?:boolean}

export class MemoryIndex {
  private db: DatabaseSync;
  private allowedKeys=new WeakMap<object,string>();
  private matrix:{model:string;coverage:Set<string>|null;rows:Map<string,{id:string;version:number;key:string;values:Float32Array}>}|null=null;
  readonly rebuilt:boolean;
  constructor(path: string) {
    let rebuilt=!existsSync(path);
    if(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()))throw new Error("UNSAFE_MEMORY_INDEX");
    let db=new DatabaseSync(path);
    try {if(db.prepare("PRAGMA quick_check").get()?.quick_check!=="ok")throw new Error("corrupt");}
    catch {db.close();renameSync(path,`${path}.corrupt-${Date.now()}`);db=new DatabaseSync(path);rebuilt=true;}
    const hadLexicalKeys=Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lexical_keys'").get());
    this.rebuilt=rebuilt;
    this.db=db;
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE VIRTUAL TABLE IF NOT EXISTS lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS vectors(id TEXT NOT NULL,version INTEGER NOT NULL,model TEXT NOT NULL,part INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(id,version,model,part));`);
    if(!hadLexicalKeys){
      // Backfill once, atomically, including legacy FTS rowids that do not
      // match entries.rowid. Subsequent writes use the keyed rowid lookup.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE lexical_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version))");
        db.exec("INSERT INTO lexical_keys SELECT id,CAST(version AS INTEGER),rowid FROM lexical");
        db.exec("COMMIT");
      }catch(error){db.exec("ROLLBACK");db.close();throw error;}
    }
  }
  upsert(records: IndexedMemory[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for(const row of records){
        const previous=this.db.prepare("SELECT fts_rowid FROM lexical_keys WHERE id=? AND version=?").get(row.id,row.version);
        if(previous)this.db.prepare("DELETE FROM lexical WHERE rowid=?").run(previous.fts_rowid);
        this.db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?").run(row.id,row.version);
        if(this.db.prepare("DELETE FROM vectors WHERE id=? AND version=?").run(row.id,row.version).changes&&this.matrix){
          for(const [key,entry] of this.matrix.rows)if(entry.id===row.id&&entry.version===row.version)this.matrix.rows.delete(key);
        }
        if(row.deleted){this.db.prepare("DELETE FROM entries WHERE id=? AND version=?").run(row.id,row.version);continue;}
        this.db.prepare("INSERT OR REPLACE INTO entries VALUES(?,?,?,?)").run(row.id,row.version,row.scopeId,row.text);
        const inserted=this.db.prepare("INSERT INTO lexical VALUES(?,?,?)").run(row.id,row.version,row.text);
        this.db.prepare("INSERT INTO lexical_keys VALUES(?,?,?)").run(row.id,row.version,inserted.lastInsertRowid);
      }
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  vector(record: IndexedMemory, model: string, part: number, values: number[]) {
    const array=new Float32Array(values);
    this.db.prepare("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?)").run(record.id,record.version,model,part,Buffer.from(array.buffer));
    if(this.matrix?.model===model){
      if(this.matrix.coverage&&!this.matrix.coverage.has(`${record.id}:${record.version}`))return;
      const key=`${record.id}:${record.version}:${part}`;
      if(this.matrix.rows.size>=12000&&!this.matrix.rows.has(key)){this.matrix=null;return;}
      this.matrix.rows.set(key,{id:record.id,version:record.version,key:`${record.id}:${record.version}`,values:array});
    }
  }
  /** Load retained vectors before readiness; subsequent writes maintain this cache. */
  prepareModel(model:string,allowed?:Array<{id:string;version:number}>){
    if(this.matrix?.model===model&&(!this.matrix.coverage||allowed?.every(row=>this.matrix!.coverage!.has(`${row.id}:${row.version}`))))return;
    // The 12k bound applies to the authorized scan, not all retained vectors
    // across unrelated audiences and obsolete source revisions. Keep one bounded
    // page resident and never discard durable vectors to make room.
    const rows=allowed
      ?this.db.prepare("SELECT v.id,v.version,v.part,v.vector FROM json_each(?) a JOIN vectors v ON v.id=json_extract(a.value,'$.id') AND v.version=json_extract(a.value,'$.version') WHERE v.model=? LIMIT 12001").all(JSON.stringify(allowed),model)
      :this.db.prepare("SELECT id,version,part,vector FROM vectors WHERE model=? LIMIT 12001").all(model);
    if(rows.length>12000)throw new Error("MEMORY_SEMANTIC_CAPACITY");
    this.matrix={model,coverage:allowed?new Set(allowed.map(row=>`${row.id}:${row.version}`)):null,rows:new Map(rows.map(row=>{
      const bytes=row.vector as Uint8Array;
      return [`${row.id}:${row.version}:${row.part}`,{id:String(row.id),version:Number(row.version),key:`${row.id}:${row.version}`,values:new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))}];
    }))};
  }
  search(query: string, allowed: Array<{id:string;version:number}>, embedding: number[] | null, model: string, limit=20) {
    const started=performance.now();
    const overview=isMemoryOverviewQuery(query);
    // Eligibility caches immutable, revision-fenced sets. Reuse only their
    // serialization; mutable external callers must never retain stale authority.
    let keys=Object.isFrozen(allowed)?this.allowedKeys.get(allowed):undefined;
    if(keys===undefined){keys=JSON.stringify(allowed.map(r=>`${r.id}:${r.version}`));if(Object.isFrozen(allowed))this.allowedKeys.set(allowed,keys);}
    const terms=[...new Set(query.match(/[\p{L}\p{N}_-]+/gu)??[])].slice(0,32);
    const hits=new Map<string,IndexHit>();
    if(terms.length){
      const expression=terms.map(t=>`"${t.replaceAll('"','""')}"`).join(" OR ");
      // FTS columns have no integer affinity: bound JS versions are stored as
      // REAL, whose SQL text form is "1.0" rather than the allowed key's "1".
      // FTS5 native rank preserves default BM25 ordering while allowing its
      // ordered cursor to stop at the authorized limit instead of sorting all hits.
      const rows=this.db.prepare("SELECT id,version,rank FROM lexical WHERE lexical MATCH ? AND id || ':' || CAST(version AS INTEGER) IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT 60").all(expression,keys);
      rows.forEach((row,index)=>hits.set(`${row.id}:${row.version}`,{id:String(row.id),version:Number(row.version),score:1/(60+index+1),lexical:true}));
    }
    const lexicalDone=performance.now();
    let vectorRows=0;
    let matrixMs=0;
    if(embedding){
      const scores=new Map<string,IndexHit>();
      if(!this.matrix||this.matrix.model!==model||this.matrix.coverage&&allowed.some(row=>!this.matrix!.coverage!.has(`${row.id}:${row.version}`))){
        const matrixStart=performance.now();
        this.prepareModel(model,allowed);
        matrixMs=performance.now()-matrixStart;
      }
      const permitted=new Set(allowed.map(row=>`${row.id}:${row.version}`));
      for(const row of this.matrix!.rows.values()){
        if(!permitted.has(row.key))continue; // authorization precedes similarity
        const vector=row.values;
        if(vector.length!==embedding.length)throw new Error("MEMORY_VECTOR_DIMENSION_MISMATCH");
        let dot=0;for(let i=0;i<vector.length;i++)dot+=vector[i]*embedding[i];vectorRows++;
        const key=`${row.id}:${row.version}`;
        if(!scores.has(key)||scores.get(key)!.similarity!<dot)scores.set(key,{id:String(row.id),version:Number(row.version),score:0,similarity:dot});
      }
      [...scores.values()].filter(row=>row.similarity!>0||overview).sort((a,b)=>b.similarity!-a.similarity!).slice(0,60).forEach((row,index)=>{
        const key=`${row.id}:${row.version}`, previous=hits.get(key);
        hits.set(key,{...row,score:(previous?.score??0)+1/(60+index+1),lexical:previous?.lexical??false});
      });
    }
    return {hits:[...hits.values()].sort((a,b)=>b.score-a.score).slice(0,limit),vectorRows,
      timings:{lexicalMs:lexicalDone-started,matrixMs,vectorMs:performance.now()-lexicalDone-matrixMs}};
  }
  close(){this.db.close();}
}
