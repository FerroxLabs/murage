import { wholeTurnText } from "./capture.ts";
import { executionStore, threadPartition, isHomePartition } from "../execution-audience.ts";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { database, transaction } from "../database.ts";
import { assertHumanPrincipal, isWorkspaceOwner, threadHumanPrincipal } from "../human-principals.ts";
import { redactSecretsInText } from "../redact.ts";
import { botIdentityRecordId } from "./identity.ts";
import { groundMemoryClaim, type TextOnlyExtractor } from "./extract.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import type { MemoryRoster } from "./policy.ts";
import { revokeRecordDisclosures } from "./revocation.ts";

type Receipt={cursor:string;status:"pending"|"complete";retryAt:number;reason?:string;attempts?:number};
/** A minute, doubling while the SAME reason keeps coming back, up to an hour.
 *  The owner's store held 25,164 reveal receipts parked on
 *  `reveal-source-ineligible` — a verdict about the job's own immutable
 *  source and the shape of the roster, which a minute's wait was never going
 *  to change — and every one of them came back around every sixty seconds,
 *  for as long as the app ran, with more added on every bot turn. Nothing is
 *  abandoned here: the job is still retried, just not fourteen hundred times
 *  a day to be told the same thing. A DIFFERENT reason resets the clock, so a
 *  genuinely transient failure never inherits a stuck job's patience. */
export const revealRetryAt=(saved:Receipt,reason:string)=>{
  const attempts=saved.reason===reason?(saved.attempts??0)+1:1;
  return {attempts,retryAt:Date.now()+Math.min(60_000*2**(attempts-1),3_600_000)};
};
const receiptId=(jobId:string)=>`reveal-capture:${jobId}`;
function receipt(db:DatabaseSync,jobId:string):Receipt {
  const row=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(receiptId(jobId));
  return row?JSON.parse(String(row.intent)):{cursor:"",status:"pending",retryAt:0};
}
function persist(db:DatabaseSync,jobId:string,scope:string,value:Receipt){
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','reveal-capture',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
    .run(receiptId(jobId),scope,JSON.stringify(value));
  // only after the write: a failed write leaves the job where the database says it is
  noteRetry(jobId,value);
}
/** How many job rowids one polling visit may look at. The neighbouring
 *  pollers (pendingMemoryConsolidationJobs, pendingProcedureReviews) are
 *  bounded the same way and for the same reason. */
const REVEAL_SCAN_WINDOW=4096;
/** Jobs below the mark that may still need a reveal pass (not complete yet,
 *  or complete under a retired source) are remembered by rowid up to this
 *  many; past it the mark stops advancing rather than lose one. */
const REVEAL_OPEN_LIMIT=256;
/** Reveal receipts read per retry sweep visit. */
const REVEAL_RETRY_WINDOW=1024;
const ELIGIBLE_SOURCE=`s.kind='text' AND s.speaker NOT IN ('owner','tool','harness') AND s.speaker NOT LIKE 'person:%'`;
/** Jobs in a rowid range that are not settled: capture may still finish, the
 *  source may still come back, or no reveal receipt exists yet (`cand`). Rowid
 *  range access only; NOT INDEXED keeps the planner off the status index. */
export const REVEAL_RANGE_SQL=`SELECT j.rowid AS rid,j.id,
    (j.status='complete' AND s.state='active' AND b.id IS NULL) AS cand
  FROM memory_jobs j NOT INDEXED JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
  LEFT JOIN memory_scope_bindings b ON b.id='reveal-capture:'||j.id
  WHERE j.rowid>? AND j.rowid<=? AND j.stage='capture' AND ${ELIGIBLE_SOURCE}
  AND (j.status IN ('pending','leased','partial','deferred')
    OR (j.status='complete' AND (s.state='retired' OR (s.state='active' AND b.id IS NULL))))
  ORDER BY j.rowid`;
/** The same test for jobs named by rowid (the open set). */
export const REVEAL_OPEN_SQL=REVEAL_RANGE_SQL.replace("WHERE j.rowid>? AND j.rowid<=?","WHERE j.rowid IN (SELECT value FROM json_each(?))");
/** Reveal receipts through the (subject_type,subject_id) index, in rowid order. */
export const REVEAL_RETRY_SQL=`SELECT rowid AS rid,id,intent FROM memory_scope_bindings
  WHERE subject_type='system' AND subject_id='reveal-capture' AND state='granted' AND rowid>? ORDER BY rowid LIMIT ?`;
const REVEAL_ELIGIBLE_SQL=`SELECT 1 FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
  WHERE j.id=? AND j.stage='capture' AND j.status='complete' AND s.state='active' AND ${ELIGIBLE_SOURCE}`;
const MARK_ID="reveal-scan-mark";
/** `spill` is the rowid range whose unsettled jobs did not fit the open set; it is swept again, a window at a time, only while the set has room. */
interface ScanMark{hwm:number;open:number[];spill?:{from:number;to:number}}
/** In memory: the loaded mark, the receipt sweep and the jobs known to be due
 *  now. Everything here is rebuilt from the database after a restart. */
const scan={db:null as DatabaseSync|null,mark:{hwm:0,open:[]} as ScanMark,retryCursor:0,retryWake:0,cycleMin:Infinity,eventMin:Infinity,cycleCandidates:false,hot:new Set<string>(),
  /** Pending receipts by job id with the time each is due, filled by the first full pass over the receipts and kept current by every write this module makes. Once `loaded`, the sweep reads no receipt rows but the ones that are due. */
  known:new Map<string,number>(),loaded:false};
/** The most receipts held in memory; beyond it the sweep keeps reading the table in windows. */
const KNOWN_LIMIT=200_000;
/** A receipt that is due but whose job is not eligible (the job's own state, not the roster) is looked at again after this. */
const INELIGIBLE_RECHECK_MS=600_000;
/** Forget what is held in memory, as a restart does: the persisted mark remains. */
export function resetRevealScan(){scan.db=null;scan.mark={hwm:0,open:[]};scan.retryCursor=0;scan.retryWake=0;scan.cycleMin=Infinity;scan.eventMin=Infinity;scan.cycleCandidates=false;scan.hot.clear();scan.known.clear();scan.loaded=false;}
function loadScan(db:DatabaseSync){
  if(scan.db===db)return;
  resetRevealScan();scan.db=db;
  const row=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(MARK_ID);
  if(row){try{const saved=JSON.parse(String(row.intent));if(Number.isSafeInteger(saved.hwm)&&saved.hwm>=0&&Array.isArray(saved.open))scan.mark={hwm:saved.hwm,open:saved.open.filter((n:unknown)=>Number.isSafeInteger(n)).slice(0,REVEAL_OPEN_LIMIT) as number[],...(Number.isSafeInteger(saved.spill?.from)&&Number.isSafeInteger(saved.spill?.to)&&saved.spill.from<=saved.spill.to?{spill:{from:saved.spill.from,to:saved.spill.to}}:{})};}catch{/* an unreadable mark scans from the start */}}
}
function saveMark(db:DatabaseSync){
  const scope=db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id;
  if(!scope)return;
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','reveal-scan',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
    .run(MARK_ID,scope,JSON.stringify(scan.mark));
}
/** A receipt was written pending: the sweep must not sleep past its retry time. */
function noteRetry(jobId:string,value:Receipt){
  if(value.status!=="pending"){scan.known.delete(jobId);return;}
  if(scan.known.size<KNOWN_LIMIT||scan.known.has(jobId))scan.known.set(jobId,value.retryAt);else scan.loaded=false;
  scan.eventMin=Math.min(scan.eventMin,value.retryAt);scan.retryWake=Math.min(scan.retryWake,value.retryAt);
  if(value.retryAt<=Date.now()&&scan.hot.size<64)scan.hot.add(jobId);
}
/** Completed capture jobs whose reveal pass has not run, found without
 * reading the table again and again.
 *
 * A persisted high-water mark (memory_scope_bindings, like the park sweep and
 * origin backfill) records how far the job table has been looked at. A visit
 * reads one cheap probe (the newest rowid) and, only when rows exist past the
 * mark, one rowid-range window of them; it never wraps back to 0. Jobs below
 * the mark that may still need a pass are kept in a small open set. Receipts
 * that were deferred or are partway through are found by a sweep over the
 * reveal receipts through their index, which sleeps until the earliest retry
 * time it has seen.
 *
 * This used to walk the whole table in 4096-rowid windows, forever, from
 * rowid 0 again at every launch: on a 735 MB store that held 75-100% of a core
 * for six minutes. (An earlier, unbounded version sorted every completed job:
 * 669 ms a visit. Measured 2026-09-22.) */
export function pendingBotRevealJobs(limit=1):string[]{
  const db=database(),want=Math.min(4,Math.max(1,Math.trunc(limit)||1));
  loadScan(db);
  const found:string[]=[],take=(id:string)=>{if(!found.includes(id)&&found.length<want)found.push(id);};
  const now=Date.now(),eligible=db.prepare(REVEAL_ELIGIBLE_SQL);
  for(const id of [...scan.hot]){scan.hot.delete(id);if(eligible.get(id))take(id);}
  let dirty=false;
  if(scan.mark.open.length){
    const rows=db.prepare(REVEAL_OPEN_SQL).all(JSON.stringify(scan.mark.open));
    const open=rows.map(row=>Number(row.rid));
    if(open.length!==scan.mark.open.length||open.some((rid,index)=>rid!==scan.mark.open[index])){scan.mark.open=open;dirty=true;}
    for(const row of rows)if(row.cand)take(String(row.id));
  }
  const started=performance.now();
  for(let visits=0;found.length<want&&visits<8&&(visits===0||performance.now()-started<10);visits++){
    const newest=Number(db.prepare("SELECT max(rowid) AS last FROM memory_jobs").get()?.last??0);
    if(scan.mark.hwm>newest){scan.mark.hwm=newest;dirty=true;}
    const mark=scan.mark,room=REVEAL_OPEN_LIMIT-mark.open.length;
    if(mark.spill&&mark.spill.to>newest){mark.spill.to=newest;dirty=true;}
    if(mark.hwm<newest){
      const upto=Math.min(newest,mark.hwm+REVEAL_SCAN_WINDOW);
      const rows=db.prepare(REVEAL_RANGE_SQL).all(mark.hwm,upto);
      const kept=rows.slice(0,Math.max(0,room));
      // The mark always moves to the end of the window. Unsettled jobs that do
      // not fit the open set are recorded as a spill range, never re-read on
      // every visit: stalling the mark here re-scanned the window forever.
      if(rows.length>kept.length){const from=Number(rows[kept.length].rid);mark.spill={from:Math.min(mark.spill?.from??from,from),to:Math.max(mark.spill?.to??upto,upto)};}
      mark.hwm=upto;
      mark.open=[...mark.open,...kept.map(row=>Number(row.rid))];dirty=true;
      for(const row of kept)if(row.cand)take(String(row.id));
    }else if(mark.spill&&room>0){
      const upto=Math.min(mark.spill.to,mark.spill.from-1+REVEAL_SCAN_WINDOW);
      const rows=db.prepare(REVEAL_RANGE_SQL).all(mark.spill.from-1,upto).filter(row=>!mark.open.includes(Number(row.rid)));
      const kept=rows.slice(0,room);
      mark.open=[...mark.open,...kept.map(row=>Number(row.rid))];
      mark.spill=rows.length>kept.length?{from:Number(rows[kept.length].rid),to:mark.spill.to}:upto<mark.spill.to?{from:upto+1,to:mark.spill.to}:undefined;
      if(!mark.spill)delete mark.spill;
      dirty=true;
      for(const row of kept)if(row.cand)take(String(row.id));
    }else break;
  }
  if(dirty)saveMark(db);
  if(found.length<want&&now>=scan.retryWake){
    if(scan.loaded)sweepKnown(db,now,want,found,take,eligible);
    else{
      const rows=db.prepare(REVEAL_RETRY_SQL).all(scan.retryCursor,REVEAL_RETRY_WINDOW);
      for(const row of rows){
        scan.retryCursor=Number(row.rid);
        let value:Receipt;try{value=JSON.parse(String(row.intent));}catch{continue;}
        if(value.status!=="pending")continue;
        const jobId=String(row.id).slice("reveal-capture:".length);
        if(scan.known.size<KNOWN_LIMIT||scan.known.has(jobId))scan.known.set(jobId,value.retryAt);
        if(value.retryAt>now){scan.cycleMin=Math.min(scan.cycleMin,value.retryAt);continue;}
        if(found.length<want&&eligible.get(jobId)){take(jobId);scan.cycleCandidates=true;}
      }
      if(rows.length<REVEAL_RETRY_WINDOW){
        // A full pass over the receipts: sleep until the earliest retry seen, or a second if one was just handed out.
        const earliest=Math.min(scan.cycleMin,scan.eventMin,scan.cycleCandidates?now+1000:Infinity);
        scan.retryWake=earliest;scan.retryCursor=0;scan.cycleMin=Infinity;scan.eventMin=Infinity;scan.cycleCandidates=false;
        // Every pending receipt is now in memory: later sweeps never read the table again.
        scan.loaded=scan.known.size<KNOWN_LIMIT;
      }
    }
  }
  return found;
}
/** The sweep once every pending receipt is held in memory: only the receipts that are due are read (one primary-key read each, to be sure the row is still pending and due), and the wake time is the earliest due time left. */
// At most this many receipts are read in one sweep. Live, thousands were due at
// once and every sweep read all of them to hand out one job: about 2 million
// primary-key reads a minute.
const SWEEP_READ_LIMIT=64;
function sweepKnown(db:DatabaseSync,now:number,want:number,found:string[],take:(id:string)=>void,eligible:StatementSync){
  const due:Array<[string,number]>=[];let next=Infinity;
  for(const [jobId,at] of scan.known){if(at<=now)due.push([jobId,at]);else next=Math.min(next,at);}
  // Oldest due first; stop once enough are found or the read budget is spent.
  // Whatever is still due is looked at by the next sweep, a second from now.
  due.sort((a,b)=>a[1]-b[1]);
  const read=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?");
  let reads=0;
  for(const [jobId] of due){
    if(found.length>=want||reads>=SWEEP_READ_LIMIT){next=Math.min(next,now+1000);break;}
    reads++;
    const row=read.get(receiptId(jobId));
    let value:Receipt|undefined;try{value=row?JSON.parse(String(row.intent)):undefined;}catch{/* unreadable: dropped below */}
    if(!value||value.status!=="pending"){scan.known.delete(jobId);continue;}
    if(value.retryAt>now){scan.known.set(jobId,value.retryAt);next=Math.min(next,value.retryAt);continue;}
    if(eligible.get(jobId)){take(jobId);next=Math.min(next,now+1000);}
    else{scan.known.set(jobId,now+INELIGIBLE_RECHECK_MS);next=Math.min(next,now+INELIGIBLE_RECHECK_MS);}
  }
  scan.retryWake=Math.min(next,scan.eventMin);scan.eventMin=Infinity;
}
function sourceFor(jobId:string,roster:MemoryRoster){
  const db=database(),source=db.prepare(`SELECT s.*,v.payload,j.cursor,length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS bytes
    FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE j.id=? AND j.stage='capture' AND j.status='complete' AND s.state='active'`).get(jobId);
  if(!source||source.kind!=="text"||source.cursor!==source.bytes||!source.message_id)return null;
  if(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision))return null;
  const raw=db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(source.thread_id,source.message_id);
  if(!raw)return null;
  const message=JSON.parse(String(raw.json)),payload=JSON.parse(String(source.payload));
  if(message.kind!=="text"||message.role!=="bot"||message.turnTerminal!==true||typeof message.text!=="string"||redactSecretsInText(wholeTurnText(db,String(source.thread_id),message))!==payload.text)return null;
  const threadId=String(source.thread_id);
  if(roster.groups.some(g=>g.threadId===threadId||g.tasks?.some(t=>t.threadId===threadId)))return null;
  const bots=roster.bots.filter(b=>b.threadId===threadId||b.tasks?.some(t=>t.threadId===threadId));
  if(bots.length!==1||message.from?.botId&&message.from.botId!==bots[0].id||!["assistant",bots[0].id].includes(String(source.speaker)))return null;
  const bot=executionStore()?.bot(bots[0].id);
  if(bot?.partitionedAt!==undefined&&!isHomePartition(threadPartition(bot,threadId)))return null;
  const principal=threadHumanPrincipal(threadId);assertHumanPrincipal(principal);
  if(!isWorkspaceOwner(principal))return null;
  const meta=db.prepare("SELECT mode,policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  if(!["capture","active"].includes(String(meta.mode))||db.prepare("SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.state!=="granted")return null;
  if(db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=?").get(threadId))return null;
  const scope=db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(bots[0].id);
  if(!scope)return null;
  return {source,text:String(payload.text),botId:bots[0].id,scopeId:String(scope.id),meta,principal};
}
function liveCanon(db:DatabaseSync,scopeId:string,cursor:string){
  return db.prepare(`SELECT r.id,r.version,r.text FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    WHERE r.scope_id=? AND r.kind='character-canon' AND r.state='active' AND d.partition='identity' AND r.id>?
    AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))
    ORDER BY r.id LIMIT 1`).get(scopeId,cursor);
}
/** One canonical detail per visit, under the existing worker's single synthesis
 * slot. Only the whole-message equality path is deterministic; every paraphrase
 * needs the configured, budgeted grounding evaluator. No model memory-tool call
 * or supplied audience controls this observation. */
export async function captureBotReveals(jobId:string,roster:()=>MemoryRoster,extractor:TextOnlyExtractor|null,signal:AbortSignal){
  const db=database(),saved=receipt(db,jobId);
  if(saved.status==="complete")return {status:"unchanged" as const};
  const ineligible=(reason:string)=>{
    const source=db.prepare("SELECT s.scope_id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?").get(jobId);
    if(source)persist(db,jobId,String(source.scope_id),{...saved,status:"pending",reason,...revealRetryAt(saved,reason)});
    return {status:"deferred" as const,reason};
  };
  let observed:ReturnType<typeof sourceFor>;
  try{observed=sourceFor(jobId,roster());}catch{return ineligible("reveal-authority-unavailable");}
  const initial=observed;
  if(!initial)return ineligible("reveal-source-ineligible");
  const learning=readMemoryLearning(db);
  const defer=(reason:string)=>{
    persist(db,jobId,String(initial!.source.scope_id),{...saved,status:"pending",reason,...revealRetryAt(saved,reason)});
    return {status:"deferred" as const,reason};
  };
  if(signal.aborted||!learning.automaticFacts)return defer("reveal-learning-disabled-or-cancelled");
  const canon=liveCanon(db,initial.scopeId,saved.cursor);
  if(!canon){persist(db,jobId,String(initial.source.scope_id),{...saved,status:"complete",retryAt:0});return {status:"complete" as const};}
  if(!initial.text.trim()||Buffer.byteLength(initial.text)>65536)return defer("reveal-source-budget");
  const exact=initial.text===canon.text;
  const support=exact?{supported:true,reason:"exact-terminal-canon"}:await groundMemoryClaim({purpose:"reveal",text:String(canon.text),quote:initial.text,claimType:"reveal-state",speaker:initial.botId,outcome:"visible-terminal-message"},extractor,signal);
  if(!support.supported&&support.reason!=="unsupported-claim")return defer(support.reason);
  return transaction(()=>{
    const current=sourceFor(jobId,roster()),now=Date.now();
    if(signal.aborted||!current||current.source.revision!==initial.source.revision||current.meta.policy_revision!==initial.meta.policy_revision||current.meta.deletion_epoch!==initial.meta.deletion_epoch||JSON.stringify(current.principal)!==JSON.stringify(initial.principal)||readMemoryLearning(db).revision!==learning.revision||receipt(db,jobId).cursor!==saved.cursor)throw new Error("MEMORY_REVEAL_REVOKED");
    const currentCanon=liveCanon(db,current.scopeId,saved.cursor);
    if(!currentCanon||currentCanon.id!==canon.id||currentCanon.version!==canon.version)throw new Error("MEMORY_REVEAL_CANON_CHANGED");
    let written=false;
    if(support.supported){
      const id=botIdentityRecordId(current.botId,"reveal-state",String(canon.id));
      const previous=db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
      const tombstoned=db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(id);
      const previousCanon=previous&&db.prepare("SELECT parent_id,parent_version FROM memory_derivations WHERE child_id=? AND child_version=? AND parent_id=?").get(id,previous.version,canon.id);
      // Repeated disclosure adds no duplicate version. Explicit owner changes,
      // pins and forgetting are never overwritten by the automatic observer.
      if(!tombstoned&&(!previous||previous.assertion!=="owner-statement"&&previous.owner_pinned!==1&&previous.state==="active"&&previousCanon?.parent_version!==canon.version)){
        const version=Number(previous?.version??0)+1,state=learning.reviewMode?"candidate":"active";
        if(previous)db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(now,id,previous.version);
        const text=JSON.stringify({canonId:canon.id,canonVersion:canon.version,audience:"owner-private",revealed:true,note:`Observed disclosure of fictional canon: ${String(canon.text)}`});
        db.prepare("INSERT INTO memory_records VALUES(?,?,?,'reveal-state',?,'assistant-inference',?,0,?,NULL,?,?)").run(id,version,current.scopeId,text,state,now,previous?id:null,now);
        db.prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis=?,entities=? WHERE record_id=? AND record_version=?")
          .run(`Observed terminal disclosure (${support.reason}); fictional continuity only, not world truth`,JSON.stringify(["owner-private",canon.id]),id,version);
        db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(canon.id,canon.version,id,version);
        db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,0,?)").run(id,version,current.source.id,current.source.revision,Buffer.byteLength(current.text));
        db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(id,version);
        db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
        revokeRecordDisclosures(db,"reveal-capture",{recordIds:[id],viaSources:false});
        written=true;
      }
    }
    persist(db,jobId,String(current.source.scope_id),{cursor:String(canon.id),status:"pending",retryAt:0});
    return {status:"partial" as const,written,canonId:String(canon.id)};
  });
}
