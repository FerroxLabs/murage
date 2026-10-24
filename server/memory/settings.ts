import { partitionOfScopeKey, executionStore, homeThread } from "../execution-audience.ts";
import { teamLabel } from "../team-identities.ts";
import { candidateReviewReason } from "./automatic-learning.ts";
import { learningHistory,changeLearningEvent,undoOwnsItsTransactions } from "./learning-history.ts";
import type { LearningConnection } from "./extractor-connections.ts";
import { humanBindingStatus, linkHumanBinding, shareHumanScope } from "../human-principals.ts";
import { continuityReadSchema, deleteBotIdentity, rejectGenericForgetOfPip, identityDeleteSchema, identityReadSchema, identityWriteSchema, readBotIdentity, readContinuity, writeBotIdentity } from "./identity.ts";
import { isPipKind } from "./pip-kinds.ts";
import { confirmPipProposal, dismissPipProposal, keepPipRecord, listProposals, pipDisputes } from "./pip-lived.ts";
import { reflectionStatus, retryReflection, setReflectExcluded } from "./pip-reflect.ts";
import { supportsNativeMemoryModel } from "./embeddings.ts";
import { bundledModelState } from "./model-location.ts";
import { rebuildSearchIndex, semanticIndexStatus } from "./model-adoption.ts";
import { archiveMemoryRecord, restoreArchivedMemoryRecord, memoryRetentionStatus } from "./retention.ts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { realpathSync } from "node:fs";
import { samePath } from "../../shared/path-identity.mjs";
import { z } from "zod";
import { DATA_DIR } from "../config.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";
import { database, memoryHoldCode, transaction } from "../database.ts";
import { holdMessage } from "./integrity-pass.ts";
import { requireMemoryOwner, approveMemory, pinMemory, correctMemory, bindMemoryScope, readCorrectionTarget, rememberMemory, REMEMBER_TEXT_MAX } from "./authority.ts";
import { LAM_PROVIDERS } from "../../shared/learn-about-me/parse.ts";
import { forgetMemory, memoryDeletionStatus, MEMORY_COUNT_CAP } from "./forget.ts";
import { backgroundMemoryScopes, ensureScope, type MemoryRoster } from "./policy.ts";
import { memoryState } from "./repository.ts";
import { memoryCaptures, memoryRecalls } from "./capture-gate.ts";
import { previewMemoryImport, commitMemoryImport, availableMemoryNotebooks, memoryNotebookLinks, stopTrackingMemoryNotebook, migrateDetectedMemoryNotebooks } from "./import.ts";
import { ownerMemoryList } from "./owner-list.ts";
import { pastChatsCounters } from "./past-chats-build.ts";
import type { MemoryRecord } from "../../shared/memory.ts";
import { prepareMemorySkillReview } from "../skills.ts";
import { learningCeilingSchema, memoryLearningPatchSchema, readMemoryLearning, retrySkippedRequestSchema, updateMemoryLearning } from "./learning-policy.ts";
import { ceilingReached, learningSpendLedgerId, learningSpendMonth, type LearningCeilingStatus } from "../../shared/memory-learning-contract.ts";
import { releaseCeilingDeferrals, retrySkippedSlice } from "./consolidate.ts";
import { clearUnseenExcess, unmeteredPause } from "./extract.ts";
import type { MemoryEvolutionRuntime } from "./evolution-runtime.ts";
import type { ProcedureEvaluatorBridge } from "./procedure-evaluator.ts";
import { memoryHealth } from "./health.ts";
import { forgetParkedThreads } from "./park.ts";
import { revokeAllDisclosures } from "./revocation.ts";
import { reviewBack, reviewEdit, reviewKeep, reviewKeepAll, reviewLater, reviewList, reviewSources, reviewSummary, reviewUndo } from "./review.ts";
import { sealedTurnSummary } from "./reset-watch.ts";
import { inheritEdge } from "./revoke-commit.ts";
import { insertMemoryRecord } from "./record-write.ts";
import { maskFinancialIdentifiers } from "../../shared/financial-ids.ts";

const SETTINGS="memory-owner-settings";
type Configuration={excludedThreadIds:string[];extractorInstanceId:string|null};
interface Extractor {instanceId:string;label:string;eligible:boolean;reason?:string}
export interface MemoryOwnerOptions {
  learningConnection?:()=>LearningConnection;
  learningDefaultOn?:()=>boolean;
  evolution?:MemoryEvolutionRuntime;
  procedureEvolution?:ProcedureEvaluatorBridge;
  humanBindingChanged?:(bindingId:string)=>Promise<void>;
  extractors?:()=>Extractor[];
  runtimeStatus?:()=>{running?:boolean;ready?:boolean;indexing?:boolean;queryCount?:number;error?:string|null;indexNote?:string};
  onModelReady?:()=>Promise<void>;
  startSkillReview?:(input:{botId:string;record:{id:string;version:number};source:string;request:string})=>Promise<{botId:string;threadId:string;messageId:string}>;
  /** Whether the history upgrade runs now (database.ts backgroundUpgradeRunning): the status then serves its table figures from the last reading. */
  upgradeRunning?:()=>boolean;
}
const id=z.string().min(1).max(180),version=z.number().int().positive();
/** A client-made action id: the key that makes a retried call return the first result. */
const actionId=z.string().regex(/^[\w-]{8,80}$/);
const subject={subjectType:z.enum(["bot","room"]),subjectId:id};
/** The most scope ids one `scope-labels` call resolves. */
export const MEMORY_SCOPE_LABELS_MAX=50;
const actions=z.discriminatedUnion("action",[
  z.object({action:z.literal("learning-history"),botId:id.optional(),cursor:id.optional(),limit:z.number().int().min(1).max(50).optional()}).strict(),
  z.object({action:z.literal("learning-undo"),eventId:id}).strict(),
  z.object({action:z.literal("learning-keep"),eventId:id}).strict(),
  z.object({action:z.literal("waiting-summary")}).strict(),
  z.object({action:z.literal("waiting-list"),subjectType:z.enum(["bot","room","other"]),subjectId:id,tab:z.enum(["waiting","later"]).optional(),cursor:z.string().max(16).optional()}).strict(),
  z.object({action:z.literal("waiting-sources"),id,version}).strict(),
  z.object({action:z.literal("review-keep"),actionId,id,version,correctionPin:z.enum(["transfer","unpin"]).optional()}).strict(),
  z.object({action:z.literal("review-keep-all"),actionId,items:z.array(z.object({id,version}).strict()).min(1).max(500)}).strict(),
  z.object({action:z.literal("review-later"),actionId,id,version}).strict(),
  z.object({action:z.literal("review-back"),id}).strict(),
  z.object({action:z.literal("review-edit"),actionId,id,version,text:z.string().min(1).max(4096),keep:z.boolean().optional(),correctionPin:z.enum(["transfer","unpin"]).optional()}).strict(),
  z.object({action:z.literal("review-undo"),actionId,keepActionId:actionId,id,version}).strict(),
  z.object({action:z.literal("learning-bot"),botId:id,enabled:z.boolean(),learningRevision:z.number().int().nonnegative()}).strict(),
  z.object({action:z.literal("evolution-authorize")}).strict(),
  z.object({action:z.literal("evolution-authorize-classification")}).strict(),
  z.object({action:z.literal("procedure-evaluation-preview"),reviewId:id}).strict(),
  z.object({action:z.literal("procedure-evaluation-authorize"),previewId:id}).strict(),
  z.object({action:z.literal("procedure-evaluation-retry"),reviewId:id}).strict(),
  z.object({action:z.literal("evolution-retry"),jobId:id}).strict(),
  z.object({action:z.literal("evolution-history")}).strict(),
  z.object({action:z.literal("evolution-rollback"),expectedRevision:id,targetRevision:id}).strict(),
  identityReadSchema, identityWriteSchema, identityDeleteSchema, continuityReadSchema,
  z.object({action:z.literal("pip-proposals"),botId:id}).strict(),
  z.object({action:z.literal("pip-proposal-confirm"),botId:id,id,expectedVersion:z.number().int().positive()}).strict(),
  z.object({action:z.literal("pip-proposal-dismiss"),botId:id,id,expectedVersion:z.number().int().positive()}).strict(),
  z.object({action:z.literal("pip-keep"),botId:id,targetId:id,generation:z.number().int().nonnegative(),counterVersion:z.number().int().positive()}).strict(),
  z.object({action:z.literal("pip-reflect-status"),botId:id}).strict(),
  z.object({action:z.literal("pip-reflect-retry"),botId:id}).strict(),
  z.object({action:z.literal("pip-reflect-exclude"),botId:id,threadId:id,excluded:z.boolean()}).strict(),
  z.object({action:z.literal("humans")}).strict(),
  z.object({action:z.literal("human-share"),personId:id,scopeId:id,granted:z.boolean()}).strict(),
  z.object({action:z.literal("human-link"),bindingId:id,expectedRevision:z.number().int().positive(),as:z.enum(["owner","person","unlink"]),personId:id.optional()}).strict(),
  z.object({action:z.literal("list"),query:z.string().max(4096).optional(),scopeId:id.optional(),botId:id.optional(),state:z.enum(["candidate","active","archived","superseded","deleted"]).optional(),cursor:z.string().max(512).optional(),view:z.enum(["search","important","recent","review"]).optional()}).strict(),
  z.object({action:z.literal("scope-labels"),scopeIds:z.array(id).min(1).max(MEMORY_SCOPE_LABELS_MAX)}).strict(),
  z.object({action:z.literal("inspect"),id,version}).strict(),
  z.object({action:z.literal("review-as-skill"),id,version,botId:id}).strict(),
  // correctionPin is the owner's explicit choice when an approved correction
  // replaces a pinned fact; it is never defaulted (decision U-16).
  z.object({action:z.literal("approve"),id,version,correctionPin:z.enum(["transfer","unpin"]).optional()}).strict(),
  z.object({action:z.literal("archive"),id,version}).strict(),
  z.object({action:z.literal("restore-archive"),id,version}).strict(),
  z.object({action:z.literal("pin"),id,version,pinned:z.boolean()}).strict(),
  z.object({action:z.literal("correct"),id,version,text:z.string().min(1).max(4096),correctionPin:z.enum(["transfer","unpin"]).optional()}).strict(),
  // Learn about me: one kept line, the exact words the owner saw, and where they came from (a label only)
  z.object({action:z.literal("remember"),actionId,text:z.string().min(1).max(REMEMBER_TEXT_MAX),origin:z.object({provider:z.enum(LAM_PROVIDERS),date:z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional()}).strict().optional()}).strict(),
  z.object({action:z.literal("promote"),id,version,scopeId:id}).strict(),
  z.object({action:z.literal("forget"),kind:z.enum(["source","record"]),id,revision:z.number().int().nonnegative().optional()}).strict(),
  z.object({action:z.literal("bind"),scopeId:id,...subject}).strict(),
  z.object({action:z.literal("project"),path:z.string().min(1).max(4096),...subject}).strict(),
  z.object({action:z.literal("configure"),mode:z.enum(["off","capture","active","paused"]).optional(),excludedThreadIds:z.array(id).max(1000).optional(),extractorInstanceId:id.nullable().optional(),learning:memoryLearningPatchSchema.optional(),ceiling:learningCeilingSchema.optional(),learningRevision:z.number().int().nonnegative().optional()}).strict(),
  retrySkippedRequestSchema,
  z.object({action:z.literal("import-preview"),selections:z.array(z.discriminatedUnion("kind",[
    z.object({kind:z.literal("bot"),botId:id,topic:z.string().max(220).optional()}).strict(),
    z.object({kind:z.literal("section"),section:z.string().max(60)}).strict(),
  ])).min(1).max(20)}).strict(),
  z.object({action:z.literal("import-commit"),previewId:id,track:z.boolean().optional()}).strict(),
  z.object({action:z.literal("import-inventory")}).strict(),
  z.object({action:z.literal("import-review-list"),botId:id.optional(),cursor:id.optional()}).strict(),
  z.object({action:z.literal("enable-and-import")}).strict(),
  z.object({action:z.literal("import-stop-tracking"),id}).strict(),
  z.object({action:z.literal("model-download"),confirm:z.literal(true)}).strict(),
  z.object({action:z.literal("rebuild-index")}).strict(),
]);
export function memoryExtractorInstanceId(){return configuration().extractorInstanceId;}
function configuration():Configuration {
  const row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(SETTINGS);
  return row?JSON.parse(String(row.intent)):{excludedThreadIds:[],extractorInstanceId:null};
}
function record(row:Record<string,unknown>):MemoryRecord {
  const reviewReason=row.state==="candidate"?candidateReviewReason(database(),String(row.id),Number(row.version)):undefined;
  return {...(reviewReason?{reviewReason}:{}),id:String(row.id),version:Number(row.version),scopeId:String(row.scope_id),kind:String(row.kind),text:maskFinancialIdentifiers(String(row.text)),assertion:row.assertion as MemoryRecord["assertion"],state:row.state as MemoryRecord["state"],ownerPinned:row.owner_pinned===1,validFrom:Number(row.valid_from),validTo:row.valid_to===null?null:Number(row.valid_to)};
}
function getRecord(id:string,version:number){
  const row=database().prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(id,version);
  if(!row)throw new Error("MEMORY_NOT_FOUND");return record(row);
}
function isPipRecord(id:string):boolean{
  const row=database().prepare("SELECT kind FROM memory_records WHERE id=? LIMIT 1").get(id);
  return Boolean(row)&&isPipKind(row!.kind);
}
function reindex(id:string,version:number){
  // Continuity rows never enter the shared recall index.
  if(isPipRecord(id))return;
  database().prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL) ON CONFLICT(record_id,record_version,index_generation) DO UPDATE SET lexical_status='pending',embedding_status='pending',error=NULL").run(id,version);
  database().exec("UPDATE memory_meta SET data_revision=data_revision+1");
}
/** Re-key a project scope stored under an older, non-canonical spelling of
 * `path` so the memories bound to it keep surfacing.
 *
 * Before the native realpath landed, `~/documents/app` and `~/Documents/app`
 * produced two owner_keys for one folder. Adopting the existing row is what
 * keeps this fix from orphaning the scope a user already has: without it the
 * lookup would miss, a second scope would be created, and their memories would
 * quietly stop appearing. Project scopes are one per bound folder, so the scan
 * is over a handful of rows.
 *
 * If a canonically keyed scope already exists the user has both, and merging
 * two scopes' records is not a rename — leave the older row alone rather than
 * collide on it or silently fold one set of memories into another. */
function adoptRespelledProjectScope(path:string):void {
  const db=database();
  if(db.prepare("SELECT 1 FROM memory_scopes WHERE kind='project' AND owner_key=?").get(path))return;
  for(const row of db.prepare("SELECT id,owner_key FROM memory_scopes WHERE kind='project'").all()){
    const owner=String(row.owner_key);
    if(owner===path)continue;
    if(!sameStoredFolder(owner,path))continue;
    db.prepare("UPDATE memory_scopes SET owner_key=?,revision=revision+1 WHERE id=?").run(path,String(row.id));
    return;
  }
}

/** Whether a stored owner_key names the same folder as the freshly canonical
 * `path`.
 *
 * `samePath` settles what is left of a spelling once BOTH sides have been
 * through `realpathSync.native` — which is the one thing a stored key has not
 * been, because it predates that call. So the filesystem, not the string, is
 * the authority here: resolve the stored key too. That is what answers the
 * case this migration exists for, since `samePath` folds case only on Windows
 * and the macOS re-spelling (`~/documents/app` for `~/Documents/app`) is a
 * case difference on a case-insensitive volume.
 *
 * A stored key whose folder is gone cannot be resolved; fall back to comparing
 * the spelling, which still catches a trailing separator or a Windows re-
 * casing. Resolution never widens the match: two spellings resolve alike only
 * when the filesystem says they are one folder. */
function sameStoredFolder(owner:string,path:string):boolean {
  try{return samePath(realpathSync.native(owner),path);}catch{return samePath(owner,path);}
}

function validSubject(roster:MemoryRoster,type:"bot"|"room",id:string){
  if(!(type==="bot"?roster.bots:roster.groups).some(subject=>subject.id===id))throw new Error("MEMORY_SUBJECT_UNKNOWN");
}
function scopeOmission():number{
  const conversations=Number(database().prepare("SELECT count(*) AS n FROM (SELECT 1 FROM memory_scopes WHERE kind='conversation' LIMIT ?)").get(MEMORY_STATUS_SCOPE_LIMIT+1)?.n??0);
  return conversations>MEMORY_STATUS_SCOPE_LIMIT?Number(database().prepare("SELECT count(*) AS n FROM memory_scopes WHERE kind='conversation'").get()?.n??0):0;
}
type ScopeRow=Record<string,unknown>;
function scopeAudience(roster:MemoryRoster,row:ScopeRow){
  const part=partitionOfScopeKey(String(row.kind),String(row.owner_key));
  if(part?.botId && part.partition.kind!=="home") {
    const p=part.partition;
    const label=p.kind==="general"?"Notes for every team":p.kind==="team"?`Notes for ${teamLabel(p.teamId) ?? "deleted team"}`:p.kind==="project"||p.kind==="room"?`Notes for ${(roster.groups.find(g=>g.id===p.groupId) as {name?:string}|undefined)?.name?.trim() || (p.kind==="project"?"a removed project":"a removed channel")}`:"Notes";
    return {id:String(row.id),kind:String(row.kind),ownerKey:String(row.owner_key),label};
  }
  const named=(row.kind==="bot"?roster.bots:roster.groups).find(item=>item.id===row.owner_key) as {name?:string}|undefined;
  return {id:String(row.id),kind:String(row.kind),ownerKey:String(row.owner_key),label:named?.name||(row.kind==="bot"?"A removed bot":row.kind==="room"||row.kind==="project"?"A removed channel":String(row.owner_key))||"General"};
}
function scopeRows(omitConversations=false):ScopeRow[]{return database().prepare(omitConversations?"SELECT id,kind,owner_key FROM memory_scopes WHERE kind<>'conversation' ORDER BY kind,owner_key":"SELECT id,kind,owner_key FROM memory_scopes ORDER BY kind,owner_key").all();}
/** The audiences for the given scope ids, by primary key: how a record in a per-conversation scope the status left out still gets its name. */
function scopeLabels(roster:MemoryRoster,ids:readonly string[]){
  const read=database().prepare("SELECT id,kind,owner_key FROM memory_scopes WHERE id=?");
  return {scopes:[...new Set(ids)].flatMap(id=>{const row=read.get(id);return row?[scopeAudience(roster,row)]:[];})};
}
interface Manifest {model:string;revision:string;files:Array<{path:string;bytes:number;sha256:string}>}
function manifest():Manifest {
  const packaged=join(SERVER_ROOT,"memory-model-manifest.json");
  return JSON.parse(readFileSync(existsSync(packaged)?packaged:join(SERVER_ROOT,"..","shared","memory-model-manifest.json"),"utf8"));
}
type ModelState={state:"missing"|"unverified"|"downloading"|"ready"|"failed";bytesDownloaded:number;totalBytes:number;revision:string;model:string;error?:string;/** true when the model ships inside the app: nothing to download */bundled?:boolean};
let download:ModelState|undefined;
function modelStatus():ModelState {
  const spec=manifest(),totalBytes=spec.files.reduce((sum,file)=>sum+file.bytes,0);
  if(!supportsNativeMemoryModel())return {state:"failed",bytesDownloaded:0,totalBytes,revision:spec.revision,model:spec.model,error:"This install is missing the runtime that runs the local semantic model on this Mac, so it uses keyword memory. Reinstall Murage to restore smart search."};
  const shipped=bundledModelState(spec);
  if(shipped==="verified")return {state:"ready",bytesDownloaded:totalBytes,totalBytes,revision:spec.revision,model:spec.model,bundled:true};
  if(shipped==="checking")return {state:"unverified",bytesDownloaded:totalBytes,totalBytes,revision:spec.revision,model:spec.model,bundled:true};
  if(download)return {...download};
  let present=0;
  for(const file of spec.files){const path=join(DATA_DIR,"memory-model",file.path);try{const stat=lstatSync(path);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===file.bytes)present+=file.bytes;}catch{/* not installed */}}
  return {state:present===totalBytes?"unverified":"missing",bytesDownloaded:present,totalBytes,revision:spec.revision,model:spec.model};
}
async function fileHash(path:string){const hash=createHash("sha256");for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest("hex");}
function ownedModelPath(parts:string[]){
  let path=DATA_DIR;
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error("MEMORY_MODEL_SYMLINK");
  for(const part of ["memory-model",...parts]){
    if(!part||part===".."||part.includes("/")||part.includes("\\"))throw new Error("MEMORY_MODEL_PATH");
    path=join(path,part);if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error("MEMORY_MODEL_SYMLINK");
  }
  return path;
}
async function downloadModel(options:MemoryOwnerOptions){
  const spec=manifest();download={state:"downloading",bytesDownloaded:0,totalBytes:spec.files.reduce((sum,file)=>sum+file.bytes,0),revision:spec.revision,model:spec.model};
  try {
    for(const asset of spec.files){
      const target=ownedModelPath(asset.path.split("/"));mkdirSync(dirname(target),{recursive:true,mode:0o700});
      if(existsSync(target)&&(await stat(target)).size===asset.bytes&&await fileHash(target)===asset.sha256){download.bytesDownloaded+=asset.bytes;continue;}
      const part=ownedModelPath((asset.path+".part").split("/"));
      let offset=existsSync(part)?(await stat(part)).size:0;
      if(offset>asset.bytes)offset=0;
      if(offset<asset.bytes){
        const response=await fetch(`https://huggingface.co/${spec.model}/resolve/${spec.revision}/${asset.path}`,{headers:offset?{Range:`bytes=${offset}-`}:{},signal:AbortSignal.timeout(180000)});
        if(!response.ok||!response.body)throw new Error("MEMORY_MODEL_DOWNLOAD_FAILED");
        if(response.status===206){if(!response.headers.get("content-range")?.startsWith(`bytes ${offset}-`))throw new Error("MEMORY_MODEL_RANGE_INVALID");}else offset=0;
        const file=await open(part,offset?"a":"w",0o600),reader=response.body.getReader();
        try {while(true){const result=await reader.read();if(result.done)break;offset+=result.value.byteLength;if(offset>asset.bytes){await reader.cancel();throw new Error("MEMORY_MODEL_SIZE_MISMATCH");}await file.writeFile(result.value);}}
        finally{reader.releaseLock();await file.close();}
      }
      if((await stat(part)).size!==asset.bytes||await fileHash(part)!==asset.sha256){rmSync(part,{force:true});throw new Error("MEMORY_MODEL_HASH_MISMATCH");}
      renameSync(part,target);download.bytesDownloaded+=asset.bytes;
    }
    database().prepare("UPDATE memory_projection_receipts SET lexical_status='pending',embedding_status='pending' WHERE embedding_status='unavailable' AND lexical_status='indexed'").run();
    await options.onModelReady?.();download.state="ready";
  } catch(error){download.state="failed";download.error=error instanceof Error&&/^MEMORY_MODEL_/.test(error.message)?error.message:"MEMORY_MODEL_DOWNLOAD_FAILED";}
}

export const MEMORY_OLDEST_QUEUED_SQL="SELECT count(*) AS n,min(at) AS at FROM (SELECT v.created_at AS at FROM memory_jobs j JOIN memory_source_versions v ON v.source_id=j.source_id AND v.revision=j.source_revision WHERE j.status IN ('pending','partial','leased','deferred','failed') LIMIT ?)";
export const MEMORY_STATE_COUNT_SQL="SELECT count(*) AS n FROM (SELECT 1 FROM memory_scopes s CROSS JOIN memory_records r INDEXED BY memory_records_scope WHERE r.scope_id=s.id AND r.state=? LIMIT ?)";
/** Above this many scopes the status lists the audiences people choose (bots, rooms, teams, folders, preferences) and leaves out the per-conversation ones,
 * which are most of a long history and only ever read as a record's label. The count says how many were left out. */
export const MEMORY_STATUS_SCOPE_LIMIT=100;
/** The figures of the status that read the memory tables (record counts, the job backlog, the scope list), as last read on a connection. */
interface TableFigures {counts:Record<"candidate"|"active"|"archived"|"superseded"|"deleted",number>;recordsMore:Record<string,boolean>;backlog:{pending:number;leased:number;deferred:number;failed:number;oldestQueuedAt:number|null;more:Record<string,boolean>};omittedScopes:number;scopeRows:ScopeRow[]}
/** While the history upgrade runs, the status serves these from the last reading of the same connection (rc13 real-data run: the capped counts took
 * 128 to 194 ms a call beside the upgrade's I/O); the first call of a connection, the first after an owner's memory action, and every call when no
 * upgrade runs read them afresh. */
let lastFigures:{db:object;figures:TableFigures}|null=null;
/** `status.learning.ceiling` (r3.4): this server-local month's ledger against the stored ceiling; `paused` is derived on every read, never stored.
 *  Paused also when two paid replies this month came back without usage (their cost is unknown, see UNSEEN_EXCESS_CALLS). */
export function learningCeilingStatus(db:ReturnType<typeof database>,ceiling:{input:number;output:number},at=Date.now()):LearningCeilingStatus{
  const month=learningSpendMonth(at),row=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(learningSpendLedgerId(month));
  const spend=row?JSON.parse(String(row.intent)):{};
  const used={input:Math.max(0,Number(spend.input)||0),output:Math.max(0,Number(spend.output)||0)};
  return {month,input:ceiling.input,output:ceiling.output,inputUsed:used.input,outputUsed:used.output,paused:ceilingReached(ceiling,used)||unmeteredPause(spend)};
}
/** Bumped whenever the last reading is forgotten: a reading that began before then is not kept (it may predate an owner's change). */
let figuresGeneration=0;
function forgetFigures(){lastFigures=null;figuresGeneration++;}
export function resetMemoryStatusFigures(){forgetFigures();}
/** The reading of a connection that is being taken one statement per turn of the loop (primeFigures). */
const priming=new WeakMap<object,Promise<void>>();
/** Take the table figures of `db` one statement per turn of the loop and keep them as the last reading (stall r2 M3: the first status call under
 * the upgrade, of a connection or after an owner's action, read every figure in one hold of the loop beside the upgrade's I/O). */
export function primeMemoryStatusFigures(db:ReturnType<typeof database>):Promise<void>{
  const running=priming.get(db);if(running)return running;
  const generation=figuresGeneration;
  const prime=(async()=>{
    const steps=figureSteps(db);
    for(;;){
      const step=steps.next();
      if(step.done){if(db.isOpen&&generation===figuresGeneration)lastFigures={db,figures:step.value};return;}
      await new Promise<void>(resolve=>setImmediate(resolve));
      if(!db.isOpen||database()!==db||generation!==figuresGeneration)return;
    }
  })().finally(()=>{priming.delete(db);});
  priming.set(db,prime);
  return prime;
}
/** The status, with its table figures taken a statement per turn when the upgrade runs and there is no reading to serve yet. */
async function ownerStatusSliced(ticket:object,roster:MemoryRoster,options:MemoryOwnerOptions){
  const db=database();
  let upgrading=false;
  try{upgrading=options.upgradeRunning?.()??false;}catch{upgrading=false;}
  // a reading dropped part-way by an owner's action starts again in slices (1.0.3 Astra r1: it fell through to one synchronous read); a few
  // tries, then the status reads them itself
  for(let tries=0;upgrading&&lastFigures?.db!==db&&tries<4&&db.isOpen&&database()===db;tries++){try{await primeMemoryStatusFigures(db);}catch{break;}}
  return memoryOwnerStatus(ticket,roster,options);
}
export function memoryOwnerStatus(ticket:object,roster:MemoryRoster,options:MemoryOwnerOptions={}){
  requireMemoryOwner(ticket);const db=database();
  let upgrading=false;
  try{upgrading=options.upgradeRunning?.()??false;}catch{upgrading=false;}
  const figures=upgrading&&lastFigures?.db===db?lastFigures.figures:tableFigures(db);
  lastFigures={db,figures};
  const {counts,recordsMore,backlog,omittedScopes}=figures;
  const runtime=options.runtimeStatus?.();
  const {revision,...settings}=readMemoryLearning(db);
  const resolved=options.learningConnection?.();
  const connection=resolved?{instanceId:resolved.instanceId,label:resolved.label,source:resolved.source,reason:resolved.reason,suggestion:resolved.suggestion}:{instanceId:configuration().extractorInstanceId,label:"No connection",source:"none" as const};
  const ceiling=learningCeilingStatus(db,settings.ceiling);
  const learning={settings,revision,connection,defaultOn:options.learningDefaultOn?.()??false,ceiling};
  const hold=memoryHoldCode(),stored=String(db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode??"");
  const model=modelStatus();
  // what the owner is told about capture and recall comes from the same predicates the capture path uses (capture-gate.ts); a hold switches both off
  return {...memoryState(),hold,held:hold!==null,capture:memoryCaptures(stored,hold)?"on":"off",recall:memoryRecalls(stored,hold)?"on":"off",storedMode:stored,holdMessage:hold?holdMessage(hold):null,learning,evolution:options.evolution?.status()??null,classificationEvolution:options.evolution?.status("classification")??null,procedureEvolution:options.procedureEvolution?.status(ticket)??null,health:memoryHealth(resolved?(resolved.extractor?resolved.instanceId:null):configuration().extractorInstanceId),retention:memoryRetentionStatus(),configuration:configuration(),scopes:figures.scopeRows.map(row=>scopeAudience(roster,row)),scopesOmitted:omittedScopes,records:counts,recordsMore,backlog,model,semantic:semanticIndexStatus({nativeSupported:supportsNativeMemoryModel(),model:model.state,revision:model.revision}),extractors:options.extractors?.()??[],
    deletion:memoryDeletionStatus(),workerError:runtime?.error??null,runtime:runtime??null,sealedTurns:sealedTurnSummary(),pastChats:pastChatsCounters(db)};
}
function tableFigures(db:ReturnType<typeof database>):TableFigures{
  const steps=figureSteps(db);
  for(;;){const step=steps.next();if(step.done)return step.value;}
}
/** The statements of the table figures, a yield after each (primeMemoryStatusFigures runs one per turn of the loop). */
function* figureSteps(db:ReturnType<typeof database>):Generator<void,TableFigures,void>{
  // Every figure here is exact up to MEMORY_COUNT_CAP and then reads "1,000+": a keyed, limited count (the scope+state index, the job status
  // index), so opening Memory costs the same at any history size. Never a count(*) of a table.
  const counts={candidate:0,active:0,archived:0,superseded:0,deleted:0},recordsMore:Record<string,boolean>={};
  // One global capped count per state: the scopes drive an index seek each and the LIMIT caps the whole walk, not each scope.
  const countState=db.prepare(MEMORY_STATE_COUNT_SQL);
  for(const state of Object.keys(counts)){
    const n=Number(countState.get(state,MEMORY_COUNT_CAP+1)?.n??0);
    counts[state as keyof typeof counts]=Math.min(n,MEMORY_COUNT_CAP);if(n>MEMORY_COUNT_CAP)recordsMore[state]=true;
    yield;
  }
  const backlog={pending:0,leased:0,deferred:0,failed:0,oldestQueuedAt:null as number|null,more:{} as Record<string,boolean>};
  let queued=0;
  for(const row of db.prepare(`WITH st(status) AS (VALUES ('pending'),('partial'),('leased'),('deferred'),('failed'))
    SELECT status,(SELECT count(*) FROM (SELECT 1 FROM memory_jobs j WHERE j.status=st.status LIMIT ?)) AS n FROM st`).all(MEMORY_COUNT_CAP+1)){
    const key=(String(row.status)==="partial"?"pending":String(row.status)) as "pending"|"leased"|"deferred"|"failed",n=Number(row.n);
    const total=backlog[key]+n;backlog[key]=Math.min(total,MEMORY_COUNT_CAP);queued+=n;if(total>MEMORY_COUNT_CAP)backlog.more[key]=true;
  }
  yield;
  if(queued<=MEMORY_COUNT_CAP){
    // bounded on its own (1.0.3 Astra r1): the count above may be a turn old when the figures are read in slices, and jobs reopened since must not
    // turn this into a walk of every queued job. Past the cap the oldest is not shown, as when the count was over it.
    const oldest=db.prepare(MEMORY_OLDEST_QUEUED_SQL).get(MEMORY_COUNT_CAP+1);
    backlog.oldestQueuedAt=Number(oldest?.n??0)>MEMORY_COUNT_CAP||oldest?.at===null?null:Number(oldest?.at??0);
    yield;
  }
  const omittedScopes=scopeOmission();
  yield;
  return {counts,recordsMore,backlog,omittedScopes,scopeRows:scopeRows(omittedScopes>0)};
}

/** Owner edit/restore failures are displayed directly by MemorySettings. */
function plainMemoryEditError<T>(action:()=>T):T{
  try{return action();}catch(error){
    const messages:Record<string,string>={
      MEMORY_SOURCE_UNAVAILABLE:"The source for this memory is no longer available.",
      MEMORY_EVIDENCE_UNAVAILABLE:"The evidence for this memory is no longer available.",
      MEMORY_VERSION_CONFLICT:"This memory changed. Refresh and try again.",
      MEMORY_IDENTITY_WRITE_REQUIRED:"Use identity settings to change this memory.",
      MEMORY_CORRECTION_SCOPE_MISMATCH:"This correction and the current memory have different audiences.",
      MEMORY_CORRECTION_PIN_CHOICE_REQUIRED:"Choose whether to transfer or remove the current memory’s pin.",
      MEMORY_CORRECTION_PIN_CHANGED:"The current memory’s pin changed. Review it and try again.",
    };
    if(error instanceof Error && messages[error.message])error.message=messages[error.message];
    throw error;
  }
}

export async function memoryOwnerRoute(path:string,body:unknown,ticket:object,roster:MemoryRoster,options:MemoryOwnerOptions={}){
  requireMemoryOwner(ticket);
  if(path==="/api/memory/status")return ownerStatusSliced(ticket,roster,options);
  if(path!=="/api/memory/action")throw Object.assign(new Error("MEMORY_ROUTE_UNAVAILABLE"),{status:404});
  const parsed=actions.safeParse(body);if(!parsed.success)throw Object.assign(new Error("INVALID_MEMORY_ARGUMENTS"),{status:400});
  const input=parsed.data,db=database();
  // an owner's action may change the figures: the next status reads them afresh, upgrade or not
  forgetFigures();
  if(input.action==="learning-history")return learningHistory(db,roster,input);
  if(input.action==="learning-undo"||input.action==="learning-keep"){const action=input.action==="learning-undo"?"undo" as const:"keep" as const;return undoOwnsItsTransactions(db,input.eventId,action)?changeLearningEvent(db,input.eventId,action):transaction(()=>changeLearningEvent(db,input.eventId,action));}
  if(input.action==="waiting-summary")return reviewSummary(ticket,roster);
  if(input.action==="waiting-list")return reviewList(ticket,roster,input);
  if(input.action==="waiting-sources")return reviewSources(ticket,roster,input);
  if(input.action==="review-keep")return reviewKeep(ticket,roster,input);
  if(input.action==="review-keep-all")return reviewKeepAll(ticket,roster,input);
  if(input.action==="review-later")return reviewLater(ticket,roster,input);
  if(input.action==="review-back")return reviewBack(ticket,roster,input);
  if(input.action==="review-edit")return reviewEdit(ticket,roster,input);
  if(input.action==="review-undo")return reviewUndo(ticket,roster,input);
  if(input.action==="learning-bot"){
    validSubject(roster,"bot",input.botId);
    transaction(()=>{const current=readMemoryLearning(db),paused=new Set(current.botsPaused);if(input.enabled)paused.delete(input.botId);else paused.add(input.botId);updateMemoryLearning(db,{botsPaused:[...paused]},input.learningRevision);});
    return memoryOwnerStatus(ticket,roster,options);
  }
  if(input.action.startsWith("evolution-")){
    if(!options.evolution)throw Error("MEMORY_EVOLUTION_RUNTIME_UNAVAILABLE");
    if(input.action==="evolution-authorize")return options.evolution.authorize(ticket);
    if(input.action==="evolution-authorize-classification")return options.evolution.authorize(ticket,"classification");
    if(input.action==="evolution-retry")return options.evolution.retry(ticket,input.jobId);
    if(input.action==="evolution-history")return options.evolution.history(ticket);
    if(input.action==="evolution-rollback"){
      try{return options.evolution.rollback(ticket,input.expectedRevision,input.targetRevision);}
      catch(error){if(error instanceof Error&&error.message==="MEMORY_EVOLUTION_CONFLICT")throw Object.assign(error,{status:409});throw error;}
    }
  }
  if(input.action.startsWith("procedure-evaluation-")){
    if(!options.procedureEvolution)throw Error("PROCEDURE_EVALUATOR_UNAVAILABLE");
    if(input.action==="procedure-evaluation-preview")return options.procedureEvolution.preview(ticket,input.reviewId);
    if(input.action==="procedure-evaluation-authorize")return options.procedureEvolution.authorize(ticket,input.previewId);
    if(input.action==="procedure-evaluation-retry")return options.procedureEvolution.retry(ticket,input.reviewId);
  }
  if(input.action==="scope-labels")return scopeLabels(roster,input.scopeIds);
  if(input.action==="humans")return humanBindingStatus(ticket);
  if(input.action==="human-share")return shareHumanScope(ticket,input);
  if(input.action==="human-link"){const result=linkHumanBinding(ticket,input);await options.humanBindingChanged?.(input.bindingId);return result;}
  if(input.action==="promote"){
    const details=db.prepare("SELECT partition FROM memory_record_details WHERE record_id=? AND record_version=?").get(input.id,input.version);
    if(details?.partition==="identity")throw new Error("MEMORY_IDENTITY_WRITE_REQUIRED");
  }
  // Owner-authored continuity changes only through its own actions (PIP): the
  // generic record controls would bump installation revisions, skip the
  // per-kind cap, or hand its text to another dispatch path.
  if(("id" in input)&&("version" in input)&&["review-as-skill","archive","restore-archive","approve","correct"].includes(input.action)&&isPipRecord(String(input.id)))
    throw new Error(input.action==="review-as-skill"?"MEMORY_IDENTITY_PIP_NOT_SKILL":"MEMORY_IDENTITY_PIP_USE_CONTINUITY");
  if(input.action==="forget")rejectGenericForgetOfPip(ticket,input);
  if(input.action==="identity-read")return readBotIdentity(ticket,input.botId,roster,input.cursor);
  if(input.action==="identity-write")return writeBotIdentity(ticket,input,roster);
  if(input.action==="identity-delete")return deleteBotIdentity(ticket,input,roster);
  if(input.action==="continuity-read")return readContinuity(ticket,input.botId,roster);
  if(input.action==="pip-proposals")return {proposals:listProposals(ticket,input.botId,roster),counters:pipDisputes(ticket,input.botId,roster)};
  if(input.action==="pip-proposal-confirm")return confirmPipProposal(ticket,input,roster);
  if(input.action==="pip-proposal-dismiss")return dismissPipProposal(ticket,input,roster);
  if(input.action==="pip-keep")return keepPipRecord(ticket,input,roster);
  if(input.action==="pip-reflect-exclude"){
    requireMemoryOwner(ticket);
    const bot=roster.bots.find(b=>b.id===input.botId);
    if(!bot||![bot.threadId,...(bot.tasks??[]).map(t=>t.threadId)].includes(input.threadId))throw new Error("MEMORY_SUBJECT_UNKNOWN");
    setReflectExcluded(input.botId,input.threadId,input.excluded);return {ok:true};
  }
  if(input.action==="pip-reflect-status"){requireMemoryOwner(ticket);return reflectionStatus(input.botId);}
  if(input.action==="pip-reflect-retry"){requireMemoryOwner(ticket);retryReflection(input.botId);return {ok:true};}
  if(input.action==="list"){
    const {rows,...result}=await ownerMemoryList(input,roster);
    return {...result,records:rows.map(record)};
  }
  if(input.action==="inspect"){
    const current=getRecord(input.id,input.version);let remaining=32768;
    const evidence=db.prepare("SELECT e.*,s.speaker,v.payload,v.content_hash FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision WHERE e.record_id=? AND e.record_version=? LIMIT 21").all(input.id,input.version);
    if(evidence.length>20)throw new Error("MEMORY_RESPONSE_LIMIT");
    return {record:current,evidence:evidence.map(row=>{const payload=JSON.parse(String(row.payload)),bytes=Buffer.from(payload.text??"").subarray(Number(row.start_byte),Number(row.end_byte));if(bytes.length>remaining)throw new Error("MEMORY_RESPONSE_LIMIT");remaining-=bytes.length;return {sourceId:String(row.source_id),revision:Number(row.source_revision),startByte:Number(row.start_byte),endByte:Number(row.end_byte),text:maskFinancialIdentifiers(bytes.toString("utf8")),path:typeof payload.path==="string"?payload.path:undefined,hash:String(row.content_hash),speaker:String(row.speaker)};}),lineage:db.prepare("SELECT parent_id AS id,parent_version AS version FROM memory_derivations WHERE child_id=? AND child_version=? LIMIT 100").all(input.id,input.version),
      correction:current.state==="candidate"?readCorrectionTarget(db,input.id,input.version):null};
  }
  if(input.action==="review-as-skill"){
    const bot=roster.bots.find(item=>item.id===input.botId);
    if(!bot)throw new Error("MEMORY_SUBJECT_UNKNOWN");
    if(!options.startSkillReview)throw new Error("MEMORY_SKILL_REVIEW_UNAVAILABLE");
    const current=getRecord(input.id,input.version);
    // The owner may inspect everything, but dispatching into another audience
    // is a disclosure. Require existing bot/private-thread access, not implicit sharing.
    const allowed=db.prepare(`SELECT id FROM memory_scopes WHERE
      (kind='bot' AND owner_key=?) OR (kind='conversation' AND owner_key=?) OR (kind='team' AND owner_key=?)
      UNION SELECT scope_id AS id FROM memory_scope_bindings WHERE subject_type='bot' AND subject_id=? AND state='granted'`).all(bot.id,bot.threadId,bot.section?.trim()||"",bot.id);
    const liveBot=executionStore()?.bot(bot.id);
    if(liveBot?.partitionedAt!==undefined && !backgroundMemoryScopes(bot.id,homeThread(liveBot).threadId,roster).includes(current.scopeId))throw new Error("MEMORY_SKILL_AUDIENCE_DENIED");
    if(!allowed.some(scope=>scope.id===current.scopeId))throw new Error("MEMORY_SKILL_AUDIENCE_DENIED");
    const review=prepareMemorySkillReview(ticket,bot.id,input.id,input.version);
    try {return {workflow:"learn",...await options.startSkillReview(review),source:review.source,record:review.record};}
    catch(error){db.prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id=?").run(review.source.replace("learn:memory-review:","memory-skill-review:"));throw error;}
  }
  if(input.action==="archive"){archiveMemoryRecord(ticket,input.id,input.version);return {record:getRecord(input.id,input.version)};}
  if(input.action==="restore-archive"){plainMemoryEditError(()=>restoreArchivedMemoryRecord(ticket,input.id,input.version));return {record:getRecord(input.id,input.version)};}
  if(input.action==="approve"){approveMemory(ticket,input.id,input.version,input.correctionPin?{correctionPin:input.correctionPin}:{});reindex(input.id,input.version);return {record:getRecord(input.id,input.version)};}
  if(input.action==="remember"){const kept=rememberMemory(ticket,input);if(kept.fresh)reindex(kept.id,kept.version);return {record:getRecord(kept.id,kept.version),...(kept.duplicate?{duplicate:true as const}:{})};}
  if(input.action==="pin"){pinMemory(ticket,input.id,input.version,input.pinned);return {record:getRecord(input.id,input.version)};}
  if(input.action==="correct"){const next=plainMemoryEditError(()=>correctMemory(ticket,input.id,input.version,input.text,{correctionPin:input.correctionPin}));reindex(input.id,next);return {record:getRecord(input.id,next)};}
  if(input.action==="promote"){
    return transaction(()=>{const original=getRecord(input.id,input.version);if(original.state!=="active"&&original.state!=="candidate")throw new Error("MEMORY_VERSION_CONFLICT");
      if(!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(input.scopeId))throw new Error("MEMORY_SCOPE_UNKNOWN");
      const copy=randomUUID();insertMemoryRecord(db,{id:copy,version:1,scopeId:String(input.scopeId),kind:String(original.kind),text:String(original.text),assertion:"owner-statement",state:"active",validFrom:Date.now(),createdAt:Date.now()});db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(original.id,original.version,copy);inheritEdge(db,{kind:"record",id:copy,version:1},{kind:"record",id:original.id,version:original.version});
      db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1");reindex(copy,1);return {record:getRecord(copy,1)};});
  }
  if(input.action==="forget")return forgetMemory(ticket,input);
  if(input.action==="bind"){validSubject(roster,input.subjectType,input.subjectId);bindMemoryScope(ticket,input.scopeId,input.subjectType,input.subjectId);return {ok:true};}
  if(input.action==="project"){
    validSubject(roster,input.subjectType,input.subjectId);if(!isAbsolute(input.path))throw new Error("MEMORY_PROJECT_PATH_REQUIRED");
    // Native realpath: the JavaScript one follows links but keeps the spelling
    // it was given, so on Windows and on a case-insensitive macOS volume the
    // same folder produced a different owner_key per spelling — two project
    // scopes for one folder, and memories that silently stopped surfacing.
    const path=realpathSync.native(input.path);if(!lstatSync(path).isDirectory())throw new Error("MEMORY_PROJECT_DIRECTORY_REQUIRED");
    adoptRespelledProjectScope(path);
    const scopeId=ensureScope("project",path);bindMemoryScope(ticket,scopeId,input.subjectType,input.subjectId);return {scopeId,path};
  }
  if(input.action==="configure"){
    const current=configuration();
    if(input.extractorInstanceId && !options.extractors?.().some(engine=>engine.instanceId===input.extractorInstanceId&&engine.eligible))throw new Error("MEMORY_EXTRACTOR_UNAVAILABLE");
    if(input.excludedThreadIds){const threads=new Set([...roster.bots.flatMap(bot=>[bot.threadId,...(bot.tasks??[]).map(task=>task.threadId)]),...roster.groups.flatMap(group=>[group.threadId,...(group.tasks??[]).map(task=>task.threadId)])]);if(input.excludedThreadIds.some(thread=>!threads.has(thread)))throw new Error("MEMORY_THREAD_UNKNOWN");}
    transaction(()=>{const updated={excludedThreadIds:input.excludedThreadIds??current.excludedThreadIds,extractorInstanceId:input.extractorInstanceId===undefined?current.extractorInstanceId:input.extractorInstanceId};const scope=ensureScope("workspace",memoryState().installationId);
      if(input.learning||input.ceiling){
        const before=readMemoryLearning(db).ceiling;
        const next=updateMemoryLearning(db,{...input.learning,...input.ceiling?{ceiling:input.ceiling}:{}},input.learningRevision);
        // a raise applies now: every source waiting for next month's ceiling is due at once
        // a raise of both sides is also the owner's answer to unmetered replies, so they are cleared with it (one side alone is not:
        // their unknown excess may sit on the other)
        if(next.ceiling.input>before.input||next.ceiling.output>before.output)releaseCeilingDeferrals(db);
        if(next.ceiling.input>before.input&&next.ceiling.output>before.output)clearUnseenExcess(db);
      }
      db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','owner-settings',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(SETTINGS,scope,JSON.stringify(updated));
      if(input.mode)db.prepare("UPDATE memory_meta SET mode=?").run(input.mode);
      db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1,data_revision=data_revision+1");revokeAllDisclosures(db,"memory-settings");
      db.prepare("UPDATE memory_sources SET state='retired' WHERE thread_id IN (SELECT value FROM json_each(?)) AND state='active'").run(JSON.stringify(updated.excludedThreadIds));
      db.prepare("UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1 WHERE source_id IN (SELECT id FROM memory_sources WHERE thread_id IN (SELECT value FROM json_each(?))) AND status NOT IN ('complete','cancelled')").run(JSON.stringify(updated.excludedThreadIds));
      forgetParkedThreads(db,updated.excludedThreadIds);
    });return ownerStatusSliced(ticket,roster,options);
  }
  // the answer says what the press did ({status:"queued"|"already-queued"|"done"}); only a cursor never skipped is a 404
  if(input.action==="retry-skipped"){const retry=transaction(()=>retrySkippedSlice(db,input.sourceId,input.cursor));return {...memoryOwnerStatus(ticket,roster,options),retry};}
  if(input.action==="import-preview")return previewMemoryImport(ticket,input.selections,roster);
  if(input.action==="import-commit")return commitMemoryImport(ticket,input.previewId,roster,input.track);
  if(input.action==="import-inventory")return {...availableMemoryNotebooks(ticket,roster),links:memoryNotebookLinks()};
  if(input.action==="import-review-list"){
    if(input.botId&&!roster.bots.some(bot=>bot.id===input.botId))throw new Error("MEMORY_SUBJECT_UNKNOWN");
    const rows=db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='notebook-link' AND state='granted' AND json_extract(intent,'$.status')='needs-review' AND (? IS NULL OR json_extract(intent,'$.selection.botId')=?) AND id>? ORDER BY id LIMIT 51").all(input.botId??null,input.botId??null,input.cursor??"");
    return {links:rows.slice(0,50).map(row=>({id:String(row.id),...JSON.parse(String(row.intent))})),...rows.length>50?{nextCursor:String(rows[49].id)}:{}};
  }
  if(input.action==="enable-and-import"){
    await memoryOwnerRoute(path,{action:"configure",mode:"active"},ticket,roster,options);
    const migrated=migrateDetectedMemoryNotebooks(roster);
    // the nested configure kept a reading taken before the import (stall r2, Astra): the status after it reads the imported figures
    forgetFigures();
    return {...migrated,status:await ownerStatusSliced(ticket,roster,options)};
  }
  if(input.action==="import-stop-tracking")return stopTrackingMemoryNotebook(ticket,input.id);
  if(input.action==="model-download"){if(modelStatus().bundled)return {model:modelStatus()};if(!supportsNativeMemoryModel())throw Object.assign(new Error("This install is missing the runtime that runs the local semantic model, so it uses keyword memory and a model download would not help. Reinstall Murage to restore smart search."),{status:409});if(download?.state!=="downloading")void downloadModel(options);return {model:modelStatus()};}
  if(input.action==="rebuild-index"){
    const model=modelStatus();
    if(String(database().prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode??"")==="off")throw Object.assign(new Error("Memory is off. Turn it on to rebuild the search index."),{status:409});
    if(model.state!=="ready")throw Object.assign(new Error("The search model is not ready yet. Rebuild the search index once it has finished downloading and checking."),{status:409});
    const run=rebuildSearchIndex({revision:model.revision});
    return {running:true,started:run.started};
  }
  throw new Error("MEMORY_ROUTE_UNAVAILABLE");
}
