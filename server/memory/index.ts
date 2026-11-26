import { helperEnforced, helperHasGrant, setAdmissionPurpose, withHelperBoot } from "./helper-admission.ts";
import { runtimeStepWalBytes, runtimeMergeWalBytes } from "./index-wal.ts";
import { BgDeferred, isBgDeferred } from "../bg-admission.ts";
import { secureDeleteFts } from './fts-delete.ts';
import { isMemoryOverviewQuery } from "./relevance.ts";
import { SEARCH_LIST_DEPTH, UNVECTORED_LIMIT, type RankedRef } from "./worker-protocol.ts";
import { byScore, compareRefs } from "./ref-order.ts";
import { DatabaseSync } from "../sqlite-open.ts";
import { pageByRank } from "./rank-ties.ts";
import { lstatSync, existsSync, statSync } from "node:fs";
import { prepareIndexOpen, probeIndexFile, quarantineIndex, quarantineIndexAny, removeIndexQuarantines, stopMarkerPresent } from "./index-quarantine.ts";
/** r3.2.8d D4: resumes of a pending open at an R start (1 + 3 attempts at CHARGE_ACK_MS each, far inside the helper's init window). */
export const OPEN_RESUME_ATTEMPTS = 3;
import { MEMW_POSTING_TERM_INLINE_BYTES, oversizeTerms, POSTINGS_BELOW, POSTINGS_SCHEMA, POSTINGS_TODO_UPGRADE, POSTINGS_TRIGGERS_KEY, postingFiller, wordTerms } from "./postings.ts";
import { scratchFrames, stepPrice } from "./postings-steps.ts";
import { runtimeMergePages, OVERRUN_K_UNKNOWN, frameBytes, MergePredictor, mergeRoute, gateHoldMayMerge, MEMW_CALL_MS, MEMW_STEP_MAX_ROWS, WAL_HEADER_BYTES, formGroup, GroupClock, MEMW_R_W, MEMW_F_INS_FRAMES, MEMW_SEGMENT_GATE, memwLines, MEMW_KEYS_MAX_ROWS, MEMW_MERGE_PAGES, MEMW_OPEN_RESERVE, MEMW_R_D, MEMW_F_DEL_FRAMES, MEMW_ROW_BYTES, overrunK, rowX, segmentGateOpen, StepSizer, structureMergePages, structureSegments, unitCost, writesOf, type AdmitKind, type GroupUnit, type IndexWriter } from "./memw-steps.ts";
export * from "./memw-steps.ts";
import { checkpointCeiling, commitCeiling, ioMeterPageSize } from "../io-meter.ts";
import { META_ENVELOPE_FRAMES, metaPutter, openIndexWal, walTestHooks, WalStop, type ChargeTransport, type ExitSealOutcome, type IndexWalWriter, type OpenedIndexWal, type StopKind, type WalKind } from "./index-wal.ts";
export type { ChargeTransport } from "./index-wal.ts";
/** The stop a helper reports in `initialised` and live (spec 4). */
export interface IndexStopInfo{fileId:string;seq:number;kind:StopKind;reason:string}

/** A write-ahead log over this size is checkpointed after the batch that grew it, and scans wait for that (index-reader.ts). */
export const WAL_DRAIN_BYTES = 24 * 1024 * 1024; // r20 D9(a)
/** How long opening the index waits for another connection's lock or WAL recovery before the start fails (and is retried). */
export const INDEX_OPEN_BUSY_MS = 5_000;
const WALK_CHUNK = 64; // rolled-checkpoint purge: rows read per select, so a step pays for the rows it consumes
/** One FTS command per scrub turn, including when the age table is present. */
export const DELETE_SCRUB_MERGE_PAGES = MEMW_MERGE_PAGES; // N 64 for MEMW merges (1.1)
export function walBytes(path: string): number { try { return statSync(`${path}-wal`).size; } catch { return 0; } }

/** `rolled`: a deletion that only retires an old checkpoint version (its words re-quote sources that stay indexed), as against
 * a forget. Both leave the word index through the stepped maintenance (upsert owes it the merge). */
/** `ageKey`: the record's age key (schema.ts RECORD_KEYS_SCHEMA), the rowid its FTS row takes once the index is in age order (age-index.ts);
 * null for a record not keyed yet (an index in its preparing mode, or an older binary's write). */
export interface IndexedMemory {id:string;version:number;scopeId:string;text:string;deleted:boolean;archived?:boolean;rolled?:boolean;ageKey?:number|null}
export interface IndexHit {id:string;version:number;score:number;similarity?:number;lexical?:boolean}
export { byScore, compareRefs };
import { FTS_SEGMENT_LIMIT,isSegmentLimitError } from "./segment-limit.ts";
import { walFrameReader } from "../io-written.ts";
import { ageDeleteRecord, ageInsertRecord, ageObjectsPresent, agePhase, agePurgeBegin, ageStep, ageTablesPresent, isAgeBlocked, lexicalGeneration, lexicalRowidsAged, markFreshIndexAgedInTxn, nextScrubTable, noteAgeBlocked, placeLexicalRow, sweepAgeRowidsStep, type AgeStepResult } from "./age-index.ts"; // WP2b
export { isSegmentLimitError };
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
/** Pages a dual write adds beyond the words: three small b-trees (key, or stage and emap), one leaf plus at most one split each (WP2b D5, ruling 1). */
const AGE_MAP_FRAMES=9;
/** Ruling 2(c): the copy still in lexical_retired is one FTS row delete (R_d x (id + its text + a row), the row term retireStep sizes) plus a key row (F_del frames). */
/** Ruling 2(d): postings pages one unit dirties: its distinct terms (old and new), one eighth more for splits and merges, and one parent chain. */
export const postingsCost=(postFrames:number,pageSize:number):number=>(postFrames+Math.ceil(postFrames/8)+4)*frameBytes(pageSize);
const retiredCost=(copy:{n:number|bigint}|undefined,id:string,pageSize:number):number=>copy?MEMW_R_D*(Buffer.byteLength(id)+Number(copy.n)+MEMW_ROW_BYTES)+MEMW_F_DEL_FRAMES*frameBytes(pageSize):0;
const FILL_CHUNK=16;
/** r4.1 Q6: a listed (scope, seq) that still has debt parts is skipped by every fill picker (it stays listed, so readers keep `owed`). */
const NOT_IN_DEBT="NOT EXISTS(SELECT 1 FROM posting_drop d WHERE d.seq=t.seq AND d.scope=t.scope)";

const ENTRIES_LIVE="entries_live",ENTRIES_RECOUNT="entries_live_recount";
/** Rows one recount step counts (R4). */
export const ENTRIES_RECOUNT_ROWS=4096;
const OVERRUN_KINDS:readonly AdmitKind[]=["group","fill","keys","stage_drop","delete","merge","tier"];
const ALL_WAL_KINDS:readonly WalKind[]=["group","fill","keys","stage_drop","delete","merge","tier","seal","open","stop"];
/** What the resident vectors may hold (Float32 values only): about 43,000 vectors of 384 dimensions. Over it the rest is read per search.
 * Mutable only so tests can stand a small limit in for a large memory. */
export const residentVectorLimits={bytes:64*1024*1024};
/** Records written between two searches beyond this drop the resident set whole (it is loaded again at the next search). */
const RESIDENT_DIRTY_LIMIT=16384;
export class MemoryIndex {
  private db!: DatabaseSync;
  private readonly path: string;
  private readonly keepGoing:()=>boolean;
  private allowedKeys=new WeakMap<object,string>();
  /** q1022 recallperf item 4: the vectors of one model kept resident, so a search scores them without reading SQLite. Keyed by the
   * file's version: a commit by another connection (PRAGMA data_version) drops it whole, and every vector insert, update or delete on
   * this connection (any path: forget, purge, age sweep, model change) names its record through a connection-local temp trigger, so the
   * record is read again before the next search scores anything: a forgotten vector is never scored from memory. Bounded by
   * residentVectorLimits.bytes; a record that does not fit is read from the table for that search, as before, never skipped. */
  private resident:{model:string;dataVersion:number;bytes:number;complete:boolean;rows:Map<string,Float32Array[]>}|null=null;
  private residentDirty=new Set<string>();
  private residentHooked:DatabaseSync|null=null;
  /** True when this file was made new by this open (absent, damaged and set aside, or replaced by a reset). */
  rebuilt=false;
  /** The log-frame reader. Owned here (WIN-IOB-QUICK note rev 3): created after the final successful open of this path, before the first
   * write, and closed only after that handle's db.close(), so no descriptor on the shm is opened or closed by code that does not own the handle. */
  private wal:ReturnType<typeof walFrameReader>|null=null;
  private closeAll:()=>void=()=>{};
  /** The helper's open (spec 4): open rule steps 0-2 (openIndexWal), then init(): the rule's charged check, the `open` txn(s), the seal.
   * Nothing is written to the file before the rule returns writable; a refused or unanswered charge leaves the open pending and
   * maintenanceStep() tries again (T14e(i)). */
  static async create(path:string,opts:{charge:ChargeTransport;reset?:{resetId:number;resets:number;kind:WalKind|"unknown"};keepGoing?:()=>boolean}):Promise<MemoryIndex>{
    // r3.2.8 3.2 step 2, trigger A, before any SQLite open: a start that carries R finds the stop marker beside a main file: the whole set
    // goes aside under the default `.corrupt-<now>` name (the marker stays at its live name). A move that fails exits(1) with no open.
    // r3.2.8-H.1 7 (A') and H.2 1: both triggers first run the read-only probe (synchronous, no await, nothing is opened for writing).
    //   holds-R : the file is this reset's fresh file: no move, ignoreMarker, rebuilt (every record stays owed).
    //   unsafe  : a link or non-regular member anywhere in the set: quarantineIndexAny moves the members of any type (never the target).
    //   busy    : kind "open" only: exit(1), no move (R stays requested under the controller's backoff). Trigger A keeps today's behaviour.
    //   damaged : prepareIndexOpen, then the set goes aside.   absent / healthy: kind "open" does not move; trigger A moves as today.
    let holdsR=false;
    if(opts.reset){
      const markerMain=stopMarkerPresent(path)&&existsSync(path);
      if(opts.reset.kind==="open"||markerMain){
        const probe=probeIndexFile(path,opts.reset.resetId);
        const failed=(message:string):never=>{console.error(`MEMORY_INDEX_RESET_SETASIDE_FAILED reset=${opts.reset!.resetId}: ${message}`);if(walTestHooks.exit)return walTestHooks.exit(1);process.exit(1);};
        if(probe==="holds-R")holdsR=true;
        else if(probe==="unsafe"){
          try{quarantineIndexAny(path);}catch(error){return failed((error as Error).message);}
        }else if(opts.reset.kind==="open"&&probe==="busy")return failed("index file busy");
        else if(markerMain&&probe!=="absent"){
          try{prepareIndexOpen(path);quarantineIndex(path);}catch(error){return failed((error as Error).message);}
        }else if(probe==="damaged"){
          try{prepareIndexOpen(path);quarantineIndexAny(path);}catch(error){return failed((error as Error).message);}
        }
      }
    }
    const index=withHelperBoot(()=>new MemoryIndex(path,{...opts,...holdsR?{holdsR:true}:{}}));
    try {
      await index.init();
      // r3.2.8d D4: an R start does not report `initialised` while a refused or unanswered open charge leaves the open pending; init() is
      // the idempotent resume (each attempt waits for the charge answer or its own timeout). A persistent refusal returns pending and
      // r3.2.8 3.1.6's failed start applies.
      if(opts.reset)for(let attempt=0;attempt<OPEN_RESUME_ATTEMPTS&&index.openState==="pending"&&index.keepGoing();attempt++)await index.init();
    }
    catch (error) { if(isBgDeferred(error))return index;index.close(); throw error; }
    return index;
  }
  constructor(path: string, opts:{charge:ChargeTransport;reset?:{resetId:number;resets:number;kind:WalKind|"unknown"};holdsR?:boolean;keepGoing?:()=>boolean}) {
    this.path=path;
    this.keepGoing=opts.keepGoing??(()=>true);
    // holdsR (H.2 1): the main file is this reset's own fresh file, kept as is; every record stays owed, as for a new file.
    const rebuilt=!existsSync(path)||opts.holdsR===true;
    // `this.reset` is set before any open: the open txn writes reset_done = R and overrun_k (writeReset).
    this.reset=opts.reset??null;
    if(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()))throw new Error("UNSAFE_MEMORY_INDEX");
    // I3 order, A16 damaged path, pragmas, file_id, the stop: all in the WAL core, which exits (no close) on any failure before the rule.
    // Sample committed frames before every charged checkpoint, including seals.
    // H.1 1: `opening` is true while the open is pending (the open check, every `open` txn check, the open's seal and TRUNCATE) and false after.
    this.charge=charge=>{this.ioBytes();return opts.charge({...charge,opening:this.openState==="pending"} as typeof charge);};
    // 3.2 step 3: with R and the marker still present (the main file is now absent) the fresh file opens with ignoreMarker; with R and a
    // stopped verdict and no marker the core takes trigger B (its damaged-file branch).
    const withReset=opts.reset!==undefined;
    this.attach(openIndexWal(path,{charge:this.charge,...withReset?{reset:true,ignoreMarker:stopMarkerPresent(path)&&(!existsSync(path)||opts.holdsR===true)}:{}}),rebuilt);
  }
  /** The commit path (memw-steps.ts IndexWriter): the WAL core's checked write. */
  private writer!:IndexWriter;
  /** The WAL core. */
  private core:IndexWalWriter|null=null;
  /** pending: the open rule or the `open` txn has not passed yet (nothing written, batches answered check-owed); open; stopped. */
  private openState:"pending"|"open"|"stopped"="pending";
  private openComplete=false;
  private firstOpenTxnDone=false;
  /** The owed check, if any. True when the writer may write next (no check owed, not stopped). An OVERRUN is the durable stop. */
  private async settle():Promise<boolean>{
    try{if(this.writer.checkOwed())await this.writer.check();}
    catch(error){if(!(error instanceof WalStop))throw error;}
    if(this.writer.stopped)this.openState="stopped";
    return !this.writer.stopped&&!this.writer.checkOwed();
  }
  /** Runs (or resumes) the open: the rule's charged check (1.3 steps 3-9), each `open` txn checked (step 10), then sealAndTruncate
   * (replaces the old TRUNCATE before traffic), then the scrub resume and the quarantine sweep. Returns with the open still pending when
   * a charge is refused or unanswered; maintenanceStep() calls it again. Idempotent once open or stopped. */
  async init():Promise<void>{
    if(this.openState!=="pending")return;
    for(;;){
      if(!(await this.settle())||!this.keepGoing())return;
      if(this.openComplete)break;
      try{this.openComplete=this.openStep();}catch(error){if(isBgDeferred(error))return;throw error;}
      if(!this.firstOpenTxnDone){this.firstOpenTxnDone=true;(walTestHooks as {afterFirstOpenTxn?:()=>void}).afterFirstOpenTxn?.();}
    }
    this.reset=null; // written by the open txn
    try{await this.writer.sealAndTruncate();}catch(error){if(!(error instanceof WalStop))throw error;}
    if(this.writer.stopped){this.openState="stopped";return;}
    this.afterOpen();
    this.openState="open";
    if(this.keepGoing()&&this.scrubResumeOwed()){
      try{await this.scrubDeleted();}catch{/* the durable debt and pending receipts remain */}
      if(this.writer.stopped){this.openState="stopped";return;}
    }
    removeIndexQuarantines(this.path);
  }
  /** Seal and TRUNCATE before the worker sends its last receipt. */
  prepareExit():Promise<ExitSealOutcome>{return this.writer.prepareExit();}
  private charge:ChargeTransport|null=null;
  /** Files attached so far (a reset or a local reset attaches a new one). */
  private attachCount=0;
  /** Takes a file opened by the WAL core (steps 0-2) with every in-memory state fresh: a reset's new file starts from nothing. */
  private attach(opened:OpenedIndexWal,rebuilt:boolean):void{
    const core=opened.wal as IndexWalWriter;
    this.db=opened.writable;this.rebuilt=rebuilt||opened.rebuilt;this.core=core;this.writer=core;
    this.sizer=new StepSizer(core.pageSize,kind=>overrunK(this.meta(`overrun_k:${kind}`)));
    this.predictor=this.newPredictor(core.pageSize);
    this.groupClock=new GroupClock();
    this.tierSealOwed=false;this.tierWait=false;
    this.resident=null;this.residentDirty.clear();this.residentHooked=null;this.allowedKeys=new WeakMap();
    this.purge={cursor:null,live:null,since:0,merging:false,mergeAt:1000,oldest:null};this.mergeStarted=false;this.deletionGen=0;this.mergeGen=0;
    this.aged=false;this.ageTables=false;this.openComplete=false;this.scrubBlocked=false;
    const reader=walFrameReader(this.path);this.wal=reader;this.attachCount++;
    // The permitted close (tests, quarantine, reset): guard first, then writable (A16 / OPEN-8), then the frame reader.
    let closed=false;
    this.closeAll=()=>{
      if(closed)return;
      try{core.closeForQuarantine();}
      catch(error){
        // A retry may find the guard already closed by the first failed close.
        if(this.db.isOpen||(error as {code?:string}).code!=="ERR_INVALID_STATE")throw error;
      }
      reader.close();
      closed=true;
    };
    this.openState=core.stopped?"stopped":"pending";
  }
  /** The durable stop this file holds (1.7), as `initialised` and `index-stop` report it; null while writable. */
  stopInfo():IndexStopInfo|null{
    const stop=this.core?.stopInfo();
    return stop&&this.core?{fileId:this.core.fileId.toString(),seq:stop.seq,kind:stop.kind,reason:stop.reason}:null;
  }
  /** index_meta reset_done (1.13 (2),(3)): the last reset this file completed; null when none or not readable yet. */
  resetDone():number|null{
    try{const v=this.meta("reset_done");return v!==undefined&&/^\d+$/.test(v)?Number(v):null;}catch{return null;}
  }
  /** r3.2.8 section 8 (WP2a): there is no live reset. A reset is a helper restart that carries R (create({charge, reset}), 3.2): trigger A
   * before any open, ignoreMarker for the fresh file, trigger B in the core; the open txn writes reset_done = R and overrun_k. */
  /** kind "unknown" (spec 13626e11): every kind at OVERRUN_K_UNKNOWN in the same txn (fail closed). */
  private writeReset(meta:(k:string,v:string)=>void):void{
    if(!this.reset)return;
    if(this.reset.kind==="unknown")for(const kind of ALL_WAL_KINDS)meta(`overrun_k:${kind}`,String(OVERRUN_K_UNKNOWN));
    else meta(`overrun_k:${this.reset.kind}`,String(this.reset.resets));
    meta("reset_done",String(this.reset.resetId));
  }
  private writeResetIfAdmitted():boolean{
    if(!this.reset||this.openState!=="open"||!this.writer.admit("open",Math.min(MEMW_OPEN_RESERVE,runtimeStepWalBytes())))return false;
    this.writer.write("open",Math.min(MEMW_OPEN_RESERVE,runtimeStepWalBytes()),meta=>this.writeReset(meta));
    this.reset=null;
    return true;
  }
  /** The seal and TRUNCATE (1.10), for the helper's checkpoint messages and the 8 MiB tick. Never while the open is pending. */
  async sealAndTruncate():Promise<{truncated:boolean}>{
    if(this.openState!=="open")return {truncated:false};
    try{return await this.writer.sealAndTruncate();}
    catch(error){if(error instanceof WalStop){this.openState="stopped";return {truncated:false};}throw error;}
  }
  /** Whether the open passed (create() path: the rule returned writable and the `open` txn committed and was checked). */
  opened():boolean{return this.openState==="open";}
  /** The checked writer's state, for the helper's gate on its own background writes (worker.ts fillAgeIndex). */
  writerStopped():boolean{return this.writer.stopped;}
  writerCheckOwed():boolean{return this.writer.checkOwed();}
  /** This file's id (index_meta file_id; the charge and io reports carry it). */
  get fileId():string{return this.core?this.core.fileId.toString():"";}
  /** State read once the `open` txn has committed. */
  private afterOpen():void{
    this.aged=lexicalRowidsAged(this.db);
    this.ageTables=!this.aged&&ageTablesPresent(this.db);
    // A merge owed when the app last stopped is still owed: the obligation lives in this file, not in memory.
    this.purge.merging=Boolean(this.db.prepare("SELECT 1 FROM index_meta WHERE key='merge_owed' AND value='1'").get());
    // An inherited merge debt cannot prove that the checkpoint walk reached its end.
    if(this.purge.merging)this.purge.cursor={id:"checkpoint:",version:-1};
  }
  /** Resume a completed scrub's checkpoint. A legacy marker without a generation takes at most one merge step here; all remaining
   * work stays owed to the worker. */
  private scrubResumeOwed():boolean{return Boolean(this.db.prepare("SELECT 1 FROM index_meta WHERE key='delete_scrub_owed' AND value='truncate'").get());}
  private sizer!:StepSizer;
  private groupClock=new GroupClock();
  private reset:{resetId:number;resets:number;kind:WalKind|"unknown"}|null=null;
  private hasTable(name:string):boolean{return Boolean(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));}
  /** One `open` txn: schema, lexical_keys backfill or its next step (A8; M-B marks a whole 1.0.17 table complete), the fresh-index age mark,
   * postings creation, FTS automerge=0/crisismerge=1999, overrun_k defaults (then a reset's real value), the entries_live seed. True when
   * the open work is complete. */
  private openStep():boolean{
    const db=this.db;
    return this.writer.write("open",Math.min(MEMW_OPEN_RESERVE,runtimeStepWalBytes()),meta=>{
      db.exec(`CREATE TABLE IF NOT EXISTS entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
        CREATE VIRTUAL TABLE IF NOT EXISTS lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
        CREATE TABLE IF NOT EXISTS vectors(id TEXT NOT NULL,version INTEGER NOT NULL,model TEXT NOT NULL,part INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(id,version,model,part));
        CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;`);
      secureDeleteFts(db,"lexical");
      // H.1 7: reset_done = R and overrun_k are written by the FIRST open txn (before the lexical_keys steps), so a kill anywhere after it
      // finds a file that holds R; the later steps leave them as written (the overrun_k defaults below only fill an absent key).
      this.writeReset(meta);
      if(!this.hasTable("lexical_keys")){
        db.exec("CREATE TABLE lexical_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version))");
        meta("lexical_keys_cursor","0");
      }else if(this.meta("lexical_keys_complete")!=="1"&&this.meta("lexical_keys_cursor")===undefined)meta("lexical_keys_complete","1");
      const cursor=this.meta("lexical_keys_cursor");
      if(cursor!==undefined){
        const rows=db.prepare("SELECT rowid AS r,id,CAST(version AS INTEGER) AS v FROM lexical WHERE rowid>? ORDER BY rowid LIMIT ?").all(Number(cursor),MEMW_KEYS_MAX_ROWS+1) as Array<{r:number;id:string;v:number}>;
        const step=this.sizer.take("keys",rows.slice(0,MEMW_KEYS_MAX_ROWS),row=>rowX({id:String(row.id)},true));
        const insert=db.prepare("INSERT INTO lexical_keys VALUES(?,?,?)");
        for(const row of step.rows)insert.run(String(row.id),Number(row.v),Number(row.r));
        this.sizer.record("keys",{x:step.x,rows:step.rows.length,rise:0,ms:0});
        if(step.rows.length<rows.length){meta("lexical_keys_cursor",String(step.rows.at(-1)!.r));return false;}
        db.prepare("DELETE FROM index_meta WHERE key='lexical_keys_cursor'").run();
        meta("lexical_keys_complete","1");
      }
      if(!this.seedTextStep(meta))return false;
      markFreshIndexAgedInTxn(db);
      if(!this.hasTable("postings")){
        db.exec(POSTINGS_SCHEMA);
        const top=db.prepare("SELECT max(rowid) AS n FROM entries").get()?.n;
        if(top!==null&&top!==undefined)meta(POSTINGS_BELOW,String(Number(top)+1));
        meta(POSTINGS_TRIGGERS_KEY,"2");
      }else if(!this.hasTable("posting_todo")||this.meta(POSTINGS_TRIGGERS_KEY)!=="2"){
        // r4.1 R7: posting_drop and all four triggers, gated; independent of whether posting_todo exists. Schema pages only.
        db.exec(POSTINGS_TODO_UPGRADE);
        meta(POSTINGS_TRIGGERS_KEY,"2");
      }
      for(const table of ["lexical","lexical_age","lexical_retired"].filter(t=>t==="lexical"||this.hasTable(t))){
        db.exec(`INSERT INTO ${table}(${table},rank) VALUES('automerge',0)`);
        db.exec(`INSERT INTO ${table}(${table},rank) VALUES('crisismerge',1999)`);
      }
      for(const kind of OVERRUN_KINDS)if(this.meta(`overrun_k:${kind}`)===undefined)meta(`overrun_k:${kind}`,"0");
      if(this.meta(ENTRIES_LIVE)===undefined||!/^\d+$/.test(this.meta(ENTRIES_LIVE)!))this.startRecount(meta);
      return true;
    });
  }
  // R4: entries_live, updated in the same txn as every entries change. Absent or bad: rebuilt by a bounded stepped recount; while the
  // recount runs, a change counts only at rowid <= the recount cursor (rows above it are counted when the cursor gets there).
  private startRecount(meta:(k:string,v:string)=>void):void{
    if(!this.db.prepare("SELECT 1 FROM entries LIMIT 1").get()){meta(ENTRIES_LIVE,"0");this.db.prepare("DELETE FROM index_meta WHERE key=?").run(ENTRIES_RECOUNT);return;}
    meta(ENTRIES_LIVE,"0");meta(ENTRIES_RECOUNT,"0");
  }
  private recountCursor():number|null{const v=this.meta(ENTRIES_RECOUNT);return v===undefined?null:Number(v);}
  /** Inside a txn: one entries row added (+1) or removed (-1) at `rowid`. */
  private countEntry(delta:1|-1,rowid:number):void{
    const cursor=this.recountCursor();
    if(cursor!==null&&rowid>cursor)return;
    const live=Number(this.meta(ENTRIES_LIVE)??0)+delta;
    metaPutter(this.db)(ENTRIES_LIVE,String(Math.max(0,live)));
  }
  /** The counter (R4). Never a scan: a recount in progress returns what it has counted so far plus nothing above its cursor. */
  entriesLive():number{return Number(this.meta(ENTRIES_LIVE)??0);}
  entriesRecounting():boolean{return this.recountCursor()!==null;}
  /** One bounded recount step (ENTRIES_RECOUNT_ROWS rows by rowid). True when the counter is whole. */
  async recountStep():Promise<boolean>{
    if(this.recountCursor()===null)return true;
    if(!(await this.settle()))return false;
    const done=this.recountWrite();
    await this.settle();
    return done;
  }
  private recountWrite():boolean{
    const cursor=this.recountCursor();
    if(cursor===null)return true;
    return this.writer.write("delete",runtimeStepWalBytes(),meta=>{
      const rows=this.db.prepare("SELECT rowid AS r FROM entries WHERE rowid>? ORDER BY rowid LIMIT ?").all(cursor,ENTRIES_RECOUNT_ROWS) as Array<{r:number}>;
      meta(ENTRIES_LIVE,String(this.entriesLive()+rows.length));
      if(rows.length<ENTRIES_RECOUNT_ROWS){this.db.prepare("DELETE FROM index_meta WHERE key=?").run(ENTRIES_RECOUNT);return true;}
      meta(ENTRIES_RECOUNT,String(rows.at(-1)!.r));return false;
    });
  }
  /** Fail closed (R4): a counter found out of step is never trusted; the bounded recount rebuilds it. */
  async distrustEntriesLive():Promise<void>{
    if(!(await this.settle()))throw new Error("MEMORY_INDEX_CHECK_OWED");
    this.writer.write("delete",runtimeStepWalBytes(),meta=>this.startRecount(meta));
    await this.settle();
  }
  /** Whether `lexical` holds every row at its age key (age-index.ts), and whether the second word table exists (the fill is under way). */
  private aged=false;
  private ageTables=false;
  /** Whether the word table still has to be put in age order (the helper runs fillAgeIndex until it is). */
  ageFillOwed():boolean{return !this.aged||agePhase(this.db)!==null;} // WP2b: until retirement ends
  lexicalGeneration():number{return lexicalGeneration(this.db);}
  /** One slice of the age fill, or the cutover when the walk has ended (age-index.ts fillAgeIndexStep). `authority`: a read-only
   * handle on the main database (the key table). Never on the main thread. */
  fillAgeIndex(authority:DatabaseSync,options:{maxKeys?:number;maxMs?:number;freeBytes?:()=>number|null}={}):AgeStepResult{ // WP2b: one staged step (D0-D8); the caller awaits the check
    const step=ageStep({db:this.db,writer:this.writer,sizer:this.sizer,authority,freeBytes:options.freeBytes,maxKeys:options.maxKeys,countEntry:(d,r)=>this.countEntry(d,r)});
    this.aged=lexicalRowidsAged(this.db);this.ageTables=!this.aged&&ageTablesPresent(this.db);
    return step;
  }
  /** One slice of the post-cutover sweep (age-index.ts sweepAgeRowidsStep). */
  sweepAgeRowids(authority:DatabaseSync,options:{maxRows?:number}={}):ReturnType<typeof sweepAgeRowidsStep>{return sweepAgeRowidsStep(this.db,this.writer,authority,options);} // WP2b
  /** Scopes readers asked about, most recent first (at most WANTED_SCOPES): their backfill goes first. */
  private wanted:string[]=[];
  private turn=0;
  private cursor=0;
  // One caller-sized round-robin slice can span several bounded WAL writes.
  // Advancing on each physical prefix lets unrelated scopes overtake a slice
  // that used to fit in one transaction. The state is two bounded integers.
  private roundScope:number|null=null;
  private roundRemaining=0;
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
  async fillPostings(options:{maxMs?:number;maxRows?:number}={}):Promise<{done:boolean;filled:number;busy?:true;drain?:true}>{
    if(!(await this.settle()))return {done:false,filled:0,busy:true};
    const started=performance.now(),maxRows=Math.max(1,options.maxRows??256),maxMs=options.maxMs??10;
    let total=0,scope:number|undefined;
    for(;;){
      const step=this.postingsWrite({...options,maxRows:maxRows-total},scope);
      await this.settle();
      total+=step.filled;
      scope=step.scope;
      if(scope===undefined||step.filled===0||step.busy||step.drain||step.done||total>=maxRows||performance.now()-started>=maxMs*STEP_SHARE){
        return {done:step.done,filled:total,...step.busy?{busy:true as const}:{},...step.drain?{drain:true as const}:{}};
      }
      // One caller-sized slice stays on its chosen scope. Every physical
      // prefix still has its own WAL admission, commit and charged check.
    }
  }
  private postingsWrite(options:{maxMs?:number;maxRows?:number},chosenScope?:number):{done:boolean;filled:number;scope?:number;busy?:true;drain?:true}{
    const maxMs=options.maxMs??10,maxRows=Math.max(1,options.maxRows??256);
    try {
      const enumerating=this.postingsBelow()!==null;
      // A continued physical prefix belongs to the same demand/background turn.
      const fillTurn=chosenScope===undefined&&this.turn++%2===0;
      // While enumerating, every other step is a fill of a scope a reader asked about (when one has anything listed); afterwards the
      // steps alternate between those scopes and the others in turn.
      let scope:number|null;
      if(chosenScope!==undefined)scope=chosenScope;
      else if(enumerating)scope=fillTurn?this.wantedWithTodo():null;
      else scope=fillTurn?this.wantedWithTodo()??this.nextWithTodo(maxRows):this.nextWithTodo(maxRows)??this.wantedWithTodo();
      if(scope!==null){
        // The round quota chooses when another background scope gets service;
        // it must not change a demanded scope's physical prefix. Otherwise the
        // enumeration parity of unrelated scopes changes its visible frontier.
        // A round can exceed its quota by one byte-bounded prefix only.
        const filled=this.fillScope(scope,maxMs,maxRows);
        if(filled==="drain")return {done:false,filled:0,drain:true};
        if(scope===this.roundScope)this.roundRemaining=Math.max(0,this.roundRemaining-filled);
        return {done:false,filled,scope};
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
    const scopeOf=this.db.prepare("SELECT n FROM posting_scopes WHERE scope_id=?"),listed=this.db.prepare(`SELECT 1 AS x FROM posting_todo t WHERE t.scope=? AND ${NOT_IN_DEBT} LIMIT 1`);
    for(const id of this.wanted){
      const row=scopeOf.get(id);
      if(row&&listed.get(Number(row.n)))return Number(row.n);
    }
    return null;
  }
  /** The next scope with entries listed, after the last one served (wrapping). */
  private nextWithTodo(maxRows:number):number|null{
    if(this.roundScope!==null&&this.roundRemaining>0&&this.db.prepare(`SELECT 1 FROM posting_todo t WHERE scope=? AND ${NOT_IN_DEBT} LIMIT 1`).get(this.roundScope))return this.roundScope;
    this.roundScope=null;this.roundRemaining=0;
    const row=this.db.prepare(`SELECT scope FROM posting_todo t WHERE t.scope>? AND ${NOT_IN_DEBT} ORDER BY scope LIMIT 1`).get(this.cursor)??this.db.prepare(`SELECT scope FROM posting_todo t WHERE ${NOT_IN_DEBT} ORDER BY scope LIMIT 1`).get();
    if(!row)return null;
    this.cursor=Number(row.scope);this.roundScope=this.cursor;this.roundRemaining=Math.min(MEMW_STEP_MAX_ROWS,maxRows);
    return this.cursor;
  }
  /** Postings steps commit through the writer (R1: attempt marker, wal_check, I5, FULL) as kind `fill`; the check (charged PASSIVE) settles their log. */
  private enumerate(maxMs:number,maxRows:number):{rows:number;done:boolean}{
    const started=performance.now();
    return this.writer.write("fill",runtimeStepWalBytes(),()=>{
      let below=this.postingsBelow();
      if(below===null)return {rows:0,done:true};
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
      else metaPutter(this.db)(POSTINGS_BELOW,String(below));
      return {rows,done:dry};
    });
  }
  /** Writes the postings of one scope's newest listed entries (an entry deleted since is just un-listed). */
  private fillScope(scope:number,maxMs:number,maxRows:number):number|"drain"{
    const started=performance.now(),fill=postingFiller(this.db);
    const read=this.db.prepare(`SELECT t.seq AS seq,e.scope_id AS scope_id,e.text AS text FROM posting_todo t LEFT JOIN entries e ON e.rowid=t.seq WHERE t.scope=? AND ${NOT_IN_DEBT} ORDER BY t.seq DESC LIMIT ?`);
    // r4.1 G4: an empty read opens no write transaction; an oversize entry is filled alone, one posting a transaction (Q3).
    const head=read.all(scope,1)[0];
    if(!head)return 0;
    if(head.scope_id!==null&&head.scope_id!==undefined){
      const terms=this.oversizeTermsOf(Number(head.seq),String(head.text));
      if(terms)return this.fillOversize(scope,Number(head.seq),String(head.text),terms);
    }
    const frame=frameBytes(this.writer.pageSize),page=this.writer.pageSize;
    return this.writer.write("fill",runtimeStepWalBytes(),()=>{
      const unlist=this.db.prepare("DELETE FROM posting_todo WHERE scope=? AND seq=?");
      let filled=0,out=false,spent=0;
      // a few entries at a time, so the clock is looked at between reads as well as between entries
      while(!out&&filled<maxRows){
        const rows=read.all(scope,Math.min(FILL_CHUNK,maxRows-filled));
        for(const row of rows){
          if(filled&&performance.now()-started>=maxMs*STEP_SHARE){out=true;break;}
          if(row.scope_id!==null&&row.scope_id!==undefined){
            const text=String(row.text),terms=wordTerms(text);
            if(oversizeTerms(terms)){out=true;break;} // never in a normal fill transaction (it is the head of the next step)
            // r4 R5: each entry's cost is computed BEFORE it is written; a chunk that would cross the step is deferred (the first is always taken).
            const cost=(terms.length+Math.ceil(terms.length/8)+4+scratchFrames(Buffer.byteLength(text,"utf8"),page))*frame;
            if(filled&&spent+cost>runtimeStepWalBytes()){out=true;break;}
            spent+=cost;
            fill(String(row.scope_id),text,Number(row.seq),terms);
          }
          unlist.run(scope,Number(row.seq));
          filled++;
        }
        if(rows.length<FILL_CHUNK)break;
      }
      return filled;
    });
  }
  /** The terms of a listed entry's text when its postings are oversize (more than MEMW_POSTINGS_INLINE terms, or one over 512 B), else null. */
  private oversizeTermsOf(seq:number,text:string):string[]|null{
    if(Buffer.byteLength(text,"utf8")<MEMW_POSTING_TERM_INLINE_BYTES)return null;
    const cache=this.oversizeFillCache;
    const terms=cache&&cache.seq===seq&&cache.text===text?cache.terms:wordTerms(text);
    return oversizeTerms(terms)?terms:null;
  }
  private oversizeFillCache:{scope:number;seq:number;text:string;terms:string[];at:number}|null=null;
  /** Test seam (never set in production): called with the shape and declared price (frames) of each one-row-operation transaction, just before its write. */
  postingStepHook:((shape:"posting"|"list"|"unlist"|"empty"|"complete",frames:number)=>void)|null=null;
  /** r4.1 Q3/G4: one missing posting per transaction, then the unlist in a transaction that adds nothing. An in-memory term cursor is only a
   * hint (restarted empty after a respawn, and every posting is probed by EXISTS first). */
  private fillOversize(scope:number,seq:number,text:string,terms:string[]):number|"drain"{
    let cache=this.oversizeFillCache;
    if(!cache||cache.scope!==scope||cache.seq!==seq||cache.text!==text)cache=this.oversizeFillCache={scope,seq,text,terms,at:0};
    const probe=this.db.prepare("SELECT 1 AS x FROM postings WHERE term=? AND scope=? AND seq=?");
    while(cache.at<terms.length&&probe.get(terms[cache.at],scope,seq))cache.at++;
    if(!this.writer.admit("fill",runtimeStepWalBytes()))return "drain";
    if(cache.at<terms.length){
      const term=terms[cache.at];
      this.postingStepHook?.("posting",stepPrice.posting(Buffer.byteLength(term,"utf8")));
      this.writer.write("fill",runtimeStepWalBytes(),()=>{this.db.prepare("INSERT INTO postings(term,scope,seq) VALUES(?,?,?)").run(term,scope,seq);});
      cache.at++;
      return 1;
    }
    this.postingStepHook?.("unlist",stepPrice.todo());
    this.writer.write("fill",runtimeStepWalBytes(),()=>{this.db.prepare("DELETE FROM posting_todo WHERE scope=? AND seq=?").run(scope,seq);});
    this.oversizeFillCache=null;
    return 1;
  }
  /** Whether entries are still waiting for their postings. */
  postingsOwed():boolean{return this.postingsBelow()!==null||Boolean(this.db.prepare(`SELECT 1 FROM posting_todo t WHERE ${NOT_IN_DEBT} LIMIT 1`).get());}
  /** Units of a batch: cost (1.5) and writes per FTS table, against the current state (the lookups placeLexicalRow repeats). */
  private units(records:IndexedMemory[]):GroupUnit[]{
    const stored=this.db.prepare("SELECT length(CAST(id AS BLOB))+length(CAST(scope_id AS BLOB))+length(CAST(text AS BLOB)) AS n FROM entries WHERE id=? AND version=?");
    const storedText=this.db.prepare("SELECT text FROM entries WHERE id=? AND version=?");
    const prev=this.db.prepare("SELECT 1 FROM lexical_keys WHERE id=? AND version=?");
    const squat=this.db.prepare("SELECT 1 FROM lexical_keys WHERE fts_rowid=? AND NOT (id=? AND version=?)");
    const retiredCopy:{get:(id:string,version:number)=>{n:number|bigint}|undefined}=this.aged&&agePhase(this.db)==="retiring"?this.db.prepare("SELECT length(CAST(l.text AS BLOB)) AS n FROM lexical_retired_keys k JOIN lexical_retired l ON l.rowid=k.fts_rowid WHERE k.id=? AND k.version=?") as never:{get:()=>undefined};
    return records.map(row=>{
      const ageKey=typeof row.ageKey==="number"&&Number.isSafeInteger(row.ageKey)?row.ageKey:null;
      const previous=Boolean(prev.get(row.id,row.version));
      const squatter=!row.deleted&&this.aged&&ageKey!==null&&Boolean(squat.get(ageKey,row.id,row.version));
      const writes:Record<string,number>={lexical:writesOf({previous,squatter,insert:!row.deleted,squatterReinsert:squatter})};
      if(this.ageTables)writes.lexical_age=writesOf({previous,squatter:false,insert:!row.deleted&&ageKey!==null,squatterReinsert:false})+1;
      const input={id:row.id,scopeId:row.scopeId,text:row.text,deleted:row.deleted,stored:Number(stored.get(row.id,row.version)?.n??0)};
      // WP2b ruling 2(d): the postings triggers write or drop one row per DISTINCT TERM of the record, each on its own leaf: counted once, never in the age copies.
      const oldText=storedText.get(row.id,row.version)?.text;
      const postings=this.unitPostingsCost(typeof oldText==="string"?oldText:null,row.deleted?null:row.text);
      // WP2b D5/D8: a group writes every copy of its rows in the same txn, so its reserve covers every copy: the second word table
      // (lexical_age: the same words in, the same words out, plus its key / stage / emap rows) while the fill runs, and the copy still
      // in lexical_retired (its words out, plus its key row) while retiring. A reserve for one copy stopped the writer (rise_over_reserve).
      const copies=(this.ageTables?unitCost(input,this.writer.pageSize)+AGE_MAP_FRAMES*frameBytes(this.writer.pageSize):0)
        +retiredCost(retiredCopy.get(row.id,row.version),row.id,this.writer.pageSize);
      return {cost:unitCost(input,this.writer.pageSize)+postings+copies,writes};
    });
  }
  /** r4.1 cost_post, ONE function for a unit (D12, exact): the inline postings of each side that is not oversize (an oversize side writes a
   * to-do row or the debt parts instead), the scratch of every tokenization the triggers run (2 x the stored text: the BEFORE INSERT drop and
   * the UPDATE drop; 1 x the new text), and 8 x (stored bytes + 64) bytes for the debt parts of an oversize stored text. */
  unitPostingsCost(stored:string|null,next:string|null):number{
    const page=this.writer.pageSize,fz=frameBytes(page);
    const side=(text:string|null)=>{if(text===null)return {inline:0,over:false,bytes:0};const terms=wordTerms(text);const over=oversizeTerms(terms);return {inline:over?0:terms.length,over,bytes:Buffer.byteLength(text,"utf8")};};
    const a=side(stored),b=side(next);
    const frames=postingsCost(a.inline+b.inline,page)+(2*scratchFrames(a.bytes,page)+scratchFrames(b.bytes,page))*fz;
    return frames+(a.over?MEMW_R_D*(a.bytes+64):0);
  }
  /** Word tables a write can touch: lexical, lexical_age while the fill runs, lexical_retired while it exists (ruling 2b). */
  private writtenTables():string[]{return ["lexical",...this.ageTables?["lexical_age"]:[],...this.hasTable("lexical_retired")?["lexical_retired"]:[]];}
  /** Segments of each FTS table this batch writes. */
  private writtenSegments():number[]{return this.writtenTables().map(t=>this.segmentCount(t));}
  /** A checked group may have committed before its receipt/charge ack was lost. Replaying it must not rewrite its text. */
  private alreadyProjected(row:IndexedMemory):boolean {
    if(row.deleted||this.ageTables||this.hasTable("lexical_retired"))return false;
    const stored=this.db.prepare("SELECT e.scope_id,e.text,k.fts_rowid FROM entries e JOIN lexical_keys k ON k.id=e.id AND k.version=e.version WHERE e.id=? AND e.version=?").get(row.id,row.version);
    return stored?.scope_id===row.scopeId&&stored.text===row.text&&(!this.aged||row.ageKey===null||row.ageKey===undefined||Number(stored.fts_rowid)===row.ageKey);
  }
  /** The batch in groups (1.5), each one checked write; the check is awaited after each group. */
  async applyBatch(records:IndexedMemory[]):Promise<{status:"done"}|{status:"failed";reason:"wal-over"|"merge-floor"|"segment-gate"|"drain"|"check-owed"|"age-blocked";committed:number}>{
    let committed=0;
    if(this.openState!=="open")return {status:"failed",reason:this.openState==="stopped"?"wal-over":"check-owed",committed};
    const units=this.units(records),file=this.attachCount;
    let holdStart:number|undefined;
    while(committed<records.length){
      if(!this.keepGoing())return {status:"failed",reason:"check-owed",committed};
      if(this.writer.stopped)return {status:"failed",reason:"wal-over",committed};
      if(this.writer.checkOwed())return {status:"failed",reason:"check-owed",committed};
      while(committed<records.length&&this.alreadyProjected(records[committed]!))committed++;
      if(committed===records.length)return {status:"done"};
      if(this.meta("lexical_keys_complete")!=="1")return {status:"failed",reason:"drain",committed};
      if(this.tierSealOwed)return {status:"failed",reason:"drain",committed};
      if(!segmentGateOpen(this.writtenSegments())){
        holdStart??=this.now();
        const hold=await this.holdAtGate(holdStart);
        if(this.attachCount!==file)return {status:"failed",reason:"wal-over",committed:0};
        if(hold!=="clear")return {status:"failed",reason:hold,committed};
        continue;
      }
      const group=formGroup(units,committed,{L:this.writer.L(),pageSize:this.writer.pageSize,msPerCostByte:this.groupClock.msPerCostByte()});
      if(!group.fitsAlone)return {status:"failed",reason:"drain",committed};
      try{if(!this.writer.admit("group",group.cost))return {status:"failed",reason:"drain",committed};}
      catch(error){if(isBgDeferred(error))return {status:"failed",reason:"check-owed",committed};throw error;}
      let rowMs:number;
      try{rowMs=this.writeGroup(records.slice(committed,committed+group.count),group.cost);}
      catch(error){if(isAgeBlocked(error)){noteAgeBlocked(this.db,error);return {status:"failed",reason:"age-blocked",committed};} // WP2b D7 (owner Q1: additive reason)
        if(isBgDeferred(error))return {status:"failed",reason:"check-owed",committed};
        if(error instanceof WalStop)return {status:"failed",reason:"wal-over",committed};throw error;}
      // A marker fsync or COMMIT stall is fixed per transaction: shrinking the
      // next group cannot shorten it, and instead adds commits and changes the
      // FTS merge schedule. Predict the scalable row work; every WAL check stays awaited.
      this.groupClock.record(rowMs,group.cost);
      const passed=await this.settle();
      if(this.attachCount!==file)return {status:"failed",reason:"wal-over",committed:0};
      if(!passed)return {status:"failed",reason:this.writer.stopped?"wal-over":"check-owed",committed};
      committed+=group.count;
    }
    return {status:"done"};
  }
  /** One maintenance merge step (1.5): positive N 64 on one table, kind merge (or the tier step, reserve = pred). True when it merged
   * something (>= 2 changes); a step that finds nothing left to merge clears the table's debt_bytes in the same txn. */
  private mergeStep(table:string,kind:"merge"|"tier"="merge",reserve:number=runtimeMergeWalBytes()):boolean{
    return this.writer.write(kind,reserve,()=>{
      const before=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n);
      this.db.exec(`INSERT INTO ${table}(${table},rank) VALUES('merge',${runtimeMergePages()})`);
      const progressed=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n)-before>=2;
      if(!progressed)this.clearDebt(table);
      return progressed;
    });
  }
  // 1.8 T_t: index_meta text_bytes:<t> (text in the table's live rows) and debt_bytes:<t> (text removed, not merged out yet); moved in the
  // txn that adds or removes postings, never a scan. Called inside a write txn only.
  private bumpMeta(key:string,delta:number):void{
    if(!delta)return;
    metaPutter(this.db)(key,String(Math.max(0,Number(this.meta(key)??0)+delta)));
  }
  private addText(table:string,bytes:number):void{this.bumpMeta(`text_bytes:${table}`,bytes);}
  private moveToDebt(table:string,bytes:number):void{if(bytes<=0)return;this.bumpMeta(`text_bytes:${table}`,-bytes);this.bumpMeta(`debt_bytes:${table}`,bytes);}
  private clearDebt(table:string):void{if(this.meta(`debt_bytes:${table}`)!==undefined)metaPutter(this.db)(`debt_bytes:${table}`,"0");}
  /** UTF-8 bytes of a stored entry's text (PK read), 0 when absent. */
  private storedTextBytes(id:string,version:number):number{return Number(this.db.prepare("SELECT length(CAST(text AS BLOB)) AS n FROM entries WHERE id=? AND version=?").get(id,version)?.n??0);}
  /** One stepped seed of text_bytes:lexical (bounded cursor sum over entries by rowid, MEMW_STEP_MAX_ROWS per step) [r22 3.2][r31 3].
   * debt_bytes:lexical seeds at the whole text when a merge is owed (unknown debt: fail closed), else 0. True when seeded. */
  private seedTextStep(meta:(k:string,v:string)=>void):boolean{
    if(this.meta("text_bytes:lexical")!==undefined)return true;
    const cursor=Number(this.meta("text_bytes_cursor")??0);
    const rows=this.db.prepare("SELECT rowid AS r,length(CAST(text AS BLOB)) AS n FROM entries WHERE rowid>? ORDER BY rowid LIMIT ?").all(cursor,MEMW_STEP_MAX_ROWS) as Array<{r:number;n:number}>;
    const sum=Number(this.meta("text_bytes_seed")??0)+rows.reduce((a,row)=>a+Number(row.n),0);
    if(rows.length===MEMW_STEP_MAX_ROWS){meta("text_bytes_cursor",String(rows.at(-1)!.r));meta("text_bytes_seed",String(sum));return false;}
    this.db.prepare("DELETE FROM index_meta WHERE key IN ('text_bytes_cursor','text_bytes_seed')").run();
    meta("text_bytes:lexical",String(sum));
    meta("debt_bytes:lexical",this.meta("merge_owed")==="1"?String(sum):"0");
    return true;
  }
  /** T_t for the merge prediction. A table without counters of its own (an age table before WP2b writes them) is sized by lexical's
   * (its rows are a copy); no counters at all is unknown and routes to the floor (fail closed). */
  mergeText(table:string):number{
    const t=this.meta(`text_bytes:${table}`)!==undefined?table:"lexical";
    const text=this.meta(`text_bytes:${t}`);
    if(text===undefined)return Number.POSITIVE_INFINITY;
    return Number(text)+Number(this.meta(`debt_bytes:${t}`)??0);
  }
  private predictor!:MergePredictor;
  private newPredictor(pageSize:number):MergePredictor{
    return new MergePredictor(pageSize,()=>Math.max(overrunK(this.meta("overrun_k:merge")),overrunK(this.meta("overrun_k:tier"))));
  }
  /** The table's merge prediction and its route (1.8 O1-O4). */
  mergePlan(table:string):{pred:number;route:"merge"|"tier"|"floor"}{
    const pages=this.mergeInputPages(table);
    const pred=pages===null?Infinity:this.predictor.pred(table,this.mergeText(table),pages);
    if(helperEnforced()&&Number.isFinite(pred))return {pred:Math.min(pred,runtimeMergeWalBytes()),route:"merge"};
    return {pred,route:Number.isFinite(pred)?mergeRoute(pred,this.writer.pageSize,memwLines().wMerge):"floor"};
  }
  private mergeInputPages(table:string):number|null{
    return structureMergePages(this.db.prepare(`SELECT block FROM ${table}_data WHERE id=10`).get()?.block as Uint8Array|undefined);
  }
  /** A merge (or tier) step, its check, and the predictor's history (rise / T_t). */
  private async measuredMerge(table:string,kind:"merge"|"tier",reserve:number):Promise<{ms:number;passed:boolean}>{
    const text=this.mergeText(table),pages=this.mergeInputPages(table)??0,before=this.writer.L(),started=this.now();
    this.mergeStep(table,kind,helperEnforced()?Math.min(reserve,runtimeMergeWalBytes()):reserve);
    const ms=this.now()-started,passed=await this.settle();
    if(passed){const after=this.writer.L(),base=kind==="tier"||after<before?WAL_HEADER_BYTES:before;if(Number.isFinite(text))this.predictor.record(table,Math.max(0,after-base),text,pages);}
    return {ms,passed};
  }
  /** Tables over the gate (1.5), first one first. */
  private gatedTable():string|null{
    for(const table of this.writtenTables())if(this.segmentCount(table)>MEMW_SEGMENT_GATE)return table;
    return null;
  }
  /** O4: refused, logged once per table per helper start; the debt stays durable. */
  private floorLogged=new Set<string>();
  private noteFloor(table:string,pred:number):void{
    if(this.floorLogged.has(table))return;
    this.floorLogged.add(table);
    console.warn(`MEMORY_INDEX_MERGE_FLOOR table=${table} pred=${Math.round(pred)}`);
  }
  private slowMergeAt=-Infinity;
  /** The clock of the gate hold and the tier's 250 ms line (a seam for the time tests). */
  private now:()=>number=()=>performance.now();
  /** Set after a tier step until its sealAndTruncate empties the log: nothing else writes before it (1.8 O2). */
  private tierSealOwed=false;
  /** A tier step over 250 ms: the next tier step waits one tick. */
  private tierWait=false;
  /** The gate hold (1.8 R1, R2, R4) while a batch waits at the gate: positive merges with pred <= 12 MiB only while
   * elapsed + 250 + 2 x 250 ms <= 5,000 ms; a clear that needs the tier, or the 5 s spent, answers the batch now (segment-gate);
   * pred over the tier ceiling answers merge-floor at once. */
  private async holdAtGate(start:number):Promise<"clear"|"segment-gate"|"merge-floor"|"wal-over"|"check-owed">{
    for(;;){
      if(!this.keepGoing())return "check-owed";
      const table=this.gatedTable();
      if(table===null)return "clear";
      const plan=this.mergePlan(table);
      if(plan.route==="floor"){this.noteFloor(table,plan.pred);return "merge-floor";}
      if(plan.route==="tier")return "segment-gate";
      if(!gateHoldMayMerge(this.now()-start))return "segment-gate";
      if(!this.writer.admit("merge",runtimeMergeWalBytes()))return "segment-gate";
      const step=await this.measuredMerge(table,"merge",runtimeMergeWalBytes());
      if(!step.passed)return this.writer.stopped?"wal-over":"check-owed";
    }
  }
  /** The tier step (1.8 O2/O3): only at L = 32 B (after the worker's drain + sealAndTruncate), reserve = pred; then sealAndTruncate before
   * anything else writes. Over 250 ms: MEMORY_INDEX_SLOW_MERGE (rate-limited) and the next tier step waits one tick. */
  private async tierStep(table:string,pred:number):Promise<{ran:AdmitKind|null;drain?:boolean;gateClear?:boolean}>{
    if(this.tierWait){this.tierWait=false;return {ran:null,gateClear:false};}
    if(this.writer.L()!==WAL_HEADER_BYTES||!this.writer.admit("tier",pred))return {ran:null,drain:true,gateClear:false};
    const step=await this.measuredMerge(table,"tier",pred);
    if(!step.passed)return {ran:null,gateClear:false};
    if(step.ms>MEMW_CALL_MS){
      this.tierWait=true;
      if(this.now()-this.slowMergeAt>=60_000){this.slowMergeAt=this.now();console.warn(`MEMORY_INDEX_SLOW_MERGE table=${table} ms=${Math.round(step.ms)}`);}
    }
    this.tierSealOwed=true;
    if(this.keepGoing()&&(await this.sealAndTruncate()).truncated)this.tierSealOwed=false;
    return {ran:"tier",...this.tierSealOwed?{drain:true}:{},gateClear:segmentGateOpen(this.writtenSegments())};
  }
  /** One tick-driven maintenance step (spec 4). Order: the owed check (nothing else while one is owed), the reset write, the tier's seal,
   * the segment-limit stop, the gate (merge / tier / floor), the deletion scrub, the rolled purge, the recount, postings, then WP2b's age step.
   * Each sub-step is one checked write and then its check. */
  async maintenanceStep():Promise<{ran:AdmitKind|null;drain?:boolean;gateClear?:boolean}>{
    if(this.writer.stopped)return {ran:null};
    if(this.openState==="pending"){await this.init();return {ran:this.opened()?"open":null,gateClear:this.opened()?segmentGateOpen(this.writtenSegments()):false};}
    if(this.writer.checkOwed()){await this.settle();return {ran:null};}
    if(this.writeResetIfAdmitted()){await this.settle();return {ran:"open"};}
    if(this.tierSealOwed){
      const sealed=(await this.sealAndTruncate()).truncated;
      if(sealed)this.tierSealOwed=false;
      return {ran:sealed?"seal":null,...sealed?{}:{drain:true},gateClear:sealed&&segmentGateOpen(this.writtenSegments())};
    }
    const limit=this.segmentLimitTable();
    if(limit!==null){this.stopAtSegmentLimit(limit);return {ran:null};}
    const table=this.gatedTable();
    if(table!==null){
      const plan=this.mergePlan(table);
      if(plan.route==="floor"){this.noteFloor(table,plan.pred);return {ran:null,gateClear:false};}
      if(plan.route==="tier")return this.tierStep(table,plan.pred);
      if(!this.writer.admit("merge",runtimeMergeWalBytes()))return {ran:null,drain:true,gateClear:false};
      await this.measuredMerge(table,"merge",runtimeMergeWalBytes());
      return {ran:"merge",gateClear:segmentGateOpen(this.writtenSegments())};
    }
    if(this.deletionScrubPending()){await this.scrubDeleted();return {ran:"merge",gateClear:true,...this.scrubDrain?{drain:true}:{}};}
    if(this.rolledPassOpen()){const merging=this.purge.merging;await this.purgeRolledCheckpoints();return {ran:merging?"merge":"delete",gateClear:true};}
    if(this.entriesRecounting()){await this.recountStep();return {ran:"delete",gateClear:true};}
    if(this.postingsOwed()){await this.fillPostings();return {ran:"fill",gateClear:true};}
    // WP2b: the age fill / sweep step goes here (one checked write, then settle).
    return {ran:null,gateClear:true};
  }
  /** The 50 ms tick (1.11): seal and truncate whenever L > 8 MiB. */
  async tick():Promise<void>{if(this.writer.L()>memwLines().tickTruncate&&!this.writer.checkOwed())await this.sealAndTruncate();}
  private writeGroup(records:IndexedMemory[],reserve:number):number{
    const forgetting=records.some(row=>row.deleted&&!row.rolled);
    let removed=false,forceMerge=false;
    const storedRow=this.db.prepare("SELECT rowid AS r FROM entries WHERE id=? AND version=?");
    // r4.1 S4: the new row's seq is above every live rowid AND every seq with debt still pending, so it can never inherit forgotten words.
    const upsertEntry=this.db.prepare("INSERT INTO entries(rowid,id,version,scope_id,text) VALUES(max(coalesce((SELECT max(rowid) FROM entries),0),coalesce((SELECT max(seq) FROM posting_drop),0))+1,?,?,?,?) ON CONFLICT(id,version) DO UPDATE SET scope_id=excluded.scope_id,text=excluded.text RETURNING rowid AS r");
    const rowMs=this.writer.write("group",reserve,()=>{
      const started=performance.now();
      for(const row of records){
        const previous=this.db.prepare("SELECT fts_rowid FROM lexical_keys WHERE id=? AND version=?").get(row.id,row.version);
        if(previous){removed=true;if(!row.rolled)forceMerge=true;}
        if(previous)this.db.prepare("DELETE FROM lexical WHERE rowid=?").run(previous.fts_rowid);
        if(previous)this.moveToDebt("lexical",this.storedTextBytes(row.id,row.version));
        this.db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?").run(row.id,row.version);
        if(ageDeleteRecord(this.db,row.id,row.version)){removed=true;if(!row.rolled)forceMerge=true;} // WP2b D5/D8: lexical_age (keys, stage, emap) and lexical_retired
        this.db.prepare("DELETE FROM vectors WHERE id=? AND version=?").run(row.id,row.version);
        const stored=storedRow.get(row.id,row.version);
        if(row.deleted){
          if(stored){this.db.prepare("DELETE FROM entries WHERE id=? AND version=?").run(row.id,row.version);this.countEntry(-1,Number(stored.r));removed=true;if(!row.rolled)forceMerge=true;}
          continue;
        }
        // r4.1 R2: a stored text whose removal is debt (oversize) is replaced as DELETE then INSERT, so the new text gets a NEW seq and the
        // debt parts can never drop its postings.
        let replaced=false;
        if(stored){
          const old=this.db.prepare("SELECT text FROM entries WHERE id=? AND version=?").get(row.id,row.version)?.text;
          if(typeof old==="string"&&Buffer.byteLength(old,"utf8")>=MEMW_POSTING_TERM_INLINE_BYTES&&oversizeTerms(wordTerms(old))){
            this.db.prepare("DELETE FROM entries WHERE id=? AND version=?").run(row.id,row.version);this.countEntry(-1,Number(stored.r));replaced=true;
          }
        }
        const written=upsertEntry.get(row.id,row.version,row.scopeId,row.text);
        if(!stored||replaced)this.countEntry(1,Number(written!.r));
        const ageKey=typeof row.ageKey==="number"&&Number.isSafeInteger(row.ageKey)?row.ageKey:null;
        if(this.aged&&ageKey!==null)placeLexicalRow(this.db,"lexical",row.id,row.version,row.text,ageKey);
        else{
          const inserted=this.db.prepare("INSERT INTO lexical VALUES(?,?,?)").run(row.id,row.version,row.text);
          this.db.prepare("INSERT INTO lexical_keys VALUES(?,?,?)").run(row.id,row.version,inserted.lastInsertRowid);
          ageInsertRecord(this.db,row.id,row.version,row.text,Number(written!.r),ageKey); // WP2b D5 destination check
        }
        this.addText("lexical",Buffer.byteLength(row.text,"utf8"));
      }
      if(removed){this.setMergeOwed(true,!forceMerge);this.bumpDeletionGeneration();}
      if(forgetting&&this.meta("delete_scrub_completed")!==String(this.scrubGeneration())){
        if(!this.deletionScrubPending())metaPutter(this.db)("delete_scrub_owed","merge");
        metaPutter(this.db)("delete_scrub_target",String(this.scrubGeneration()));
      }
      return performance.now()-started;
    });
    if(removed){this.purge.merging=true;this.deletionGen++;}
    return rowMs;
  }
  /** Whether deletions are waiting for the stepped maintenance to merge them out of the word index. Durable: set in the
   * transaction that deleted (the walk's own transaction too, even when it removed too little to start merging yet), cleared only
   * when a merge step finds nothing left to merge, and read again when the index opens: the debt is the durable marker, the
   * decision to start paying it (purge.merging) is separate and may wait for a fraction of the index. */
  maintenanceOwed():boolean{return this.purge.merging;}
  /** Segments the full-text index holds now (FTS5 refuses writes at FTS_SEGMENT_LIMIT). */
  segmentCount(table:string="lexical"):number{
    // The count FTS5 itself checks is in its structure record (shadow-table row 10); counting <t>_idx misses one-page segments.
    if(!/^lexical(_age|_retired)?$/.test(table))throw new Error("MEMORY_INDEX_TABLE");
    const n=structureSegments(this.db.prepare(`SELECT block FROM ${table}_data WHERE id=10`).get()?.block as Uint8Array|undefined);
    if(n!==null)return n;
    return Number(this.db.prepare(`SELECT count(DISTINCT segid) AS n FROM ${table}_idx`).get()!.n);
  }
  /** R3 (OPEN-3): no unbounded optimize and no raw rebuild. Under the 48 gate the count never nears FTS_SEGMENT_LIMIT; a file that does
   * anyway is stopped (1.7) and the controller's reset (1.13, A13 backoff) rebuilds it. */
  private segmentLimitTable():string|null{
    for(const table of this.writtenTables())if(this.segmentCount(table)>=FTS_SEGMENT_LIMIT-100)return table;
    return null;
  }
  private stopAtSegmentLimit(table:string):void{
    if(!this.core)return;
    try{this.core.stop(`segment_limit:${table}`,"merge",this.core.seq);}catch(error){if(!(error instanceof WalStop))throw error;}
    this.openState="stopped";
  }
  /** The end of a one-time rewrite of the stored text (the 1.0.4 number scrub, scrub-pass.ts settle). R3: the whole-index optimize is
   * replaced by durable merge debt the bounded passes pay; then sealAndTruncate. True when the log was truncated (false: ask again). */
  async finishRewrite():Promise<boolean>{
    if(!(await this.settle())||!this.keepGoing())return false;
    this.writer.write("merge",runtimeMergeWalBytes(),()=>this.setMergeOwed(true));
    this.purge.merging=true;
    if(!(await this.settle()))return false;
    return this.keepGoing()&&(await this.sealAndTruncate()).truncated;
  }
  /** Durable physical deletion debt, separate from ordinary stepped merges. No schema or FTS format change. */
  deletionScrubPending():boolean{return Boolean(this.db.prepare("SELECT 1 FROM index_meta WHERE key='delete_scrub_owed'").get())||this.postingDropOwed();}
  /** r4.1: debt parts of oversize removals are still on posting_drop (the postings of forgotten words are physically dropped, one row a transaction). */
  postingDropOwed():boolean{return this.hasTable("posting_drop")&&Boolean(this.db.prepare("SELECT 1 FROM posting_drop LIMIT 1").get());}
  /** The last drop step wanted a drain (admission refused): the worker holds and seals before the timer re-arms (r4 R4, D10b). */
  scrubDrain=false;
  private fillKick=false;
  /** True once after a completed debt whose seq is listed on posting_todo: the worker restarts the backfill (its pickers skipped that seq while parts remained). */
  takeFillKick():boolean{const kick=this.fillKick;this.fillKick=false;return kick;}
  private dropCursor:{id:number;term:string}|null=null;
  /** r4.1 G4: ONE row operation per transaction on the OLDEST part (ORDER BY id): list its seq when live and unlisted (first, its own txn, before
   * any completion so a crash never leaves a live seq unlisted with no parts), then drop ONE still-posted term, then C1 (empty the part:
   * terms = '[]' frees its chain), then C2 (delete the emptied row and its posting_drop_seq entry). Progress is durable state only; the
   * in-memory term cursor is a hint and restarts empty. "drain": admission refused. */
  postingDropStep():"stepped"|"drain"|"none"{
    const part=this.db.prepare("SELECT id,scope,seq,terms FROM posting_drop ORDER BY id LIMIT 1").get();
    if(!part)return "none";
    if(!this.writer.admit("delete",runtimeStepWalBytes()))return "drain";
    const id=Number(part.id),scope=Number(part.scope),seq=Number(part.seq),raw=String(part.terms);
    const terms=(JSON.parse(raw) as string[]).sort();
    const live=Boolean(this.db.prepare("SELECT 1 FROM entries e JOIN posting_scopes p ON p.scope_id=e.scope_id WHERE e.rowid=? AND p.n=?").get(seq,scope));
    const listed=Boolean(this.db.prepare("SELECT 1 FROM posting_todo WHERE scope=? AND seq=?").get(scope,seq));
    const w=(body:()=>void)=>{this.writer.write("delete",runtimeStepWalBytes(),body);};
    if(live&&!listed){
      this.postingStepHook?.("list",stepPrice.todo());
      w(()=>{this.db.prepare("INSERT INTO posting_todo(scope,seq) VALUES(?,?)").run(scope,seq);});
      return "stepped";
    }
    const from=this.dropCursor&&this.dropCursor.id===id?this.dropCursor.term:"";
    const posted=this.db.prepare("SELECT 1 FROM postings WHERE term=? AND scope=? AND seq=?");
    let next:string|null=null;
    for(const term of terms)if(term>from&&posted.get(term,scope,seq)){next=term;break;}
    if(next!==null){
      const term=next;
      this.postingStepHook?.("posting",stepPrice.posting(Buffer.byteLength(term,"utf8")));
      w(()=>{this.db.prepare("DELETE FROM postings WHERE term=? AND scope=? AND seq=?").run(term,scope,seq);});
      this.dropCursor={id,term};
      return "stepped";
    }
    if(terms.length>0){
      this.postingStepHook?.("empty",stepPrice.empty(Buffer.byteLength(raw,"utf8")));
      w(()=>{this.db.prepare("UPDATE posting_drop SET terms='[]' WHERE id=?").run(id);});
      return "stepped";
    }
    this.postingStepHook?.("complete",stepPrice.complete());
    w(()=>{this.db.prepare("DELETE FROM posting_drop WHERE id=?").run(id);});
    this.dropCursor=null;
    if(live)this.fillKick=true;
    return "stepped";
  }
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
    metaPutter(this.db)("delete_generation",String(this.scrubGeneration()+1));
  }
  /** One committed FTS merge command, or one bounded checkpoint attempt. A negative page count opens
   * a merge over every existing segment; subsequent positive steps continue it. FTS5's <2-change
   * completion signal covers only the generation captured at that first step, never later deletes.
   * Progress and its generation commit together, so a restart resumes with a positive page count.
   * Only index_meta rows are added; older binaries can still open the FTS tables. */
  async scrubDeleted():Promise<boolean>{
    const restore=setAdmissionPurpose("owner-delete");
    try{return await this.scrubDeletedStep();}finally{restore();}
  }
  private truncatedSalt:string|undefined;
  private async scrubDeletedStep():Promise<boolean>{
    if(!this.deletionScrubPending())return true;
    // Capture before settle() copies the outstanding frames and changes the debt estimate.
    const sealNeed=this.core!.sealCeiling();
    if(!(await this.settle())||!this.keepGoing()){this.scrubBlocked=true;return false;}
    // r4.1: the debt parts of oversize removals go first, one one-row transaction a call (the merge scrub follows once none is left).
    this.scrubDrain=false;
    if(this.postingDropOwed()){
      this.scrubBlocked=false;
      if(this.postingDropStep()==="drain"){this.scrubDrain=true;return false;}
      await this.settle();
      return !this.deletionScrubPending();
    }
    const step=this.scrubWrite();
    if(step==="drain"){this.scrubDrain=true;return false;}
    if(step!=="truncate"){await this.settle();return step;}
    const page=this.writer.pageSize,nativePage=ioMeterPageSize(),frames=META_ENVELOPE_FRAMES+32;
    const cleanupReserve=frames*frameBytes(page);
    const cleanupNeed=commitCeiling(frames,page,nativePage)+checkpointCeiling(frames,page,nativePage)+4*nativePage;
    const mark=this.core!.walMark();
    // A successful TRUNCATE survives admission waits in this process. Any intervening WAL write invalidates it.
    const alreadyTruncated=mark?.mxFrame===0&&mark.salt===this.truncatedSalt;
    if(!alreadyTruncated){
      if(!helperHasGrant(sealNeed+cleanupNeed,true))throw new BgDeferred();
      if(!(await this.sealAndTruncate()).truncated){this.scrubBlocked=true;return false;}
      const truncated=this.core!.walMark();
      this.truncatedSalt=truncated?.mxFrame===0?truncated.salt:undefined;
    }
    // Never let write() replace a cleanup-sized request with another seal-and-cleanup request.
    if(!this.keepGoing())return false;
    if(!helperHasGrant(cleanupNeed,true))throw new BgDeferred();
    // Only metadata is written after the TRUNCATE; every page with retired text has already been drained.
    const generation=Number((JSON.parse(this.meta("delete_scrub_merge")!) as {generation:number}).generation);
    this.writer.write("merge",cleanupReserve,()=>{
      metaPutter(this.db)("delete_scrub_completed",String(generation));
      this.db.exec("DELETE FROM index_meta WHERE key IN ('delete_scrub_owed','delete_scrub_merge','delete_scrub_target')");
    });
    await this.settle();
    return true;
  }
  /** Synchronous diagnostic observer: each command is attributed before progress advances. */
  scrubStepHook?:(step:{merges:number;generation:number;target:number;table:string;started:boolean;rank:number;changesDelta:number})=>void;
  private scrubWrite():boolean|"truncate"|"drain"{
    this.scrubBlocked=false;
    const owed=this.meta("delete_scrub_owed");
    if(!owed)return true;
    type Merge={generation:number;table:"lexical"|"lexical_age"|"lexical_retired";started:boolean}; // WP2b
    const saved=this.meta("delete_scrub_merge");
    let merge:Merge=saved?JSON.parse(saved):{generation:this.scrubGeneration(),table:"lexical",started:false};
    // A legacy truncate marker has no generation proof. Start a bounded merge before acknowledging it.
    if(owed==='truncate'&&saved&&merge.generation>=this.scrubTarget())return "truncate";
    if(owed==='truncate')merge={generation:this.scrubGeneration(),table:"lexical",started:false};
    // A bounded merge can exceed the remaining WAL headroom even below the
    // periodic tick line. Drain first; retrying admission alone cannot free it.
    if(helperEnforced()&&!this.writer.admit("merge",runtimeMergeWalBytes()))return "drain";
    try{
      const settled=this.writer.write("merge",runtimeMergeWalBytes(),()=>{
        // No age cutover runs while scrub debt exists (worker.ts). A removed age table after an older
        // binary opened this file is handled by starting again against the current lexical table.
        if(merge.table!=='lexical'&&!this.hasTable(merge.table)) /* WP2b */merge={generation:this.scrubGeneration(),table:"lexical",started:false};
        // Merge starts are counted (diagnostics; tests): one start covers every row removed before it.
        if(!merge.started&&merge.table==='lexical')metaPutter(this.db)("delete_scrub_merges",String(Number(this.meta("delete_scrub_merges")??0)+1));
        const before=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n);
        const rank=merge.started?runtimeMergePages():-runtimeMergePages();
        this.db.prepare(`INSERT INTO ${merge.table}(${merge.table},rank) VALUES('merge',?)`).run(rank);
        const changesDelta=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n)-before;
        this.scrubStepHook?.({merges:Number(this.meta("delete_scrub_merges")??0),generation:merge.generation,target:this.scrubTarget(),table:merge.table,started:merge.started,rank,changesDelta});
        const done=changesDelta<2;
        merge.started=true;
        let phase='merge';
        if(done){
          if(nextScrubTable(this.db,merge.table))merge={...merge,table:nextScrubTable(this.db,merge.table)!,started:false}; // WP2b D8 every generation
          // A forget removed after this merge began needs one more; rollovers since then do not.
          else if(merge.generation<this.scrubTarget())merge={generation:this.scrubGeneration(),table:"lexical",started:false};
          else phase='truncate';
        }
        metaPutter(this.db)("delete_scrub_merge",JSON.stringify(merge));
        metaPutter(this.db)("delete_scrub_owed",phase);
        // Rollovers removed after this merge began stay owed to the stepped maintenance.
        const settled=phase==='truncate'&&merge.generation===this.scrubGeneration();
        if(settled){this.setMergeOwed(false);this.clearDebt("lexical");if(ageTablesPresent(this.db))this.clearDebt("lexical_age");}
        return settled;
      });
      // Ordinary maintenance must not continue a merge state superseded by this run.
      this.mergeStarted=false;
      if(settled){this.purge.merging=false;this.purge.since=0;}
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
  // Only this handle can attest that every pending removal used secure-delete.
  // Restart/downgrade debts conservatively retain the existing full scrub.
  private mergeDirect=false;
  private setMergeOwed(owed:boolean,directlyErased=false){
    if(owed){
      this.mergeDirect=directlyErased&&(!this.meta("merge_owed")||this.mergeDirect);
      metaPutter(this.db)("merge_owed","1");
    }else{
      this.db.prepare("DELETE FROM index_meta WHERE key='merge_owed'").run();
      this.mergeDirect=false;
    }
  }
  /** Remove every entry (lexical text, keys, vectors) of the given record ids, all
   * versions. Bounded (200 ids per transaction) and idempotent: a second call
   * finds nothing. Used at open to drop owner-authored continuity records that an
   * earlier build indexed, so their text never contributes to BM25 statistics. */
  async purgeRecords(ids: readonly string[]): Promise<number> {
    if(ageObjectsPresent(this.db))return agePurgeBegin(this.writer,this.db,ids); // WP2b D6
    let removed=0;
    for(let start=0;start<ids.length;start+=200){
      const chunk=JSON.stringify(ids.slice(start,start+200));
      if(!(await this.settle()))throw new Error("MEMORY_INDEX_CHECK_OWED");
      if(!this.keepGoing())break;
      this.writer.write("delete",runtimeStepWalBytes(),()=>{
        const before=removed;
        const rowids=this.db.prepare("SELECT fts_rowid FROM lexical_keys WHERE id IN (SELECT value FROM json_each(?))").all(chunk);
        if(rowids.length)this.moveToDebt("lexical",Number(this.db.prepare("SELECT coalesce(sum(length(CAST(e.text AS BLOB))),0) AS n FROM lexical_keys k JOIN entries e ON e.id=k.id AND e.version=k.version WHERE k.id IN (SELECT value FROM json_each(?))").get(chunk)!.n));
        for(const row of rowids)this.db.prepare("DELETE FROM lexical WHERE rowid=?").run(row.fts_rowid);
        removed+=rowids.length;
        this.db.prepare("DELETE FROM lexical_keys WHERE id IN (SELECT value FROM json_each(?))").run(chunk);
        const gone=this.db.prepare("DELETE FROM entries WHERE id IN (SELECT value FROM json_each(?)) RETURNING rowid AS r").all(chunk) as Array<{r:number}>;
        for(const row of gone)this.countEntry(-1,Number(row.r));
        removed+=gone.length;
        removed+=Number(this.db.prepare("DELETE FROM vectors WHERE id IN (SELECT value FROM json_each(?))").run(chunk).changes);
        if(removed>before){this.setMergeOwed(true);this.bumpDeletionGeneration();}
      });
    }
    await this.settle();
    if(removed){
      // R3: the merge debt is durable (written above) and paid by the bounded passes; no whole-index optimize.
      this.purge.merging=true;
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
  async purgeRolledCheckpoints(options: {maxExamined?: number; maxMs?: number; mergePages?: number; mergeFraction?: number} = {}): Promise<{removed: number; examined: number; merged: boolean; done: boolean}> {
    if(!(await this.settle()))return {removed:0,examined:0,merged:false,done:false};
    if(!this.keepGoing())return {removed:0,examined:0,merged:false,done:false};
    // The deletion scrub owns both word tables until its generation is checkpointed: one scrub step, never a completed pass.
    if(this.deletionScrubPending())return {removed:0,examined:0,merged:false,done:(await this.scrubDeleted())&&this.purge.cursor===null};
    const step=this.rolledWrite(options);
    await this.settle();
    if(step.done)this.rolledPassDue=false;
    return step;
  }
  /** A rolled-checkpoint pass is due (the worker's pass timer) or under way (walk part way, or merges owed). */
  private rolledPassDue=false;
  beginRolledPass():void{this.rolledPassDue=true;}
  private rolledPassOpen():boolean{return this.rolledPassDue||this.purge.cursor!==null||this.purge.merging;}
  private rolledWrite(options: {maxExamined?: number; maxMs?: number; mergePages?: number; mergeFraction?: number}): {removed: number; examined: number; merged: boolean; done: boolean} {
    const maxExamined=Math.max(1,options.maxExamined??2048),maxMs=options.maxMs??10,mergePages=Math.max(1,options.mergePages??8),mergeFraction=options.mergeFraction??0.1;
    if(this.purge.merging){
      // Preserve bd9960b116: known secure-deleted rollovers owe only the
      // checked metadata write; an inherited debt still takes the full scrub.
      if(this.mergeDirect){
        this.writer.write("delete",runtimeStepWalBytes(),()=>{this.setMergeOwed(false);this.clearDebt("lexical");});
        this.purge.merging=false;this.mergeStarted=false;this.purge.since=0;
        const done=this.purge.cursor===null;if(done)this.purge.live=null;
        return {removed:0,examined:0,merged:false,done};
      }
      // A negative count starts the incremental merge; repeating it opens a fresh output segment each step until FTS5's
      // 2,000-segment limit, so every later step is positive and continues the merge in progress. One checked `merge` txn (I2, R1).
      if(!this.mergeStarted)this.mergeGen=this.deletionGen;
      const pages=this.mergeStarted?mergePages:-mergePages,settled=this.deletionGen===this.mergeGen;
      const progressed=this.writer.write("merge",runtimeMergeWalBytes(),()=>{
        const before=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n);
        this.db.exec(`INSERT INTO lexical(lexical,rank) VALUES('merge',${pages})`);
        // FTS5: fewer than two changes means the merge found nothing left to merge.
        const more=Number(this.db.prepare("SELECT total_changes() AS n").get()!.n)-before>=2;
        if(!more&&settled){this.setMergeOwed(false);this.clearDebt("lexical");}
        return more;
      });
      this.mergeStarted=true;
      if(progressed)return {removed:0,examined:0,merged:true,done:false};
      // A deletion rolled after this merge opened may sit in a segment the positive steps left alone: the debt stays owed and
      // the merge opens again (one negative step, covering every segment), until a merge finishes with no newer deletion.
      if(!settled){this.mergeStarted=false;return {removed:0,examined:0,merged:true,done:false};}
      this.purge.merging=false;this.mergeStarted=false;
      const done=this.purge.cursor===null;
      if(done)this.purge.live=null;
      return {removed:0,examined:0,merged:false,done};
    }
    // Price the retained posting's emptied gap with R_d, leaving half this delete reservation for its refresh.
    const started=performance.now(),cursor=this.purge.cursor??{id:"checkpoint:",version:-1},reserve=runtimeStepWalBytes(),gapBytes=reserve/(2*MEMW_R_D);
    if(this.purge.live===null)this.purge.mergeAt=1000;
    this.purge.live??=this.entriesLive();
    const live=this.purge.live;
    // 'checkpoint;' is the first key past every 'checkpoint:*' id (';' follows ':'). Rows are read in small chunks as the walk consumes
    // them: a step whose time budget covers a handful of removals must not first read and build all `maxExamined` rows.
    const select=this.db.prepare(`SELECT e.id,e.version,k.fts_rowid FROM entries e LEFT JOIN lexical_keys k ON k.id=e.id AND k.version=e.version
      WHERE (e.id,e.version)>(?,?) AND e.id<'checkpoint;' ORDER BY e.id,e.version LIMIT ?`);
    const removedKeys:string[]=[];
    let examined=0,last:{id:string;version:number}|null=null,ended=false,bulk=false;
    const heldBefore=this.purge.oldest?{...this.purge.oldest}:null;
    try{this.writer.write("delete",reserve,()=>{
      const deleteLexical=this.db.prepare("DELETE FROM lexical WHERE rowid=?"),deleteKey=this.db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?");
      const deleteEntry=this.db.prepare("DELETE FROM entries WHERE id=? AND version=? RETURNING rowid AS r,length(CAST(text AS BLOB)) AS n"),deleteVectors=this.db.prepare("DELETE FROM vectors WHERE id=? AND version=?");
      const recount=this.recountCursor();
      let counted=0,lexicalBytes=0;
      const remove=(id:string,version:number,ftsRowid:unknown)=>{
        ageDeleteRecord(this.db,id,version); // WP2b D5/D8
        if(ftsRowid!==null)deleteLexical.run(ftsRowid as number);
        deleteKey.run(id,version);const gone=deleteEntry.get(id,version);if(gone&&(recount===null||Number(gone.r)<=recount))counted++;deleteVectors.run(id,version);
        if(gone&&ftsRowid!==null)lexicalBytes+=Number(gone.n);
        if(gone&&this.purge.oldest?.id===id)this.purge.oldest.bytes+=Number(gone.n);
        removedKeys.push(`${id}:${version}`);
      };
      // Keep a full chunk's first posting until the id ends: deleting its front repeatedly makes SQLite's scratch FTS work grow.
      const newer=this.db.prepare(`SELECT k.fts_rowid FROM entries e LEFT JOIN lexical_keys k ON k.id=e.id AND k.version=e.version
        WHERE e.id=? AND e.version=? AND EXISTS (SELECT 1 FROM entries n WHERE n.id=e.id AND n.version>e.version)`);
      const flushOldest=()=>{const held=this.purge.oldest;this.purge.oldest=null;if(!held)return;const row=newer.get(held.id,held.version);if(row)remove(held.id,held.version,row.fts_rowid);};
      let from=cursor,timedOut=false;
      while(examined<maxExamined&&!timedOut&&!ended){
        const want=Math.min(WALK_CHUNK,maxExamined-examined),rows=select.all(from.id,from.version,want+1);
        const take=Math.min(rows.length,want);
        for(let n=0;n<take;n++){
          if(examined&&performance.now()-started>=maxMs/2){timedOut=true;break;}
          const row=rows[n],next=rows[n+1],id=String(row.id),version=Number(row.version);
          examined++;last={id,version};
          if(this.purge.oldest&&this.purge.oldest.id!==id)flushOldest();
          if(!next||next.id!==row.id){flushOldest();continue;}
          if(!this.purge.oldest&&rows.length>WALK_CHUNK&&rows[WALK_CHUNK].id===id){this.purge.oldest={id,version,bytes:0};continue;}
          remove(id,version,row.fts_rowid);
          if(this.purge.oldest&&this.purge.oldest.bytes>=gapBytes){timedOut=true;break;}
        }
        if(!timedOut&&rows.length<=want)ended=true;
        else if(last)from=last;
      }
      if(ended)flushOldest();
      if(counted)metaPutter(this.db)(ENTRIES_LIVE,String(Math.max(0,this.entriesLive()-counted)));
      if(lexicalBytes)this.moveToDebt("lexical",lexicalBytes);
      bulk=this.purge.since+removedKeys.length>=Math.max(this.purge.mergeAt,mergeFraction*Math.max(0,live-removedKeys.length))||(this.purge.oldest?.bytes??0)>=gapBytes;
      if(bulk&&this.purge.oldest){
        // A genuine posting refresh gives FTS5 a second segment, so its bounded merge can retire this segment's emptied pages.
        this.db.prepare("UPDATE lexical SET text=text WHERE rowid=(SELECT fts_rowid FROM lexical_keys WHERE id=? AND version=?)").run(this.purge.oldest.id,this.purge.oldest.version);
        this.purge.oldest.bytes=0;
      }
      // Keep the merge obligation in the transaction that deleted the rows, including walks interrupted below the threshold.
      if(removedKeys.length||(this.purge.since&&(ended||bulk)))this.setMergeOwed(true,!bulk);
      if(removedKeys.length)this.bumpDeletionGeneration();
    });}catch(error){this.purge.oldest=heldBefore;throw error;}
    this.purge.live=Math.max(0,this.purge.live-removedKeys.length);this.purge.since+=removedKeys.length;
    this.purge.cursor=ended?null:last;
    // A bulk removal (a pass that has taken a mergeFraction of what is left, at least `mergeAt` entries) leaves emptied pages that only a
    // merge returns; its merge work follows the volume removed, in short steps. `mergeAt` starts at 1,000 and doubles with each merge of a
    // pass, so a count of live entries that is stale (rows loaded outside the writer) costs a handful of merges, not one per 1,000 entries.
    // A trickle (one rollover per turn) stays direct: FTS secure-delete erased it in place and a forced merge would read every
    // historical segment (bd9960b116).
    if(this.purge.since&&(ended||bulk)){if(bulk)this.purge.mergeAt*=2;this.purge.since=0;this.purge.merging=true;}
    const done=ended&&!this.purge.merging;
    if(done)this.purge.live=null;
    return {removed:removedKeys.length,examined,merged:false,done};
  }
  /** Where the rolled-checkpoint purge is: the walk's position (null: at the start), entries left in the index (counted
   * when a pass starts), entries removed since the last merge, whether merge steps are running, and the oldest rolled version of
   * the checkpoint the walk is in, held until the walk leaves it. */
  private purge:{cursor:{id:string;version:number}|null;live:number|null;since:number;merging:boolean;mergeAt:number;oldest:{id:string;version:number;bytes:number}|null}={cursor:null,live:null,since:0,merging:false,mergeAt:1000,oldest:null};
  async vector(record: IndexedMemory, model: string, part: number, values: number[]) {
    const array=new Float32Array(values);
    if(!(await this.settle()))throw new Error("MEMORY_INDEX_CHECK_OWED");
    if(!this.keepGoing())return;
    // One checked txn (I1/I2): the row's bytes x R_w plus the insert frames, and the delete of an older model's row of the
    // same size (q1022-disk: once the record has its vector for this model, its vectors for any other model are dead; search
    // reads one model, so nothing searchable goes before its replacement is in).
    // The resident set drops the deleted rows itself (memory_vectors_resident_d marks them dirty).
    this.writer.write("group",array.byteLength*MEMW_R_W+MEMW_F_INS_FRAMES*(this.writer.pageSize+24)+array.byteLength*MEMW_R_D+MEMW_F_DEL_FRAMES*frameBytes(this.writer.pageSize),()=>{
      this.db.prepare("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?)").run(record.id,record.version,model,part,Buffer.from(array.buffer));
      this.db.prepare("DELETE FROM vectors WHERE id=? AND version=? AND model<>?").run(record.id,record.version,model);
    });
    await this.settle();
  }
  /** Load the model's vectors resident before readiness (up to residentVectorLimits.bytes; the rest is read per search). Never throws
   * for size: a large memory keeps meaning search. */
  prepareModel(model:string,_allowed?:Array<{id:string;version:number}>){this.residentFor(model);}
  /** The temp trigger that names every vector write on this connection, installed once per attached file. */
  private hookResident():boolean{
    if(this.residentHooked===this.db)return true;
    if(!this.hasTable("vectors"))return false;
    try{
      this.db.function("memory_vector_dirty",{deterministic:false,varargs:false},(id:unknown,version:unknown)=>{
        if(this.residentDirty.size<RESIDENT_DIRTY_LIMIT)this.residentDirty.add(`${id}:${Number(version)}`);else this.resident=null;
        return null;
      });
      this.db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS memory_vectors_resident_i AFTER INSERT ON main.vectors BEGIN SELECT memory_vector_dirty(NEW.id,NEW.version); END;
        CREATE TEMP TRIGGER IF NOT EXISTS memory_vectors_resident_u AFTER UPDATE ON main.vectors BEGIN SELECT memory_vector_dirty(OLD.id,OLD.version); SELECT memory_vector_dirty(NEW.id,NEW.version); END;
        CREATE TEMP TRIGGER IF NOT EXISTS memory_vectors_resident_d AFTER DELETE ON main.vectors BEGIN SELECT memory_vector_dirty(OLD.id,OLD.version); END;`);
    }catch{return false;}
    this.residentHooked=this.db;this.resident=null;this.residentDirty.clear();
    return true;
  }
  /** The resident vectors of `model`, current with the file; null when they cannot be kept (the caller reads the table). */
  private residentFor(model:string){
    if(!this.hookResident()||(this.db as {isTransaction?:boolean}).isTransaction)return null;
    const dataVersion=Number(this.db.prepare("PRAGMA data_version").get()!.data_version);
    const vector=(bytes:Uint8Array)=>new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    if(!this.resident||this.resident.model!==model||this.resident.dataVersion!==dataVersion){
      this.residentDirty.clear();
      const resident={model,dataVersion,bytes:0,complete:true,rows:new Map<string,Float32Array[]>()};
      let key="",parts:Float32Array[]=[],bytes=0;
      for(const row of this.db.prepare("SELECT id,version,vector FROM vectors WHERE model=? ORDER BY id,version,part").iterate(model)){
        const next=`${row.id}:${row.version}`,values=vector(row.vector as Uint8Array);
        if(next!==key){if(parts.length){resident.rows.set(key,parts);resident.bytes+=bytes;}key=next;parts=[];bytes=0;}
        if(resident.bytes+bytes+values.byteLength>residentVectorLimits.bytes){parts=[];resident.complete=false;break;}
        parts.push(values);bytes+=values.byteLength;
      }
      if(parts.length){resident.rows.set(key,parts);resident.bytes+=bytes;}
      this.resident=resident;
      return resident;
    }
    const resident=this.resident;
    if(this.residentDirty.size){
      const read=this.db.prepare("SELECT vector FROM vectors WHERE id=? AND version=? AND model=? ORDER BY part");
      for(const key of this.residentDirty){
        const at=key.lastIndexOf(":"),old=resident.rows.get(key);
        if(old){resident.bytes-=old.reduce((n,v)=>n+v.byteLength,0);resident.rows.delete(key);}
        const parts=read.all(key.slice(0,at),Number(key.slice(at+1)),model).map(row=>vector(row.vector as Uint8Array));
        if(!parts.length)continue;
        const bytes=parts.reduce((n,v)=>n+v.byteLength,0);
        if(resident.bytes+bytes>residentVectorLimits.bytes){resident.complete=false;continue;}
        resident.rows.set(key,parts);resident.bytes+=bytes;
      }
      this.residentDirty.clear();
    }
    return resident;
  }
  /** The vectors of exactly these records, read straight from the table and kept nowhere: the records the resident set does not
   * hold. Every one is read (no cap): one chunk is at most the eligible chunk of records, and their parts are all scored. */
  private vectorsOf(allowed:Array<{id:string;version:number}>,model:string){
    const rows=this.db.prepare("SELECT v.id,v.version,v.part,v.vector FROM json_each(?) a JOIN vectors v ON v.id=json_extract(a.value,'$.id') AND v.version=json_extract(a.value,'$.version') WHERE v.model=?").all(JSON.stringify(allowed),model);
    return rows.map(row=>{
      const bytes=row.vector as Uint8Array;
      return {id:String(row.id),version:Number(row.version),key:`${row.id}:${row.version}`,values:new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))};
    });
  }
  search(query: string, allowed: Array<{id:string;version:number}>, embedding: number[] | null, model: string, limit=20, options: IndexSearchOptions = {}) {
    const started=performance.now();
    if(this.openState==="pending"&&!this.hasTable("lexical"))return {hits:[] as IndexHit[],vectorRows:0,lexicalRanked:[] as RankedRef[],vectorRanked:[] as RankedRef[],timings:{lexicalMs:0,matrixMs:0,vectorMs:0}};
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
      const matrixStart=performance.now();
      const resident=this.residentFor(model);
      let source:Array<{id:string;version:number;key:string;values:Float32Array}>;
      if(!resident)source=this.vectorsOf(allowed,model);
      else{
        source=[];const absent:Array<{id:string;version:number}>=[];
        for(const row of allowed){
          const key=`${row.id}:${row.version}`,parts=resident.rows.get(key);
          if(parts)for(const values of parts)source.push({id:row.id,version:row.version,key,values});
          else if(!resident.complete)absent.push(row);
        }
        if(absent.length)for(const row of this.vectorsOf(absent,model))source.push(row);
      }
      matrixMs=performance.now()-matrixStart;
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
  /** The database handle first, then the log reader: closing a descriptor on the shm drops this process's locks on it (io-written.ts). */
  close(){this.closeAll();}
  /** Cumulative WAL bytes written through this index (win32 io accounting); 0 when unreadable. */
  ioBytes():number{try{return this.wal?.()??0;}catch{return 0;}}
}
