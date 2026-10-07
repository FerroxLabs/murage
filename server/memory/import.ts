import { type Partition, partitionScopeKey, isHomePartition } from "../execution-audience.ts";
import { teamMemoryKey } from "../team-identities.ts";
import { notebookRoot } from "../workspace.ts";
import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../config.ts";
import { transaction, database } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { chunksFor } from "./chunks.ts";
import { redactSecretsInText } from "../redact.ts";
import { isMemoryTopicName, MEMORY_SEED } from "../workspace.ts";
import { scopeRow } from "./scope-id.ts";
import { revokeAllDisclosures } from "./revocation.ts";

export type ImportSelection = {kind:"bot";botId:string;topic?:string}|{kind:"section";section:string}|{kind:"partition";botId:string;partition:Partition;topic?:string};
interface ImportItem {selection:ImportSelection;path:string;hash:string;bytes:number;text:string;scopeId:string;scopeLabel:string;alreadyImported:boolean}
interface Preview {previewId:string;items:ImportItem[];expiresAt:number;policyRevision:number}
const previews=new Map<string,Preview>();
let checkedDatabase:ReturnType<typeof database>|undefined;
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");

/** The configured profile root is trusted; every selected descendant must be a
 * regular non-symlink file. Never accept arbitrary paths from import requests.
 */
function readSelected(parts:string[],maximum=262144):string {
  if(lstatSync(DATA_DIR).isSymbolicLink())throw new Error("MEMORY_IMPORT_SYMLINK");
  const root=realpathSync(DATA_DIR),path=join(root,...parts);
  const rel=relative(root,path);if(rel.startsWith(`..${sep}`)||rel===".."||resolve(path)===root)throw new Error("MEMORY_IMPORT_PATH_DENIED");
  let at=root;
  for(const part of parts){at=join(at,part);if(lstatSync(at).isSymbolicLink())throw new Error("MEMORY_IMPORT_SYMLINK");}
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size>maximum)throw new Error("MEMORY_IMPORT_FILE_LIMIT");
    const bytes=readFileSync(fd);if(bytes.length>maximum)throw new Error("MEMORY_IMPORT_FILE_LIMIT");
    return bytes.toString("utf8");
  } finally {closeSync(fd);}
}
function selectionItem(selection:ImportSelection,roster:MemoryRoster):ImportItem {
  let text:string,path:string,scopeId:string,scopeLabel:string;
  if(selection.kind==="bot" || selection.kind==="partition"){
    if(!/^[\w-]+$/.test(selection.botId)||!roster.bots.some(bot=>bot.id===selection.botId))throw new Error("MEMORY_IMPORT_BOT_UNKNOWN");
    if(selection.topic!==undefined&&!isMemoryTopicName(selection.topic))throw new Error("MEMORY_IMPORT_TOPIC_DENIED");
    const partition = selection.kind === "partition" ? selection.partition : { kind: "home" as const };
    // Owner-opted notebook sync (`unverified-import`) is lane D's documented exception to the learning guard; the partition key keeps it inside this notebook's own partition.
    const key = partitionScopeKey(selection.botId, partition); if (!key) throw new Error("MEMORY_IMPORT_PARTITION_DENIED");
    const parts=[...relative(DATA_DIR, notebookRoot(selection.botId, partition)).split(sep),...selection.topic?["memory",selection.topic]:[partition.kind === "general" ? "GENERAL.md" : "MEMORY.md"]];
    text=readSelected(parts);path=join(DATA_DIR,...parts);scopeId=ensureScope("bot",key);scopeLabel=`Private notebook: ${selection.botId}`;
  } else {
    const section=selection.section.trim();
    if(section.length>60||section&&!roster.bots.some(bot=>(bot.section?.trim()||"")===section)&&!roster.groups.some(group=>(group.section?.trim()||"")===section))throw new Error("MEMORY_IMPORT_SECTION_UNKNOWN");
    const file=JSON.parse(readSelected(["section-contexts.json"],1048576));
    const record=file?.version===1?file.contexts?.[section]:undefined;
    if(typeof record?.text!=="string")throw new Error("MEMORY_IMPORT_SECTION_MISSING");
    text=record.text;path=`${join(DATA_DIR,"section-contexts.json")}#${section}`;scopeId=ensureScope("team",section);scopeLabel=`Team brief: ${section||"General"}`;
  }
  const originalHash=hash(text);
  text=redactSecretsInText(text);
  if(!text.trim())throw new Error("MEMORY_IMPORT_EMPTY");
  const sourceId=`legacy:${hash(JSON.stringify([scopeId,path]))}`;
  const previous=database().prepare("SELECT content_hash FROM memory_sources WHERE id=?").get(sourceId);
  return {selection,path,hash:originalHash,bytes:Buffer.byteLength(text),text,scopeId,scopeLabel,alreadyImported:previous?.content_hash===originalHash};
}

/** Import sources for the two notebooks a turn's prompt carries whole: the
 * bot's MEMORY.md and its section's team brief. Recall skips records that
 * rest only on these, so one fact is not sent twice. Read-only: an absent
 * scope means nothing was imported from it. */
export function notebookSourceIds(botId:string,section?:string|null,partition:Partition = {kind:"home"}):{notebook?:string;brief?:string;general?:string} {
  if(partition.kind === "isolated") return {};
  const db=database(),team=isHomePartition(partition) ? section?.trim()||"" : partition.kind === "team" ? teamMemoryKey(partition.teamId) : null;
  const scope=(kind:string,owner:string)=>scopeRow(db, kind,owner)?.id;
  const bot=scope("bot",partitionScopeKey(botId,partition)!),brief=team === null ? undefined : scope("team",team);
  const general=partition.kind !== "general" ? scope("bot",botId+"#general") : undefined;
  return {
    ...general?{general:`legacy:${hash(JSON.stringify([String(general),join(notebookRoot(botId,{kind:"general"}),"GENERAL.md")]))}`}:{},
    ...bot?{notebook:`legacy:${hash(JSON.stringify([String(bot),join(notebookRoot(botId,partition),partition.kind === "general" ? "GENERAL.md" : "MEMORY.md")]))}`}:{},
    ...brief?{brief:`legacy:${hash(JSON.stringify([String(brief),`${join(DATA_DIR,"section-contexts.json")}#${team}`]))}`}:{},
  };
}

export function previewMemoryImport(ticket:object,selections:ImportSelection[],roster:MemoryRoster){
  requireMemoryOwner(ticket);
  if(!selections.length||selections.length>20)throw new Error("MEMORY_IMPORT_SELECTION_LIMIT");
  for(const [id,preview] of previews)if(preview.expiresAt<Date.now())previews.delete(id);
  if(previews.size>=20)throw new Error("MEMORY_IMPORT_PREVIEW_LIMIT");
  const items=selections.map(selection=>selectionItem(selection,roster));
  if(items.reduce((sum,item)=>sum+item.bytes,0)>1048576)throw new Error("MEMORY_IMPORT_TOTAL_LIMIT");
  if(new Set(items.map(item=>item.path)).size!==items.length)throw new Error("MEMORY_IMPORT_DUPLICATE_SELECTION");
  const preview:Preview={previewId:randomUUID(),items,expiresAt:Date.now()+10*60000,policyRevision:Number(database().prepare("SELECT policy_revision FROM memory_meta WHERE id=1").get()!.policy_revision)};
  previews.set(preview.previewId,structuredClone(preview));return preview;
}

export function commitMemoryImport(ticket:object,previewId:string,roster:MemoryRoster,track=false){
  requireMemoryOwner(ticket);
  const preview=previews.get(previewId);
  if(!preview||preview.expiresAt<Date.now())throw new Error("MEMORY_IMPORT_PREVIEW_EXPIRED");
  if(Number(database().prepare("SELECT policy_revision FROM memory_meta WHERE id=1").get()!.policy_revision)!==preview.policyRevision)throw new Error("MEMORY_IMPORT_POLICY_CHANGED");
  // File changes require another review; commit cannot silently import new bytes.
  for(const item of preview.items){const current=selectionItem(item.selection,roster);if(current.hash!==item.hash||current.scopeId!==item.scopeId||current.text!==item.text)throw new Error("MEMORY_IMPORT_CHANGED");}
  return commitImportItems(preview.items, track);
}

function commitImportItems(items:ImportItem[], track=false){
  return transaction(db=>{
    let imported=0,skipped=0;const recordIds:string[]=[];
    for(const item of items){
      const id=`legacy:${hash(JSON.stringify([item.scopeId,item.path]))}`;
      if(db.prepare("SELECT 1 FROM memory_tombstones WHERE (target_type='source' AND target_id=?) OR (target_type='import' AND target_id=? AND content_hash=?)").get(id,item.scopeId,item.hash))throw new Error("MEMORY_IMPORT_FORGOTTEN");
      const prior=db.prepare("SELECT revision,content_hash,state FROM memory_sources WHERE id=?").get(id);
      if(prior && prior.state!=="active")throw new Error("MEMORY_IMPORT_SOURCE_RETIRED");
      if(prior && prior.content_hash!==item.hash && db.prepare("SELECT 1 FROM memory_records r WHERE r.id IN (SELECT record_id FROM memory_evidence WHERE source_id=?) AND (r.owner_pinned=1 OR r.state IN ('archived','deleted') OR r.assertion!='unverified-import') LIMIT 1").get(id))throw new Error("MEMORY_IMPORT_REVIEW_CONFLICT");
      if(track){
        // Written only when the link is new or something about it changed: a rescan of
        // an unchanged notebook leaves the database as it found it.
        const linked=db.prepare("SELECT state,intent FROM memory_scope_bindings WHERE id=?").get(`notebook-link:${id}`);
        let unchanged=false;
        if(linked?.state==="granted"){try{const saved=JSON.parse(String(linked.intent));unchanged=saved.hash===item.hash&&saved.status==="current"&&!saved.error&&JSON.stringify(saved.selection)===JSON.stringify(item.selection);}catch{/* rewritten below */}}
        if(!unchanged)db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','notebook-link',0,'granted',?) ON CONFLICT(id) DO UPDATE SET state='granted',intent=excluded.intent")
          .run(`notebook-link:${id}`,item.scopeId,JSON.stringify({selection:item.selection,hash:item.hash,status:"current",checkedAt:Date.now()}));
      }
      if(prior?.content_hash===item.hash){skipped++;continue;}
      const revision=prior?Number(prior.revision)+1:1;
      db.prepare("UPDATE memory_records SET state='superseded' WHERE id IN (SELECT record_id FROM memory_evidence WHERE source_id=?) AND state!='deleted'").run(id);
      db.prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,?,?,'legacy-import','import','imported',NULL,'active') ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,state='active'").run(id,item.scopeId,revision,item.hash);
      db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,?)").run(id,revision,item.hash,JSON.stringify({text:item.text,path:item.path,originalHash:item.hash,selection:item.selection}),Date.now());
      for(const [index,chunk] of chunksFor(item.text).entries()){
        const recordId=`${id}:chunk:${index}`;recordIds.push(recordId);
        db.prepare("INSERT INTO memory_records VALUES(?,?,?,'evidence',?,'unverified-import','active',0,?,NULL,NULL,?)").run(recordId,revision,item.scopeId,chunk.text,Date.now(),Date.now());
        db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,?,?)").run(recordId,revision,id,revision,chunk.startByte,chunk.endByte);
        db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(recordId,revision);
      }
      imported++;
    }
    if(imported){db.exec("UPDATE memory_meta SET data_revision=data_revision+1");revokeAllDisclosures(db,"import");}
    return {imported,skipped,recordIds,originals:"preserved" as const};
  });
}

/** What the poller last saw of one link: the intent text it read (a changed
 * intent means someone else wrote the row, so everything is read afresh), when
 * it last looked, and the file's size and modified time then. In memory: a
 * restart reads every file once. */
const linkSeen=new Map<string,{intent:string;at:number;sig:string|undefined;fullAt:number}>();
/** A file that has not changed on disk is still read again this often, so a change
 * the size and time did not show, or a forgotten original, is not missed for long. */
const LINK_FULL_RECHECK_MS=60_000;
const LINK_POLL_MS=10_000;
/** Size and modified time of the file a selection reads, without reading it; undefined when
 * that cannot be told cheaply (the full read then decides, and refuses what it must). */
function selectionStat(selection:ImportSelection):string|undefined {
  try{
    let path:string;
    if(selection.kind==="section")path=join(DATA_DIR,"section-contexts.json");
    else{
      if(!/^[\w-]+$/.test(selection.botId))return undefined;
      const partition=selection.kind==="partition"?selection.partition:{kind:"home" as const};
      const root=notebookRoot(selection.botId,partition);
      path=join(root,...selection.topic?["memory",selection.topic]:[partition.kind==="general"?"GENERAL.md":"MEMORY.md"]);
    }
    const stat=lstatSync(path);
    return stat.isFile()?`${stat.mtimeMs}:${stat.size}`:undefined;
  }catch{return undefined;}
}

/** Owner-selected links are polled in small batches; no whole-profile file watcher.
 * A link whose file has the size and modified time it had at the last look costs one
 * stat and no database write; the row is written only when its status, hash or
 * error changes. Nothing is written for a pass that found nothing new, so the
 * replay verdict cache (which a write flushes) survives it. */
export function syncTrackedMemoryImports(roster:MemoryRoster){
  const db=database();
  const mode=db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode;
  if(mode!=="active"&&mode!=="capture")return 0;
  if(checkedDatabase!==db){linkSeen.clear();checkedDatabase=db;}
  const rows=db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='notebook-link' AND state='granted'").all();
  type Link={selection:ImportSelection;hash:string;status:string;checkedAt:number;error?:string};
  const due:Array<{id:string;intent:string;link:Link;last:number;fresh:boolean}>=[];
  const now=Date.now();
  let changed=0;
  for(const row of rows){
    const id=String(row.id),intent=String(row.intent),seen=linkSeen.get(id),fresh=seen?.intent===intent;
    let link:Link;
    try{link=JSON.parse(intent);}catch{continue;}
    // First sight in this process or on this database (a restart, a reopened file) checks at once (int3 P5).
    const last=fresh?seen!.at:seen?link.checkedAt:0;
    if(now-last>=LINK_POLL_MS)due.push({id,intent,link,last,fresh});
  }
  for(const id of linkSeen.keys())if(!rows.some(row=>String(row.id)===id))linkSeen.delete(id);
  due.sort((a,b)=>a.last-b.last);
  for(const {id,intent,link:previous,fresh} of due.slice(0,4)){
    const seen=linkSeen.get(id),signature=selectionStat(previous.selection);
    if(fresh&&signature!==undefined&&signature===seen!.sig&&previous.status==="current"&&Date.now()-seen!.fullAt<LINK_FULL_RECHECK_MS){seen!.at=Date.now();continue;}
    let link:Link;
    try{
      const item=selectionItem(previous.selection,roster);
      commitImportItems([item]);
      link={selection:previous.selection,hash:item.hash,status:"current",checkedAt:Date.now()};
    }catch(error){
      const code=error instanceof Error?error.message:"MEMORY_IMPORT_SYNC_FAILED";
      link={...previous,status:"needs-review",checkedAt:Date.now(),error:code.startsWith("MEMORY_IMPORT_")?code:"MEMORY_IMPORT_FILE_UNREADABLE"};
    }
    let stored=intent;
    if(link.hash!==previous.hash||link.status!==previous.status||link.error!==previous.error){
      stored=JSON.stringify(link);
      db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=? AND state='granted'").run(stored,id);
      changed++;
    }
    linkSeen.set(id,{intent:stored,at:Date.now(),sig:signature,fullAt:Date.now()});
  }
  return changed;
}

export function memoryNotebookLinks(){
  const db=database();
  if(checkedDatabase!==db){linkSeen.clear();checkedDatabase=db;}
  return db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='notebook-link' AND state='granted'").all().map(row=>{
    // The poller's last look, while the row is the one it looked at (a durable edit starts a fresh check).
    const id=String(row.id),link=JSON.parse(String(row.intent)),seen=linkSeen.get(id),check=seen?.intent===String(row.intent)?seen:undefined;
    return {id,...link,...check?{checkedAt:check.at}:{}};
  });
}

export function stopTrackingMemoryNotebook(ticket:object,id:string){
  requireMemoryOwner(ticket);
  database().prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id=? AND subject_type='system' AND subject_id='notebook-link'").run(id);
  linkSeen.delete(id);
  return {stopped:true};
}

/** Startup migration: one bot and at most four files per call. A restart may
 * rescan names, but source hashes and receipts make publication idempotent.
 * Only Murage-owned private notebooks qualify; shared briefs stay reviewed.
 */
/** What a walk would look at, without reading any file: the bot ids and, for each, the size and
 * modified time of its MEMORY.md and of every topic file. Equal to the signature stored when the
 * last walk finished means that walk has nothing new to do. */
function notebookWalkSignature(bots:string[]):string{
  const parts:string[]=[];
  const stat=(path:string)=>{try{const info=lstatSync(path);return info.isFile()?`${info.mtimeMs}:${info.size}`:info.isSymbolicLink()?"link":"other";}catch{return "-";}};
  for(const id of bots){
    const base=join(DATA_DIR,"workspaces",id);
    parts.push(id,stat(join(base,"MEMORY.md")));
    try{
      const topics=join(base,"memory");
      if(lstatSync(topics).isSymbolicLink())parts.push("topics-link");
      else for(const topic of readdirSync(topics).sort())if(isMemoryTopicName(topic))parts.push(topic,stat(join(topics,topic)));
    }catch{parts.push("no-topics");}
  }
  return hash(JSON.stringify(parts));
}
const MIGRATION_DONE_ID="notebook-migration-done";
export function migrateDetectedMemoryNotebooks(roster:MemoryRoster,cursor?:string){
  const db=database();
  if(db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode!=="active")return {imported:0,skipped:0,needsReview:0,paused:true};
  const bots=roster.bots.filter(bot=>/^[\w-]+$/.test(bot.id)).map(bot=>bot.id).sort();
  // A finished walk is remembered with what it saw. A launch that finds the same bots and the same
  // files has nothing to import and reads and writes nothing; a new bot or notebook walks again.
  if(!cursor){
    const signature=notebookWalkSignature(bots);
    const done=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(MIGRATION_DONE_ID);
    try{if(done&&JSON.parse(String(done.intent)).signature===signature)return {imported:0,skipped:0,needsReview:0,paused:false};}catch{/* walk again */}
  }
  let after={bot:"",file:""};
  if(cursor){
    try{const parsed=JSON.parse(Buffer.from(cursor,"base64url").toString());if(typeof parsed.bot!=="string"||typeof parsed.file!=="string")throw new Error();after=parsed;}
    catch{throw new Error("INVALID_MEMORY_IMPORT_CURSOR");}
  }
  const botId=bots.find(id=>id>=after.bot);
  if(!botId)return {imported:0,skipped:0,needsReview:0,paused:false};
  const scopeId=ensureScope("bot",botId),base=join(DATA_DIR,"workspaces",botId);
  const selections:ImportSelection[]=[];
  const unsafeBase=[DATA_DIR,join(DATA_DIR,"workspaces"),base].some(path=>existsSync(path)&&lstatSync(path).isSymbolicLink());
  if(unsafeBase||existsSync(join(base,"MEMORY.md")))selections.push({kind:"bot",botId});
  const topics=join(base,"memory");
  // Invalid descendants are recorded by selectionItem, never followed.
  try{if(!unsafeBase&&!lstatSync(topics).isSymbolicLink())for(const topic of readdirSync(topics).sort())if(isMemoryTopicName(topic))selections.push({kind:"bot",botId,topic});}catch{/* No topic directory. */}
  const key=(selection:ImportSelection)=>selection.kind==="bot"&&selection.topic?`memory/${selection.topic}`:"MEMORY.md";
  const pending=selections.filter(selection=>botId!==after.bot||key(selection)>after.file).sort((a,b)=>key(a)<key(b)?-1:1);
  let imported=0,skipped=0,needsReview=0;
  for(const selection of pending.slice(0,4)){
    const path=join(base,key(selection)),sourceId=`legacy:${hash(JSON.stringify([scopeId,path]))}`,linkId=`notebook-link:${sourceId}`;
    // Stopping tracking is an owner choice, not an invitation to relink later.
    if(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=? AND state!='granted'").get(linkId)){skipped++;continue;}
    try{
      const item=selectionItem(selection,roster);
      if(item.text===MEMORY_SEED){skipped++;continue;}
      const result=commitImportItems([item],true);imported+=result.imported;skipped+=result.skipped;
    }catch(error){
      const code=error instanceof Error&&error.message.startsWith("MEMORY_IMPORT_")?error.message:"MEMORY_IMPORT_FILE_UNREADABLE";
      if(code==="MEMORY_IMPORT_EMPTY"){skipped++;continue;}
      const intent=JSON.stringify({selection,hash:"",status:"needs-review",checkedAt:Date.now(),error:code});
      db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','notebook-link',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent WHERE state='granted'").run(linkId,scopeId,intent);
      needsReview++;
    }
  }
  const next=pending.length>4?{bot:botId,file:key(pending[3])}:bots.find(id=>id>botId)?{bot:bots.find(id=>id>botId)!,file:""}:undefined;
  if(!next){
    const scope=db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id;
    if(scope)db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','notebook-migration',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
      .run(MIGRATION_DONE_ID,scope,JSON.stringify({signature:notebookWalkSignature(bots)}));
  }
  return {imported,skipped,needsReview,paused:false,...next?{nextCursor:Buffer.from(JSON.stringify(next)).toString("base64url")}:{}};
}

export function availableMemoryNotebooks(ticket:object,roster:MemoryRoster){
  requireMemoryOwner(ticket);
  const selections:ImportSelection[]=[];
  const issues:{label:string;error:string}[]=[];
  for(const bot of roster.bots){
    if(existsSync(join(DATA_DIR,"workspaces",bot.id,"MEMORY.md")))selections.push({kind:"bot",botId:bot.id});
    const topics=join(DATA_DIR,"workspaces",bot.id,"memory");
    try{
      if(existsSync(topics)){
        if(lstatSync(topics).isSymbolicLink())throw new Error("MEMORY_IMPORT_SYMLINK");
        for(const name of readdirSync(topics).slice(0,100))if(isMemoryTopicName(name))selections.push({kind:"bot",botId:bot.id,topic:name});
      }
    }catch{issues.push({label:bot.id,error:"Topic directory could not be read."});}
    for(const suffix of ["teams","projects","rooms","general"] as const){
      const base=join(DATA_DIR,"workspaces",`${bot.id}.${suffix}`);
      if(!existsSync(base)||lstatSync(base).isSymbolicLink())continue;
      const keys=suffix==="general"?[""]:readdirSync(base).filter(key=>/^[\w-]+$/.test(key)).slice(0,100);
      for(const key of keys){
        const partition:Partition=suffix==="general"?{kind:"general"}:suffix==="teams"?{kind:"team",teamId:key}:suffix==="projects"?{kind:"project",groupId:key}:{kind:"room",groupId:key};
        const root=notebookRoot(bot.id,partition);
        if(existsSync(join(root,suffix==="general"?"GENERAL.md":"MEMORY.md")))selections.push({kind:"partition",botId:bot.id,partition});
      }
    }
    if(selections.length>=1000)break;
  }
  const sections=[...new Set([...roster.bots,...roster.groups].map(item=>item.section?.trim()||""))];
  for(const section of sections){try{selectionItem({kind:"section",section},roster);selections.push({kind:"section",section});}catch{/* Missing briefs are not notebook files. */}}
  return {selections:selections.slice(0,1000),issues};
}
