import { humanBindingStatus, linkHumanBinding, shareHumanScope } from "../human-principals.ts";
import { identityReadSchema, identityWriteSchema, readBotIdentity, writeBotIdentity } from "./identity.ts";
import { supportsNativeMemoryModel } from "./embeddings.ts";
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
import { database, transaction } from "../database.ts";
import { requireMemoryOwner, approveMemory, pinMemory, correctMemory, bindMemoryScope, readCorrectionTarget } from "./authority.ts";
import { forgetMemory, memoryDeletionStatus } from "./forget.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { memoryState } from "./repository.ts";
import { previewMemoryImport, commitMemoryImport, availableMemoryNotebooks, memoryNotebookLinks, stopTrackingMemoryNotebook, migrateDetectedMemoryNotebooks } from "./import.ts";
import { ownerMemoryList } from "./owner-list.ts";
import type { MemoryRecord } from "../../shared/memory.ts";
import { prepareMemorySkillReview } from "../skills.ts";
import { memoryLearningPatchSchema, readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import type { MemoryEvolutionRuntime } from "./evolution-runtime.ts";
import type { ProcedureEvaluatorBridge } from "./procedure-evaluator.ts";
import { memoryHealth } from "./health.ts";

const SETTINGS="memory-owner-settings";
type Configuration={excludedThreadIds:string[];extractorInstanceId:string|null};
interface Extractor {instanceId:string;label:string;eligible:boolean;reason?:string}
export interface MemoryOwnerOptions {
  evolution?:MemoryEvolutionRuntime;
  procedureEvolution?:ProcedureEvaluatorBridge;
  humanBindingChanged?:(bindingId:string)=>Promise<void>;
  extractors?:()=>Extractor[];
  runtimeStatus?:()=>{running?:boolean;ready?:boolean;indexing?:boolean;queryCount?:number;error?:string|null};
  onModelReady?:()=>Promise<void>;
  startSkillReview?:(input:{botId:string;record:{id:string;version:number};source:string;request:string})=>Promise<{botId:string;threadId:string;messageId:string}>;
}
const id=z.string().min(1).max(180),version=z.number().int().positive();
const subject={subjectType:z.enum(["bot","room"]),subjectId:id};
const actions=z.discriminatedUnion("action",[
  z.object({action:z.literal("evolution-authorize")}).strict(),
  z.object({action:z.literal("evolution-authorize-classification")}).strict(),
  z.object({action:z.literal("procedure-evaluation-preview"),reviewId:id}).strict(),
  z.object({action:z.literal("procedure-evaluation-authorize"),previewId:id}).strict(),
  z.object({action:z.literal("procedure-evaluation-retry"),reviewId:id}).strict(),
  z.object({action:z.literal("evolution-retry"),jobId:id}).strict(),
  z.object({action:z.literal("evolution-history")}).strict(),
  z.object({action:z.literal("evolution-rollback"),expectedRevision:id,targetRevision:id}).strict(),
  identityReadSchema, identityWriteSchema,
  z.object({action:z.literal("humans")}).strict(),
  z.object({action:z.literal("human-share"),personId:id,scopeId:id,granted:z.boolean()}).strict(),
  z.object({action:z.literal("human-link"),bindingId:id,expectedRevision:z.number().int().positive(),as:z.enum(["owner","person","unlink"]),personId:id.optional()}).strict(),
  z.object({action:z.literal("list"),query:z.string().max(4096).optional(),scopeId:id.optional(),botId:id.optional(),state:z.enum(["candidate","active","archived","superseded","deleted"]).optional(),cursor:z.string().max(512).optional(),view:z.enum(["search","important","recent","review"]).optional()}).strict(),
  z.object({action:z.literal("inspect"),id,version}).strict(),
  z.object({action:z.literal("review-as-skill"),id,version,botId:id}).strict(),
  // correctionPin is the owner's explicit choice when an approved correction
  // replaces a pinned fact; it is never defaulted (decision U-16).
  z.object({action:z.literal("approve"),id,version,correctionPin:z.enum(["transfer","unpin"]).optional()}).strict(),
  z.object({action:z.literal("archive"),id,version}).strict(),
  z.object({action:z.literal("restore-archive"),id,version}).strict(),
  z.object({action:z.literal("pin"),id,version,pinned:z.boolean()}).strict(),
  z.object({action:z.literal("correct"),id,version,text:z.string().min(1).max(4096)}).strict(),
  z.object({action:z.literal("promote"),id,version,scopeId:id}).strict(),
  z.object({action:z.literal("forget"),kind:z.enum(["source","record"]),id,revision:z.number().int().nonnegative().optional()}).strict(),
  z.object({action:z.literal("bind"),scopeId:id,...subject}).strict(),
  z.object({action:z.literal("project"),path:z.string().min(1).max(4096),...subject}).strict(),
  z.object({action:z.literal("configure"),mode:z.enum(["off","capture","active","paused"]).optional(),excludedThreadIds:z.array(id).max(1000).optional(),extractorInstanceId:id.nullable().optional(),learning:memoryLearningPatchSchema.optional(),learningRevision:z.number().int().nonnegative().optional()}).strict(),
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
]);
export function memoryExtractorInstanceId(){return configuration().extractorInstanceId;}
function configuration():Configuration {
  const row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(SETTINGS);
  return row?JSON.parse(String(row.intent)):{excludedThreadIds:[],extractorInstanceId:null};
}
function record(row:Record<string,unknown>):MemoryRecord {
  return {id:String(row.id),version:Number(row.version),scopeId:String(row.scope_id),kind:String(row.kind),text:String(row.text),assertion:row.assertion as MemoryRecord["assertion"],state:row.state as MemoryRecord["state"],ownerPinned:row.owner_pinned===1,validFrom:Number(row.valid_from),validTo:row.valid_to===null?null:Number(row.valid_to)};
}
function getRecord(id:string,version:number){
  const row=database().prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(id,version);
  if(!row)throw new Error("MEMORY_NOT_FOUND");return record(row);
}
function reindex(id:string,version:number){
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
function scopes(roster:MemoryRoster){return database().prepare("SELECT id,kind,owner_key FROM memory_scopes ORDER BY kind,owner_key").all().map(row=>{
  const named=(row.kind==="bot"?roster.bots:roster.groups).find(item=>item.id===row.owner_key) as {name?:string}|undefined;
  return {id:String(row.id),kind:String(row.kind),ownerKey:String(row.owner_key),label:named?.name||String(row.owner_key)||"General"};
});}
interface Manifest {model:string;revision:string;files:Array<{path:string;bytes:number;sha256:string}>}
function manifest():Manifest {
  const packaged=join(SERVER_ROOT,"memory-model-manifest.json");
  return JSON.parse(readFileSync(existsSync(packaged)?packaged:join(SERVER_ROOT,"..","shared","memory-model-manifest.json"),"utf8"));
}
type ModelState={state:"missing"|"unverified"|"downloading"|"ready"|"failed";bytesDownloaded:number;totalBytes:number;revision:string;model:string;error?:string};
let download:ModelState|undefined;
function modelStatus():ModelState {
  const spec=manifest(),totalBytes=spec.files.reduce((sum,file)=>sum+file.bytes,0);
  if(!supportsNativeMemoryModel())return {state:"failed",bytesDownloaded:0,totalBytes,revision:spec.revision,model:spec.model,error:"Intel Mac builds use keyword memory in this release. The native semantic model is not available on this platform."};
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

export function memoryOwnerStatus(ticket:object,roster:MemoryRoster,options:MemoryOwnerOptions={}){
  requireMemoryOwner(ticket);const db=database();
  const counts={candidate:0,active:0,archived:0,superseded:0,deleted:0};
  for(const row of db.prepare("SELECT state,count(*) AS n FROM memory_records GROUP BY state").all())counts[String(row.state) as keyof typeof counts]=Number(row.n);
  const backlog={pending:0,leased:0,deferred:0,failed:0,oldestQueuedAt:null as number|null};
  for(const row of db.prepare("SELECT CASE status WHEN 'partial' THEN 'pending' ELSE status END AS status,count(*) AS n FROM memory_jobs WHERE status IN ('pending','partial','leased','deferred','failed') GROUP BY CASE status WHEN 'partial' THEN 'pending' ELSE status END").all())backlog[String(row.status) as "pending"|"leased"|"deferred"|"failed"]=Number(row.n);
  const oldest=db.prepare("SELECT min(v.created_at) AS at FROM memory_jobs j JOIN memory_source_versions v ON v.source_id=j.source_id AND v.revision=j.source_revision WHERE j.status IN ('pending','partial','leased','deferred','failed')").get();backlog.oldestQueuedAt=oldest?.at===null?null:Number(oldest?.at??0);
  const day=new Date().toISOString().slice(0,10),budgetRow=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(`extract-budget:${day}`),budget=budgetRow?JSON.parse(String(budgetRow.intent)):{};
  const runtime=options.runtimeStatus?.();
  const learning=readMemoryLearning(db);
  return {...memoryState(),learning,evolution:options.evolution?.status()??null,classificationEvolution:options.evolution?.status("classification")??null,procedureEvolution:options.procedureEvolution?.status(ticket)??null,health:memoryHealth(configuration().extractorInstanceId),retention:memoryRetentionStatus(),configuration:configuration(),scopes:scopes(roster),records:counts,backlog,model:modelStatus(),extractors:options.extractors?.()??[],
    cost:{day,inputReserved:budget.input??0,outputReserved:budget.output??0,callsThisMinute:budget.minute===Math.floor(Date.now()/60000)?budget.calls??0:0,inputLimit:learning.inputLimit,outputLimit:learning.outputLimit,callsPerMinuteLimit:learning.callsPerMinute},deletion:memoryDeletionStatus(),workerError:runtime?.error??null,runtime:runtime??null};
}

export async function memoryOwnerRoute(path:string,body:unknown,ticket:object,roster:MemoryRoster,options:MemoryOwnerOptions={}){
  requireMemoryOwner(ticket);
  if(path==="/api/memory/status")return memoryOwnerStatus(ticket,roster,options);
  if(path!=="/api/memory/action")throw Object.assign(new Error("MEMORY_ROUTE_UNAVAILABLE"),{status:404});
  const parsed=actions.safeParse(body);if(!parsed.success)throw Object.assign(new Error("INVALID_MEMORY_ARGUMENTS"),{status:400});
  const input=parsed.data,db=database();
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
  if(input.action==="humans")return humanBindingStatus(ticket);
  if(input.action==="human-share")return shareHumanScope(ticket,input);
  if(input.action==="human-link"){const result=linkHumanBinding(ticket,input);await options.humanBindingChanged?.(input.bindingId);return result;}
  if(input.action==="correct"||input.action==="promote"){
    const details=db.prepare("SELECT partition FROM memory_record_details WHERE record_id=? AND record_version=?").get(input.id,input.version);
    if(details?.partition==="identity")throw new Error("MEMORY_IDENTITY_WRITE_REQUIRED");
  }
  if(input.action==="identity-read")return readBotIdentity(ticket,input.botId,roster,input.cursor);
  if(input.action==="identity-write")return writeBotIdentity(ticket,input,roster);
  if(input.action==="list"){
    const {rows,...result}=ownerMemoryList(input,roster);
    return {...result,records:rows.map(record)};
  }
  if(input.action==="inspect"){
    const current=getRecord(input.id,input.version);let remaining=32768;
    const evidence=db.prepare("SELECT e.*,s.speaker,v.payload,v.content_hash FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision WHERE e.record_id=? AND e.record_version=? LIMIT 21").all(input.id,input.version);
    if(evidence.length>20)throw new Error("MEMORY_RESPONSE_LIMIT");
    return {record:current,evidence:evidence.map(row=>{const payload=JSON.parse(String(row.payload)),bytes=Buffer.from(payload.text??"").subarray(Number(row.start_byte),Number(row.end_byte));if(bytes.length>remaining)throw new Error("MEMORY_RESPONSE_LIMIT");remaining-=bytes.length;return {sourceId:String(row.source_id),revision:Number(row.source_revision),startByte:Number(row.start_byte),endByte:Number(row.end_byte),text:bytes.toString("utf8"),path:typeof payload.path==="string"?payload.path:undefined,hash:String(row.content_hash),speaker:String(row.speaker)};}),lineage:db.prepare("SELECT parent_id AS id,parent_version AS version FROM memory_derivations WHERE child_id=? AND child_version=? LIMIT 100").all(input.id,input.version),
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
    if(!allowed.some(scope=>scope.id===current.scopeId))throw new Error("MEMORY_SKILL_AUDIENCE_DENIED");
    const review=prepareMemorySkillReview(ticket,bot.id,input.id,input.version);
    try {return {workflow:"learn",...await options.startSkillReview(review),source:review.source,record:review.record};}
    catch(error){db.prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id=?").run(review.source.replace("learn:memory-review:","memory-skill-review:"));throw error;}
  }
  if(input.action==="archive"){archiveMemoryRecord(ticket,input.id,input.version);return {record:getRecord(input.id,input.version)};}
  if(input.action==="restore-archive"){restoreArchivedMemoryRecord(ticket,input.id,input.version);return {record:getRecord(input.id,input.version)};}
  if(input.action==="approve"){approveMemory(ticket,input.id,input.version,input.correctionPin?{correctionPin:input.correctionPin}:{});reindex(input.id,input.version);return {record:getRecord(input.id,input.version)};}
  if(input.action==="pin"){pinMemory(ticket,input.id,input.version,input.pinned);return {record:getRecord(input.id,input.version)};}
  if(input.action==="correct"){const next=correctMemory(ticket,input.id,input.version,input.text);reindex(input.id,next);return {record:getRecord(input.id,next)};}
  if(input.action==="promote"){
    return transaction(()=>{const original=getRecord(input.id,input.version);if(original.state!=="active"&&original.state!=="candidate")throw new Error("MEMORY_VERSION_CONFLICT");
      if(!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(input.scopeId))throw new Error("MEMORY_SCOPE_UNKNOWN");
      const copy=randomUUID();db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'owner-statement','active',0,?,NULL,NULL,?)").run(copy,input.scopeId,original.kind,original.text,Date.now(),Date.now());db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(original.id,original.version,copy);
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
      if(input.learning)updateMemoryLearning(db,input.learning,input.learningRevision);
      db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','owner-settings',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(SETTINGS,scope,JSON.stringify(updated));
      if(input.mode)db.prepare("UPDATE memory_meta SET mode=?").run(input.mode);
      db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1,data_revision=data_revision+1");db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'").run();
      db.prepare("UPDATE memory_sources SET state='retired' WHERE thread_id IN (SELECT value FROM json_each(?)) AND state='active'").run(JSON.stringify(updated.excludedThreadIds));
      db.prepare("UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1 WHERE source_id IN (SELECT id FROM memory_sources WHERE thread_id IN (SELECT value FROM json_each(?))) AND status NOT IN ('complete','cancelled')").run(JSON.stringify(updated.excludedThreadIds));
    });return memoryOwnerStatus(ticket,roster,options);
  }
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
    return {...migrateDetectedMemoryNotebooks(roster),status:memoryOwnerStatus(ticket,roster,options)};
  }
  if(input.action==="import-stop-tracking")return stopTrackingMemoryNotebook(ticket,input.id);
  if(input.action==="model-download"){if(!supportsNativeMemoryModel())throw Object.assign(new Error("Intel Mac builds use keyword memory; a semantic model download is not available in this release."),{status:409});if(download?.state!=="downloading")void downloadModel(options);return {model:modelStatus()};}
  throw new Error("MEMORY_ROUTE_UNAVAILABLE");
}
