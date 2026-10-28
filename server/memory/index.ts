import { isMemoryOverviewQuery } from "./relevance.ts";
import { SEARCH_LIST_DEPTH, UNVECTORED_LIMIT, type RankedRef } from "./worker-protocol.ts";
import { byScore, compareRefs } from "./ref-order.ts";
import { DatabaseSync } from "node:sqlite";
import { pageByRank } from "./rank-ties.ts";
import { lstatSync, existsSync, statSync } from "node:fs";
import { checkIndex, indexDamaged, prepareIndexOpen, quarantineIndex, removeIndexQuarantines } from "./index-quarantine.ts";
import { checkpointTruncate } from "../sqlite-checkpoint.ts";
import { POSTINGS_BELOW, POSTINGS_SCHEMA, POSTINGS_TODO_UPGRADE, postingFiller } from "./postings.ts";

/** A write-ahead log over this size is checkpointed after the batch that grew it, and scans wait for that (index-reader.ts). */
export const WAL_DRAIN_BYTES = 64 * 1024 * 1024;
/** How long opening the index waits for another connection's lock or WAL recovery before the start fails (and is retried). */
export const INDEX_OPEN_BUSY_MS = 5_000;
/** One FTS command per scrub turn, including when the age table is present. */
export const DELETE_SCRUB_MERGE_PAGES = 1;
export function walBytes(path: string): number { try { return statSync(`${path}-wal`).size; } catch { return 0; } }

/** `rolled`: a deletion that only retires an old checkpoint version (its words re-quote sources that stay indexed), as against
 * a forget. Both leave the word index through the stepped maintenance (upsert owes it the merge). */
/** `ageKey`: the record's age key (schema.ts RECORD_KEYS_SCHEMA), the rowid its FTS row takes once the index is in age order (age-index.ts);
 * null for a record not keyed yet (an index in its preparing mode, or an older binary's write). */
export interface IndexedMemory {id:string;version:number;scopeId:string;text:string;deleted:boolean;archived?:boolean;rolled?:boolean;ageKey?:number|null}
export interface IndexHit {id:string;version:number;score:number;similarity?:number;lexical?:boolean}
export { byScore, compareRefs };
import { FTS_SEGMENT_LIMIT,isSegmentLimitError } from "./segment-limit.ts";
import { ageTablesPresent, fillAgeIndexStep, lexicalGeneration, lexicalRowidsAged, markFreshIndexAged, placeLexicalRow, sweepAgeRowidsStep, type AgeFillOptions } from "./age-index.ts";
export { isSegmentLimitError };
/** Past this many segments the helper compacts the index once, well before the limit. */
export const FTS_SEGMENT_COMPACT_AT = 1000;
const bySimilarity=(a:{id:string;version:number;similarity?:number},b:{id:string;version:number;similarity?:number})=>b.similarity!-a.similarity!||compareRefs(a,b);
/** What one search asks of the index beyond the query. `words: false` and `resident: false` are the continuation chunks of
 * a scan over an eligible set larger than the resident cache: meaning only, read straight from the table. */
export interface IndexSearchOptions {words?:boolean;resident?:boolean}

/** Scopes the backfill remembers a search asked about. */
const WANTED_SCOPES=256;
/** The share of a step's budget the work may use: the commit that ends the step needs the rest. */
const STEP_SHARE=0.4;
/** Entries one enumeration read looks at, at most (the clock is checked between them). */
const ENUMERATE_CHUNK=32;
/** Listed entries one fill reads at a time. */
const FILL_CHUNK=16;
/** The log of the backfill steps is written back into the file once it holds this much. */
const POSTINGS_WAL_BYTES=1024*1024;
/** ...and not more often than once in this many steps. */
const SETTLE_EVERY=4;

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
    // The check waits out another connection's lock or WAL recovery (a backup snapshot, a reader opening the file) instead of reading it
    // as damage. Busy, locked or any other fault is thrown: the helper's start fails and is tried again with backoff (worker-controller.ts
    // backOffStart). Only a damaged file is set aside (MEMINDEX-BUSY-109).
    // A log file that is a link or not a regular file stops the start; one left without its index file is removed first (index-quarantine.ts).
    prepareIndexOpen(path);
    let db=new DatabaseSync(path,{timeout:INDEX_OPEN_BUSY_MS});
    // Any throw past here closes the handle it opened, so a failed start leaves no connection on the file.
    try {
    try {checkIndex(db);}
    catch(error){db.close();if(!indexDamaged(error))throw error;quarantineIndex(path);prepareIndexOpen(path);db=new DatabaseSync(path,{timeout:INDEX_OPEN_BUSY_MS});rebuilt=true;}
    // Past the check the handle keeps the wait it always had (none): the helper's steps meet a held lock at once and retry.
    db.exec("PRAGMA busy_timeout=0");
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
    // FTS5 keeps deleted terms until a merge. Owner deletions owe both that
    // merge and a truncated log; rolled checkpoint versions use stepped maintenance.
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
    // Age order (age-index.ts): an index with no word row yet takes age keys as rowids from its first row; one with rows is filled
    // into a second table by the helper and cut over by rename (fillAgeIndex).
    try{this.aged=markFreshIndexAged(db);}catch(error){db.close();throw error;}
    this.ageTables=!this.aged&&ageTablesPresent(db);
    // The scoped word index (postings.ts). Creating it reads nothing: the triggers keep every entry written from here on, and the
    // entries already there are filled newest first by fillPostings, from the rowid recorded here.
    if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='postings'").get()){
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(POSTINGS_SCHEMA);
        const top=db.prepare("SELECT max(rowid) AS n FROM entries").get()?.n;
        if(top!==null&&top!==undefined)db.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run(POSTINGS_BELOW,String(Number(top)+1));
        db.exec("COMMIT");
      }catch(error){db.exec("ROLLBACK");db.close();throw error;}
    } else if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='posting_todo'").get()){
      // A file the build before the per-scope backfill left, part way through or finished: the to-do list and the triggers that clear it,
      // in one transaction of schema pages. `postings_below` stays where it is: entries at or above it have their postings, entries
      // below it are listed by the next steps, so nothing already written is read again.
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(POSTINGS_TODO_UPGRADE); db.exec("COMMIT"); }
      catch(error){db.exec("ROLLBACK");db.close();throw error;}
    }
    // Resume a completed scrub's checkpoint. A legacy marker without a generation takes at most
    // one merge step here; all remaining work stays owed to the worker.
    if(db.prepare("SELECT 1 FROM index_meta WHERE key='delete_scrub_owed' AND value='truncate'").get()){
      try{this.scrubDeleted();}catch{/* the durable debt and pending receipts remain */}
    }
    // The new index is open and complete: a copy set aside now or by an earlier start is never read again, and it still holds the words
    // of deleted conversations, so it goes (index-quarantine.ts). Messages.db's own quarantines are never touched here.
    removeIndexQuarantines(path);
    } catch(error){try{db.close();}catch{/* already closed on the path that threw */}throw error;}
  }
  /** Whether `lexical` holds every row at its age key (age-index.ts), and whether the second word table exists (the fill is under way). */
  private aged=false;
  private ageTables=false;
  /** Whether the word table still has to be put in age order (the helper runs fillAgeIndex until it is). */
  ageFillOwed():boolean{return !this.aged;}
  lexicalGeneration():number{return lexicalGeneration(this.db);}
  /** One slice of the age fill, or the cutover when the walk has ended (age-index.ts fillAgeIndexStep). `authority`: a read-only
   * handle on the main database (the key table). Never on the main thread. */
  fillAgeIndex(authority:DatabaseSync,options:AgeFillOptions={}):ReturnType<typeof fillAgeIndexStep>{
    const step=fillAgeIndexStep(this.db,authority,options);
    if(step.cutover||lexicalRowidsAged(this.db)){this.aged=true;this.ageTables=false;}
    else if(!this.ageTables)this.ageTables=ageTablesPresent(this.db);
    return step;
  }
  /** One slice of the post-cutover sweep (age-index.ts sweepAgeRowidsStep). */
  sweepAgeRowids(authority:DatabaseSync,options:{maxRows?:number}={}):ReturnType<typeof sweepAgeRowidsStep>{return sweepAgeRowidsStep(this.db,authority,options);}
  /** Scopes readers asked about, most recent first (at most WANTED_SCOPES): their backfill goes first. */
  private wanted:string[]=[];
  private turn=0;
  private cursor=0;
  private settled=0;
  private busyMs=0;
  /** The helper heard a search over these scopes: they are filled before the rest. */
  wantScopes(scopeIds:readonly string[]):void{
    for(const id of scopeIds){const at=this.wanted.indexOf(id);if(at>=0)this.wanted.splice(at,1);this.wanted.unshift(id);}
    if(this.wanted.length>WANTED_SCOPES)this.wanted.length=WANTED_SCOPES;
  }
  /** One bounded step of the postings backfill, in one transaction of at most `maxMs` and `maxRows`. The backfill has two kinds of step:
   * ENUMERATE walks the entries below `postings_below` newest first reading only (rowid, scope) and lists each on `posting_todo`, which
   * is the scope index `entries` lacks, built in short steps; FILL takes one scope's listed entries, newest first, writes their postings
   * and un-lists them. A reader's page depends on its own scopes' lists only (index-reader.ts), whatever other scopes hold. Order: the
   * scopes searches asked about, then the others in turn; while enumerating, fill and enumeration alternate. A step that finds the
   * write lock taken returns `busy` and does nothing; the caller tries again later. */
  fillPostings(options:{maxMs?:number;maxRows?:number}={}):{done:boolean;filled:number;busy?:true}{
    const maxMs=options.maxMs??10,maxRows=Math.max(1,options.maxRows??256);
    try {
      const enumerating=this.postingsBelow()!==null;
      const fillTurn=this.turn++%2===0;
      // While enumerating, every other step is a fill of a scope a reader asked about (when one has anything listed); afterwards the
      // steps alternate between those scopes and the others in turn.
      let scope:number|null;
      if(enumerating)scope=fillTurn?this.wantedWithTodo():null;
      else scope=fillTurn?this.wantedWithTodo()??this.nextWithTodo():this.nextWithTodo()??this.wantedWithTodo();
      if(scope!==null){
        const filled=this.fillScope(scope,maxMs,maxRows);
        return {done:false,filled};
      }
      if(enumerating){const step=this.enumerate(maxMs,maxRows);return {done:false,filled:step.rows};}
      return {done:!this.postingsOwed(),filled:0};
    }catch(error){
      if(/database is locked|SQLITE_BUSY/i.test(error instanceof Error?error.message:String(error)))return {done:false,filled:0,busy:true};
      throw error;
    }
  }
  private postingsBelow():number|null{
    const mark=this.db.prepare("SELECT value FROM index_meta WHERE key=?").get(POSTINGS_BELOW);
    return mark?Number(mark.value):null;
  }
  /** The first scope a search asked about that still has entries listed. */
  private wantedWithTodo():number|null{
    const scopeOf=this.db.prepare("SELECT n FROM posting_scopes WHERE scope_id=?"),listed=this.db.prepare("SELECT 1 AS x FROM posting_todo WHERE scope=? LIMIT 1");
    for(const id of this.wanted){
      const row=scopeOf.get(id);
      if(row&&listed.get(Number(row.n)))return Number(row.n);
    }
    return null;
  }
  /** The next scope with entries listed, after the last one served (wrapping). */
  private nextWithTodo():number|null{
    const row=this.db.prepare("SELECT scope FROM posting_todo WHERE scope>? ORDER BY scope LIMIT 1").get(this.cursor)??this.db.prepare("SELECT scope FROM posting_todo ORDER BY scope LIMIT 1").get();
    if(!row)return null;
    this.cursor=Number(row.scope);
    return this.cursor;
  }
  /** The write lock for one backfill step, taken without any wait (the caller retries later). A step's commit must not wait for the disk
   * either: FULL syncs the log at every commit, and the log is checkpointed by whichever commit crosses the threshold, which can stall one
   * step for tens of milliseconds. The postings are an index that can be rebuilt and a step lost to a power cut is simply done again, so a
   * step commits with NORMAL (the safe setting for a write-ahead log: no corruption, only the latest commits can be lost) and leaves the
   * checkpoint to settlePostings, a separate call. All three settings are put back after the step. */
  private beginStep():void{
    this.busyMs=Number(this.db.prepare("PRAGMA busy_timeout").get()?.timeout??0);
    this.db.exec("PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=0");
    try{this.db.exec("BEGIN IMMEDIATE");}catch(error){this.restoreStep();throw error;}
  }
  private endStep(commit:boolean):void{
    try{this.db.exec(commit?"COMMIT":"ROLLBACK");}finally{this.restoreStep();}
  }
  private restoreStep():void{this.db.exec(`PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000; PRAGMA busy_timeout=${this.busyMs}`);}
  /** Writes the log of the backfill steps back into the file, when it has grown past POSTINGS_WAL_BYTES: its own call, between steps,
   * so no step pays for it. Never waits for a reader (a passive checkpoint writes what it can). */
  settlePostings():void{
    if(++this.settled<SETTLE_EVERY||walBytes(this.path)<POSTINGS_WAL_BYTES)return;
    this.settled=0;
    try{this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");}catch{/* a writer holds it; the next call takes it */}
  }
  private enumerate(maxMs:number,maxRows:number):{rows:number;done:boolean}{
    const started=performance.now();
    this.beginStep();
    try {
      let below=this.postingsBelow();
      if(below===null){this.endStep(true);return {rows:0,done:true};}
      const scopeOf=this.db.prepare("SELECT n FROM posting_scopes WHERE scope_id=?");
      const add=this.db.prepare("INSERT INTO posting_scopes(scope_id,n) SELECT ?1,(SELECT coalesce(max(n),0)+1 FROM posting_scopes) WHERE NOT EXISTS (SELECT 1 FROM posting_scopes WHERE scope_id=?1)");
      const list=this.db.prepare("INSERT OR IGNORE INTO posting_todo(scope,seq) VALUES(?,?)");
      const read=this.db.prepare("SELECT rowid AS seq,scope_id FROM entries WHERE rowid<? ORDER BY rowid DESC LIMIT ?");
      const known=new Map<string,number>();
      let rows=0,dry=false;
      while(rows<maxRows){
        const want=Math.min(ENUMERATE_CHUNK,maxRows-rows);
        const chunk=read.all(below,want) as Array<Record<string,unknown>>;
        for(const row of chunk){
          const id=String(row.scope_id);
          let n=known.get(id);
          if(n===undefined){add.run(id);n=Number(scopeOf.get(id)!.n);known.set(id,n);}
          list.run(n,Number(row.seq));
          below=Number(row.seq);rows++;
        }
        if(chunk.length<want){dry=true;break;}
        if(performance.now()-started>=maxMs*STEP_SHARE)break;
      }
      if(dry)this.db.prepare("DELETE FROM index_meta WHERE key=?").run(POSTINGS_BELOW);
      else this.db.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run(POSTINGS_BELOW,String(below));
      this.endStep(true);
      return {rows,done:dry};
    }catch(error){try{this.endStep(false);}catch{/* the connection rolled it back */}throw error;}
  }
  /** Writes the postings of one scope's newest listed entries (an entry deleted since is just un-listed). */
  private fillScope(scope:number,maxMs:number,maxRows:number):number{
    const started=performance.now(),fill=postingFiller(this.db);
    this.beginStep();
    try {
      const read=this.db.prepare("SELECT t.seq AS seq,e.scope_id AS scope_id,e.text AS text FROM posting_todo t LEFT JOIN entries e ON e.rowid=t.seq WHERE t.scope=? ORDER BY t.seq DESC LIMIT ?");
      const unlist=this.db.prepare("DELETE FROM posting_todo WHERE scope=? AND seq=?");
      let filled=0,out=false;
      // a few entries at a time, so the clock is looked at between reads as well as between entries
      while(!out&&filled<maxRows){
        const rows=read.all(scope,Math.min(FILL_CHUNK,maxRows-filled));
        for(const row of rows){
          if(filled&&performance.now()-started>=maxMs*STEP_SHARE){out=true;break;}
          if(row.scope_id!==null&&row.scope_id!==undefined)fill(String(row.scope_id),String(row.text),Number(row.seq));
          unlist.run(scope,Number(row.seq));
          filled++;
        }
        if(rows.length<FILL_CHUNK)break;
      }
      this.endStep(true);
      return filled;
    }catch(error){try{this.endStep(false);}catch{/* the connection rolled it back */}throw error;}
  }
  /** Whether entries are still waiting for their postings. */
  postingsOwed():boolean{return this.postingsBelow()!==null||Boolean(this.db.prepare("SELECT 1 FROM posting_todo LIMIT 1").get());}
  upsert(records: IndexedMemory[]) {
    const forgetting=records.some(row=>row.deleted&&!row.rolled);
    let removed=false;
    // a record written again over its own key (an owner's edit, the 1.0.4 number scrub) leaves its old words in the FTS5 segments just as a
    // deletion does: it owes the same merge (PASTE-CAPTURE-FIX r2.6)
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for(const row of records){
        const previous=this.db.prepare("SELECT fts_rowid FROM lexical_keys WHERE id=? AND version=?").get(row.id,row.version);
        if(previous)removed=true;
        if(previous)this.db.prepare("DELETE FROM lexical WHERE rowid=?").run(previous.fts_rowid);
        this.db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?").run(row.id,row.version);
        if(this.ageTables){
          // the second word table (age-index.ts) is kept in step while the fill runs: one row per record there too, at its key
          const aged=this.db.prepare("SELECT fts_rowid FROM lexical_age_keys WHERE id=? AND version=?").get(row.id,row.version);
          if(aged)removed=true;
          if(aged)this.db.prepare("DELETE FROM lexical_age WHERE rowid=?").run(aged.fts_rowid);
          this.db.prepare("DELETE FROM lexical_age_keys WHERE id=? AND version=?").run(row.id,row.version);
        }
        if(this.db.prepare("DELETE FROM vectors WHERE id=? AND version=?").run(row.id,row.version).changes&&this.matrix){
          for(const [key,entry] of this.matrix.rows)if(entry.id===row.id&&entry.version===row.version)this.matrix.rows.delete(key);
        }
        if(row.deleted){const changed=this.db.prepare("DELETE FROM entries WHERE id=? AND version=?").run(row.id,row.version).changes;if(changed)removed=true;continue;}
        this.db.prepare("INSERT OR REPLACE INTO entries VALUES(?,?,?,?)").run(row.id,row.version,row.scopeId,row.text);
        const ageKey=typeof row.ageKey==="number"&&Number.isSafeInteger(row.ageKey)?row.ageKey:null;
        if(this.aged&&ageKey!==null)placeLexicalRow(this.db,"lexical",row.id,row.version,row.text,ageKey);
        else{
          // an automatic rowid: the preparing or filling index, or a record not keyed yet (the sweep moves it to its key later)
          const inserted=this.db.prepare("INSERT INTO lexical VALUES(?,?,?)").run(row.id,row.version,row.text);
          this.db.prepare("INSERT INTO lexical_keys VALUES(?,?,?)").run(row.id,row.version,inserted.lastInsertRowid);
          if(this.ageTables&&ageKey!==null)placeLexicalRow(this.db,"lexical_age",row.id,row.version,row.text,ageKey);
        }
      }
      // Every physical retirement advances the durable generation, including rollovers and rewrites.
      // A later forget of a rolled-out row therefore cannot reuse an older completed scrub.
      if(removed){this.setMergeOwed(true);this.bumpDeletionGeneration();}
      // An owner forget owes a scrub reaching this generation (its target), written with the removal: the durable debt the helper
      // drains on its own timer, so the batch is acknowledged at once (MEMDEL-SIMPLIFY-109). Rollovers advance the generation but
      // set no target, so they never restart a merge. Replaying an absent row neither advances the generation nor restarts a merge,
      // and a completed generation survives a lost acknowledgement, so replay can acknowledge without merging again.
      if(forgetting&&this.meta("delete_scrub_completed")!==String(this.scrubGeneration())){
        if(!this.deletionScrubPending())this.db.exec("INSERT OR REPLACE INTO index_meta VALUES('delete_scrub_owed','merge')");
        this.db.prepare("INSERT OR REPLACE INTO index_meta VALUES('delete_scrub_target',?)").run(String(this.scrubGeneration()));
      }
      this.db.exec("COMMIT");
    }catch(error){this.rollback();throw error;}
    // A deletion (a forget, or a rolled checkpoint version) leaves the index with its words still in the FTS5 segments until a
    // merge removes them, and secure_delete then zeroes the pages the merge frees. Owner forgets are scrubbed before the helper
    // acknowledges them (scrubDeleted). For rolled versions the stepped maintenance (purgeRolledCheckpoints) pays in short steps, never later than
    // MAINTENANCE_MAX_DEFER_MS under sustained load. (1.0.3 rehearsal 2: a whole-index merge and log truncation per batch with a
    // forget wrote about 47 MB per 16 deletions on the owner's index, 240 MB/min for as long as a drain queued deletions.)
    if(removed){this.purge.merging=true;this.deletionGen++;}
    // The old pages stay in the write-ahead log until it is checkpointed.
    this.checkpointIfLarge();
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
  /** Ends a failed transaction without hiding why it failed: SQLITE_FULL already rolled it back, so a second ROLLBACK would throw
   * "no transaction is active" in place of the real error. */
  private rollback(){try{this.db.exec("ROLLBACK");}catch{/* the engine rolled it back itself */}}
  maintenanceOwed():boolean{return this.purge.merging;}
  /** Segments the full-text index holds now (FTS5 refuses writes at FTS_SEGMENT_LIMIT). */
  segmentCount():number{
    // The count FTS5 itself checks is in its structure record (shadow-table row 10): 4-byte cookie, an optional 4-byte
    // version marker, then varints for levels and segments. (Counting lexical_idx misses small one-page segments.)
    const row=this.db.prepare("SELECT block FROM lexical_data WHERE id=10").get();
    const bytes=row?.block instanceof Uint8Array?row.block:null;
    if(bytes){
      let at=4;
      if(bytes[at]===0xff&&bytes[at+1]===0&&bytes[at+2]===0&&bytes[at+3]===1)at+=4;
      const varint=():number|null=>{let value=0;for(let n=0;n<8&&at<bytes.length;n++){const byte=bytes[at++];value=value*128+(byte&0x7f);if(!(byte&0x80))return value;}return null;};
      varint(); // levels
      const segments=varint();
      if(segments!==null)return segments;
    }
    return Number(this.db.prepare("SELECT count(DISTINCT segid) AS n FROM lexical_idx").get()!.n);
  }
  /** One-time compaction when the index holds many segments, for the helper (never the main thread): 'optimize' merges
   * them while there is room to write; at the limit no merge can open a segment, so the index is rebuilt from the stored
   * text (the rebuild discards every segment, deleted words included). Returns what ran. A high segment count is the only
   * trigger: a really full disk is left alone, since the rebuild needs room too. */
  recoverSegments():"none"|"optimize"|"rebuild"{
    const count=this.segmentCount();
    if(count<FTS_SEGMENT_COMPACT_AT)return "none";
    let ran:"optimize"|"rebuild"="rebuild";
    if(count<FTS_SEGMENT_LIMIT-100){
      try{this.db.exec("INSERT INTO lexical(lexical) VALUES('optimize')");ran="optimize";}
      catch(error){if(!isSegmentLimitError(error))throw error;}
    }
    if(ran==="rebuild")this.db.exec("INSERT INTO lexical(lexical) VALUES('rebuild')");
    // Either pays every merge debt, the stepped walk's included.
    this.purge.merging=false;this.purge.since=0;this.mergeStarted=false;this.setMergeOwed(false);
    try{this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");}catch{/* the next checkpoint takes it */}
    return ran;
  }
  /** The end of a one-time rewrite of the stored text (the 1.0.4 number scrub, scrub-pass.ts settle): one whole-index merge takes the
   * old words out of the FTS5 segments (secure_delete zeroes the pages it frees), the merge debt is paid, and the log is truncated. True
   * when the log was truncated too; false when a reader held it (the caller asks again). Never per batch (the 1.0.3 rehearsal cost). */
  finishRewrite():boolean{
    this.db.exec("INSERT INTO lexical(lexical) VALUES('optimize')");
    if(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='lexical_age'").get())this.db.exec("INSERT INTO lexical_age(lexical_age) VALUES('optimize')");
    this.purge.merging=false;this.purge.since=0;this.mergeStarted=false;this.setMergeOwed(false);
    // The metadata write belongs before the final checkpoint too. A blocked
    // checkpoint keeps a durable obligation for the next attempt or restart.
    if(!checkpointTruncate(this.db,"memory-rewrite",Number(this.db.prepare("PRAGMA busy_timeout").get()?.timeout??0))){
      this.setMergeOwed(true);this.purge.merging=true;return false;
    }
    return true;
  }
  /** Durable physical deletion debt, separate from ordinary stepped merges. No schema or FTS format change. */
  deletionScrubPending():boolean{return Boolean(this.db.prepare("SELECT 1 FROM index_meta WHERE key='delete_scrub_owed'").get());}
  /** Last step was blocked on a lock or reader, as opposed to making merge progress. */
  scrubBlocked=false;
  private meta(key:string):string|undefined{
    const row=this.db.prepare("SELECT value FROM index_meta WHERE key=?").get(key);
    return row?String(row.value):undefined;
  }
  private scrubGeneration():number{return Number(this.meta("delete_generation")??0);}
  /** The generation the newest owed forget needs a merge to reach (a marker without one needs the current generation). */
  private scrubTarget():number{return Number(this.meta("delete_scrub_target")??this.scrubGeneration());}
  private bumpDeletionGeneration():void{
    this.db.prepare("INSERT OR REPLACE INTO index_meta VALUES('delete_generation',?)").run(String(this.scrubGeneration()+1));
  }
  /** One committed FTS merge command, or one bounded checkpoint attempt. A negative page count opens
   * a merge over every existing segment; subsequent positive steps continue it. FTS5's <2-change
   * completion signal covers only the generation captured at that first step, never later deletes.
   * Progress and its generation commit together, so a restart resumes with a positive page count.
   * Only index_meta rows are added; older binaries can still open the FTS tables. */
  scrubDeleted():boolean{
    this.scrubBlocked=false;
    const owed=this.meta("delete_scrub_owed");
    if(!owed)return true;
    type Merge={generation:number;table:"lexical"|"lexical_age";started:boolean};
    const saved=this.meta("delete_scrub_merge");
    let merge:Merge=saved?JSON.parse(saved):{generation:this.scrubGeneration(),table:"lexical",started:false};
    // A legacy truncate marker has no generation proof. Start a bounded merge before acknowledging it.
    if(owed==='truncate'&&saved&&merge.generation>=this.scrubTarget()){
      if(!checkpointTruncate(this.db,"memory-delete",Number(this.db.prepare("PRAGMA busy_timeout").get()?.timeout??0))){
        this.scrubBlocked=true;return false;
      }
      // Only metadata is written after truncation; every page with retired text has already been drained.
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.db.prepare("INSERT OR REPLACE INTO index_meta VALUES('delete_scrub_completed',?)").run(String(merge.generation));
        this.db.exec("DELETE FROM index_meta WHERE key IN ('delete_scrub_owed','delete_scrub_merge','delete_scrub_target'); COMMIT");
      }catch(error){this.rollback();throw error;}
      return true;
    }
    if(owed==='truncate')merge={generation:this.scrubGeneration(),table:"lexical",started:false};
    try{
      this.beginStep();
      try{
        // No age cutover runs while scrub debt exists (worker.ts). A removed age table after an older
        // binary opened this file is handled by starting again against the current lexical table.
        if(merge.table==='lexical_age'&&!ageTablesPresent(this.db))merge={generation:this.scrubGeneration(),table:"lexical",started:false};
        // Merge starts are counted (diagnostics; tests): one start covers every row removed before it.
        if(!merge.started&&merge.table==='lexical')this.db.prepare("INSERT OR REPLACE INTO index_meta VALUES('delete_scrub_merges',?)").run(String(Number(this.meta("delete_scrub_merges")??0)+1));
        const before=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n);
        this.db.prepare(`INSERT INTO ${merge.table}(${merge.table},rank) VALUES('merge',?)`).run(merge.started?DELETE_SCRUB_MERGE_PAGES:-DELETE_SCRUB_MERGE_PAGES);
        const done=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n)-before<2;
        merge.started=true;
        let phase='merge';
        if(done){
          if(merge.table==='lexical'&&ageTablesPresent(this.db))merge={...merge,table:"lexical_age",started:false};
          // A forget removed after this merge began needs one more; rollovers since then do not.
          else if(merge.generation<this.scrubTarget())merge={generation:this.scrubGeneration(),table:"lexical",started:false};
          else phase='truncate';
        }
        this.db.prepare("INSERT OR REPLACE INTO index_meta VALUES('delete_scrub_merge',?)").run(JSON.stringify(merge));
        this.db.prepare("INSERT OR REPLACE INTO index_meta VALUES('delete_scrub_owed',?)").run(phase);
        // Rollovers removed after this merge began stay owed to the stepped maintenance.
        const settled=phase==='truncate'&&merge.generation===this.scrubGeneration();
        if(settled)this.setMergeOwed(false);
        this.endStep(true);
        // Ordinary maintenance must not continue a merge state superseded by this run.
        this.mergeStarted=false;
        if(settled){this.purge.merging=false;this.purge.since=0;}
      }catch(error){try{this.endStep(false);}catch{/* already rolled back */}throw error;}
    }catch(error){
      if(/database is locked|SQLITE_BUSY/i.test(error instanceof Error?error.message:String(error))){this.scrubBlocked=true;return false;}
      throw error;
    }
    return false;
  }
  /** Whether the current merge run has opened its incremental merge (the first step is negative, the rest continue it). */
  private mergeStarted=false;
  /** Rolled deletions recorded so far, and the count when the current merge opened. A deletion that arrives mid-merge writes a
   * new small segment that positive merge steps may never touch (FTS5 merges a level only once it has enough segments). */
  private deletionGen=0;
  private mergeGen=0;
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
        const before=removed;
        const rowids=this.db.prepare("SELECT fts_rowid FROM lexical_keys WHERE id IN (SELECT value FROM json_each(?))").all(chunk);
        for(const row of rowids)this.db.prepare("DELETE FROM lexical WHERE rowid=?").run(row.fts_rowid);
        removed+=rowids.length;
        this.db.prepare("DELETE FROM lexical_keys WHERE id IN (SELECT value FROM json_each(?))").run(chunk);
        removed+=Number(this.db.prepare("DELETE FROM entries WHERE id IN (SELECT value FROM json_each(?))").run(chunk).changes);
        removed+=Number(this.db.prepare("DELETE FROM vectors WHERE id IN (SELECT value FROM json_each(?))").run(chunk).changes);
        // Deleted words stay in FTS5 segments until merged: the debt is written with the deletion, not after it.
        if(removed>before){this.setMergeOwed(true);this.bumpDeletionGeneration();}
        this.db.exec("COMMIT");
      }catch(error){this.rollback();throw error;}
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
    // The deletion scrub owns both word tables until its generation is checkpointed.
    // Direct maintenance callers still make one bounded step; pending debt is never a completed pass.
    if(this.deletionScrubPending())return {removed:0,examined:0,merged:false,done:this.scrubDeleted()&&this.purge.cursor===null};
    if(this.purge.merging){
      const before=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n);
      // A negative count starts the incremental merge; repeating it opens a fresh output segment each step until FTS5's
      // 2,000-segment limit, so every later step is positive and continues the merge in progress.
      if(!this.mergeStarted)this.mergeGen=this.deletionGen;
      this.db.exec(`INSERT INTO lexical(lexical,rank) VALUES('merge',${this.mergeStarted?mergePages:-mergePages})`);
      this.mergeStarted=true;
      // FTS5: fewer than two changes means the merge found nothing left to merge.
      if(Number(this.db.prepare("SELECT total_changes() AS n").get()!.n)-before>=2)return {removed:0,examined:0,merged:true,done:false};
      // A deletion rolled after this merge opened may sit in a segment the positive steps left alone: the debt stays owed and
      // the merge opens again (one negative step, covering every segment), until a merge finishes with no newer deletion.
      if(this.deletionGen!==this.mergeGen){this.mergeStarted=false;return {removed:0,examined:0,merged:true,done:false};}
      this.purge.merging=false;this.mergeStarted=false;this.setMergeOwed(false);
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
      if(removedKeys.length){this.setMergeOwed(true);this.bumpDeletionGeneration();}
      this.db.exec("COMMIT");
    }catch(error){this.rollback();throw error;}
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
