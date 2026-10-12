import { isMemoryOverviewQuery } from "./relevance.ts";
import { SEARCH_LIST_DEPTH, UNVECTORED_LIMIT, type RankedRef } from "./worker-protocol.ts";
import { byScore, compareRefs } from "./ref-order.ts";
import { DatabaseSync } from "node:sqlite";
import { pageByRank } from "./rank-ties.ts";
import { lstatSync, existsSync, renameSync, statSync } from "node:fs";
import { checkpointTruncate } from "../sqlite-checkpoint.ts";

/** A write-ahead log over this size is checkpointed after the batch that grew it, and scans wait for that (index-reader.ts). */
export const WAL_DRAIN_BYTES = 64 * 1024 * 1024;
export function walBytes(path: string): number { try { return statSync(`${path}-wal`).size; } catch { return 0; } }

/** `rolled`: a deletion that only retires an old checkpoint version (its words re-quote sources that stay indexed). Its
 * cleanup is the stepped maintenance's job; a deletion that is a forget is not rolled and cleans up at once. */
export interface IndexedMemory {id:string;version:number;scopeId:string;text:string;deleted:boolean;archived?:boolean;rolled?:boolean}
export interface IndexHit {id:string;version:number;score:number;similarity?:number;lexical?:boolean}
export { byScore, compareRefs };
const bySimilarity=(a:{id:string;version:number;similarity?:number},b:{id:string;version:number;similarity?:number})=>b.similarity!-a.similarity!||compareRefs(a,b);
/** What one search asks of the index beyond the query. `words: false` and `resident: false` are the continuation chunks of
 * a scan over an eligible set larger than the resident cache: meaning only, read straight from the table. */
export interface IndexSearchOptions {words?:boolean;resident?:boolean}

export class MemoryIndex {
  private db: DatabaseSync;
  private readonly path: string;
  private allowedKeys=new WeakMap<object,string>();
  private matrix:{model:string;coverage:Set<string>|null;rows:Map<string,{id:string;version:number;key:string;values:Float32Array}>}|null=null;
  readonly rebuilt:boolean;
  constructor(path: string) {
    this.path=path;
    let rebuilt=!existsSync(path);
    if(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()))throw new Error("UNSAFE_MEMORY_INDEX");
    let db=new DatabaseSync(path);
    try {if(db.prepare("PRAGMA quick_check").get()?.quick_check!=="ok")throw new Error("corrupt");}
    catch {db.close();renameSync(path,`${path}.corrupt-${Date.now()}`);db=new DatabaseSync(path);rebuilt=true;}
    const hadLexicalKeys=Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lexical_keys'").get());
    this.rebuilt=rebuilt;
    this.db=db;
    // secure_delete: forgotten text is overwritten in the file, not left in
    // free space (a deleted conversation's words must not stay readable).
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA journal_size_limit=67108864;
      CREATE TABLE IF NOT EXISTS entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE VIRTUAL TABLE IF NOT EXISTS lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS vectors(id TEXT NOT NULL,version INTEGER NOT NULL,model TEXT NOT NULL,part INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(id,version,model,part));
      CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;`);
    // A merge owed when the app last stopped is still owed: the obligation lives in this file, not in memory.
    this.purge.merging=Boolean(db.prepare("SELECT 1 FROM index_meta WHERE key='merge_owed' AND value='1'").get());
    // One TRUNCATE before traffic gives back a log left large by an earlier run (PROPOSAL-v2 10.3).
    try{db.exec("PRAGMA wal_checkpoint(TRUNCATE)");}catch{/* a reader holds it; the next checkpoint takes it */}
    // FTS5 keeps a deleted document's terms in its index segments until they
    // are merged, so secure_delete alone left a forgotten memory's words in
    // the file (0.1.60 low). A write that deletes merges the index
    // (`optimize`) in the same transaction, and secure_delete zeroes the
    // pages the merge frees.
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
    const forgets=records.some(row=>row.deleted&&!row.rolled),rolledDeletions=records.filter(row=>row.deleted&&row.rolled).length;
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
      if(forgets)this.db.exec("INSERT INTO lexical(lexical) VALUES('optimize')");
      // The obligation to merge a rolled deletion out is written in the same transaction as the deletion.
      if(rolledDeletions)this.setMergeOwed(true);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    // A rolled checkpoint version leaves the index like any other deletion, but its cleanup is not whole-index work per
    // batch: the stepped maintenance (purgeRolledCheckpoints) merges it in short steps while the helper is idle, with no walk.
    if(rolledDeletions)this.purge.merging=true;
    // The old pages stay in the write-ahead log until it is checkpointed.
    if(forgets)try{this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");}catch{/* the next checkpoint takes it */}
    else this.checkpointIfLarge();
  }
  /** Truncate the log when it has grown past WAL_DRAIN_BYTES. Capture batches call this so a log that readers held open gets
   * its window as soon as the readers let go. True when it was truncated. */
  /** Truncate the log now (the reader asked: no scan snapshot is open). True when the log was truncated, or was already empty. */
  checkpointNow():boolean{
    if(walBytes(this.path)===0)return true;
    return checkpointTruncate(this.db,"memory-index");
  }
  checkpointIfLarge(limit:number=WAL_DRAIN_BYTES):boolean{
    if(walBytes(this.path)<=limit)return false;
    return checkpointTruncate(this.db,"memory-index");
  }
  /** Whether deletions are waiting for the stepped maintenance to merge them out of the word index. Durable: set in the
   * transaction that deleted (the walk's own transaction too, even when it removed too little to start merging yet), cleared only
   * when a merge step finds nothing left to merge, and read again when the index opens: the debt is the durable marker, the
   * decision to start paying it (purge.merging) is separate and may wait for a fraction of the index. */
  maintenanceOwed():boolean{return this.purge.merging;}
  private setMergeOwed(owed:boolean){
    if(owed)this.db.prepare("INSERT OR REPLACE INTO index_meta VALUES('merge_owed','1')").run();
    else this.db.prepare("DELETE FROM index_meta WHERE key='merge_owed'").run();
  }
  /** Remove every entry (lexical text, keys, vectors) of the given record ids, all
   * versions. Bounded (200 ids per transaction) and idempotent: a second call
   * finds nothing. Used at open to drop owner-authored continuity records that an
   * earlier build indexed, so their text never contributes to BM25 statistics. */
  purgeRecords(ids: readonly string[]): number {
    let removed=0;
    for(let start=0;start<ids.length;start+=200){
      const chunk=JSON.stringify(ids.slice(start,start+200));
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const rowids=this.db.prepare("SELECT fts_rowid FROM lexical_keys WHERE id IN (SELECT value FROM json_each(?))").all(chunk);
        for(const row of rowids)this.db.prepare("DELETE FROM lexical WHERE rowid=?").run(row.fts_rowid);
        removed+=rowids.length;
        this.db.prepare("DELETE FROM lexical_keys WHERE id IN (SELECT value FROM json_each(?))").run(chunk);
        removed+=Number(this.db.prepare("DELETE FROM entries WHERE id IN (SELECT value FROM json_each(?))").run(chunk).changes);
        removed+=Number(this.db.prepare("DELETE FROM vectors WHERE id IN (SELECT value FROM json_each(?))").run(chunk).changes);
        // Deleted words stay in FTS5 segments until merged: the debt is written with the deletion, not after it.
        this.setMergeOwed(true);
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
    }
    if(removed){
      const drop=new Set(ids);
      if(this.matrix)for(const [key,entry] of this.matrix.rows)if(drop.has(entry.id))this.matrix.rows.delete(key);
      try{
        this.db.exec("INSERT INTO lexical(lexical) VALUES('optimize')");
        // A full merge pays every debt, the stepped walk's included; the walk's own count restarts from here.
        this.purge.merging=false;this.purge.since=0;this.setMergeOwed(false);
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }catch{/* the debt stays written: the next open or merge step pays it */this.purge.merging=true;}
    }
    return removed;
  }
  /** Old versions of thread checkpoints left in the index (an earlier build indexed them, or an acknowledgement raced a
   * rollover): each entry with a newer version of the same checkpoint in this index is removed. One call is one bounded
   * step, run by the helper between queries until `done`:
   *  - a walk step examines at most `maxExamined` entries in key order from where the last step stopped (entries are
   *    ordered by id then version, so an entry is rolled exactly when the next one has the same id), removes the rolled
   *    ones and stops early at half of `maxMs` (the commit takes the rest). Bounding the entries examined, not only those
   *    removed, keeps a step short when nothing is rolled (500,000 sole checkpoints took 311 ms in one step, msearch
   *    review round 2);
   *  - merge steps (FTS5 'merge', about `mergePages` pages each) run whenever the walk has removed a `mergeFraction` of
   *    what is left since the last merge, and once more when it ends. Merging while few entries are deleted keeps each
   *    step short: a merge's work is the input it reads, and merging once at the end, when almost everything read is
   *    deleted, read the whole index in one 120-400 ms call however few pages it wrote.
   * The walk then starts again from the beginning on the next pass. */
  purgeRolledCheckpoints(options: {maxExamined?: number; maxMs?: number; mergePages?: number; mergeFraction?: number} = {}): {removed: number; examined: number; merged: boolean; done: boolean} {
    const maxExamined=Math.max(1,options.maxExamined??2048),maxMs=options.maxMs??10,mergePages=Math.max(1,options.mergePages??8),mergeFraction=options.mergeFraction??0.1;
    if(this.purge.merging){
      const before=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n);
      this.db.exec(`INSERT INTO lexical(lexical,rank) VALUES('merge',${-mergePages})`);
      // FTS5: fewer than two changes means the merge found nothing left to merge.
      if(Number(this.db.prepare("SELECT total_changes() AS n").get()!.n)-before>=2)return {removed:0,examined:0,merged:true,done:false};
      this.purge.merging=false;this.setMergeOwed(false);
      const done=this.purge.cursor===null;
      if(done)this.purge.live=null;
      return {removed:0,examined:0,merged:false,done};
    }
    const started=performance.now(),cursor=this.purge.cursor??{id:"checkpoint:",version:-1};
    this.purge.live??=Number(this.db.prepare("SELECT count(*) AS n FROM entries").get()!.n);
    // 'checkpoint;' is the first key past every 'checkpoint:*' id (';' follows ':').
    const rows=this.db.prepare(`SELECT e.id,e.version,k.fts_rowid FROM entries e LEFT JOIN lexical_keys k ON k.id=e.id AND k.version=e.version
      WHERE (e.id,e.version)>(?,?) AND e.id<'checkpoint;' ORDER BY e.id,e.version LIMIT ?`).all(cursor.id,cursor.version,maxExamined+1);
    const removedKeys:string[]=[];
    let examined=0,last:{id:string;version:number}|null=null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const deleteLexical=this.db.prepare("DELETE FROM lexical WHERE rowid=?"),deleteKey=this.db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?");
      const deleteEntry=this.db.prepare("DELETE FROM entries WHERE id=? AND version=?"),deleteVectors=this.db.prepare("DELETE FROM vectors WHERE id=? AND version=?");
      for(let n=0;n<rows.length&&n<maxExamined;n++){
        if(examined&&performance.now()-started>=maxMs/2)break;
        const row=rows[n],next=rows[n+1];
        examined++;last={id:String(row.id),version:Number(row.version)};
        if(!next||next.id!==row.id)continue;
        if(row.fts_rowid!==null)deleteLexical.run(row.fts_rowid);
        deleteKey.run(row.id,row.version);deleteEntry.run(row.id,row.version);deleteVectors.run(row.id,row.version);
        removedKeys.push(`${row.id}:${row.version}`);
      }
      // The obligation to merge what this walk deleted is written in the transaction that deleted it, whether or not the
      // walk has yet removed enough to start merging: a stop below the threshold must not forget the debt.
      if(removedKeys.length)this.setMergeOwed(true);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    if(removedKeys.length&&this.matrix){const gone=new Set(removedKeys);for(const [key,entry] of this.matrix.rows)if(gone.has(entry.key))this.matrix.rows.delete(key);}
    this.purge.live=Math.max(0,this.purge.live-removedKeys.length);this.purge.since+=removedKeys.length;
    const ended=examined===rows.length;
    this.purge.cursor=ended?null:last;
    if(this.purge.since&&(ended||this.purge.since>=Math.max(1000,mergeFraction*this.purge.live))){this.purge.since=0;this.purge.merging=true;this.setMergeOwed(true);}
    const done=ended&&!this.purge.merging;
    if(done)this.purge.live=null;
    return {removed:removedKeys.length,examined,merged:false,done};
  }
  /** Where the rolled-checkpoint purge is: the walk's position (null: at the start), entries left in the index (counted
   * when a pass starts), entries removed since the last merge, and whether merge steps are running. */
  private purge:{cursor:{id:string;version:number}|null;live:number|null;since:number;merging:boolean}={cursor:null,live:null,since:0,merging:false};
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
  /** The vectors of exactly these records, read straight from the table and kept nowhere: one chunk of a scan over an
   * eligible set larger than the resident cache. */
  private vectorsOf(allowed:Array<{id:string;version:number}>,model:string){
    const rows=this.db.prepare("SELECT v.id,v.version,v.part,v.vector FROM json_each(?) a JOIN vectors v ON v.id=json_extract(a.value,'$.id') AND v.version=json_extract(a.value,'$.version') WHERE v.model=? LIMIT 12001").all(JSON.stringify(allowed),model);
    if(rows.length>12000)throw new Error("MEMORY_SEMANTIC_CAPACITY");
    return rows.map(row=>{
      const bytes=row.vector as Uint8Array;
      return {id:String(row.id),version:Number(row.version),key:`${row.id}:${row.version}`,values:new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))};
    });
  }
  search(query: string, allowed: Array<{id:string;version:number}>, embedding: number[] | null, model: string, limit=20, options: IndexSearchOptions = {}) {
    const started=performance.now();
    const overview=isMemoryOverviewQuery(query);
    // Eligibility caches immutable, revision-fenced sets. Reuse only their
    // serialization; mutable external callers must never retain stale authority.
    let keys=Object.isFrozen(allowed)?this.allowedKeys.get(allowed):undefined;
    if(keys===undefined){keys=JSON.stringify(allowed.map(r=>`${r.id}:${r.version}`));if(Object.isFrozen(allowed))this.allowedKeys.set(allowed,keys);}
    const terms=options.words===false?[]:[...new Set(query.match(/[\p{L}\p{N}_-]+/gu)??[])].slice(0,32);
    const hits=new Map<string,IndexHit>();
    const lexicalRanked:RankedRef[]=[],vectorRanked:RankedRef[]=[];
    let unvectored:Array<[string,number]>|undefined,unvectoredMore=false;
    if(terms.length){
      const expression=terms.map(t=>`"${t.replaceAll('"','""')}"`).join(" OR ");
      // FTS columns have no integer affinity: bound JS versions are stored as
      // REAL, whose SQL text form is "1.0" rather than the allowed key's "1".
      // FTS5 native rank preserves default BM25 ordering while allowing its
      // ordered cursor to stop at the authorized limit instead of sorting all hits.
      // Equal ranks order by (id, version), settled after the query so FTS5 keeps its ordered cursor (rank-ties.ts).
      // (BM25 statistics are computed over the whole shared index, denied documents included; that is a documented residual,
      // docs/memory.md "Search and what a reader cannot read", and it needs a per-scope index to close.)
      const statement=this.db.prepare(`SELECT id,version,rank FROM lexical WHERE lexical MATCH ? AND id || ':' || CAST(version AS INTEGER) IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT ? OFFSET ?`);
      const rows=pageByRank((start,count)=>statement.all(expression,keys,count,start),0,SEARCH_LIST_DEPTH).rows;
      rows.forEach((row,index)=>{
        lexicalRanked.push([String(row.id),Number(row.version)]);
        if(index<60)hits.set(`${row.id}:${row.version}`,{id:String(row.id),version:Number(row.version),score:1/(60+index+1),lexical:true});
      });
    }
    const lexicalDone=performance.now();
    let vectorRows=0;
    let matrixMs=0;
    if(embedding){
      const scores=new Map<string,IndexHit>();
      let source:Iterable<{id:string;version:number;key:string;values:Float32Array}>;
      if(options.resident===false){
        const matrixStart=performance.now();
        source=this.vectorsOf(allowed,model);
        matrixMs=performance.now()-matrixStart;
      }else{
        if(!this.matrix||this.matrix.model!==model||this.matrix.coverage&&allowed.some(row=>!this.matrix!.coverage!.has(`${row.id}:${row.version}`))){
          const matrixStart=performance.now();
          this.prepareModel(model,allowed);
          matrixMs=performance.now()-matrixStart;
        }
        source=this.matrix!.rows.values();
      }
      const permitted=new Set(allowed.map(row=>`${row.id}:${row.version}`));
      for(const row of source){
        if(!permitted.has(row.key))continue; // authorization precedes similarity
        const vector=row.values;
        if(vector.length!==embedding.length)throw new Error("MEMORY_VECTOR_DIMENSION_MISMATCH");
        let dot=0;for(let i=0;i<vector.length;i++)dot+=vector[i]*embedding[i];vectorRows++;
        const key=`${row.id}:${row.version}`;
        if(!scores.has(key)||scores.get(key)!.similarity!<dot)scores.set(key,{id:String(row.id),version:Number(row.version),score:0,similarity:dot});
      }
      // Ties by (record id, version): the resident cache holds rows in the order they were loaded or written, and which
      // order that is depends on how much the cache has been asked to hold.
      const ranked=[...scores.values()].filter(row=>row.similarity!>0||overview).sort(bySimilarity).slice(0,SEARCH_LIST_DEPTH);
      ranked.forEach((row,index)=>{
        vectorRanked.push([row.id,row.version,row.similarity!]);
        if(index>=60)return;
        const key=`${row.id}:${row.version}`, previous=hits.get(key);
        hits.set(key,{...row,score:(previous?.score??0)+1/(60+index+1),lexical:previous?.lexical??false});
      });
      // Eligible records the meaning search could not score because they have no vector yet.
      unvectored=[];
      for(const row of allowed){
        if(scores.has(`${row.id}:${row.version}`))continue;
        if(unvectored.length>=UNVECTORED_LIMIT){unvectoredMore=true;break;}
        unvectored.push([row.id,row.version]);
      }
    }
    return {hits:[...hits.values()].sort(byScore).slice(0,limit),vectorRows,lexicalRanked,vectorRanked,...unvectored?{unvectored,unvectoredMore}:{},
      timings:{lexicalMs:lexicalDone-started,matrixMs,vectorMs:performance.now()-lexicalDone-matrixMs}};
  }
  close(){this.db.close();}
}
