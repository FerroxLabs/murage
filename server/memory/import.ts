import { type Partition, partitionScopeKey, isHomePartition } from "../execution-audience.ts";
import { teamMemoryKey } from "../team-identities.ts";
import { notebookRoot } from "../workspace.ts";
import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../config.ts";
import { ownedPath, rootFor, WorkspaceTreeError } from "../data-roots.ts";
import { transaction, database, isDatabaseBusy } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { chunksFor } from "./chunks.ts";
import { redactSecretsInText } from "../redact.ts";
import { isMemoryTopicName, MEMORY_SEED } from "../workspace.ts";
import { scopeRow } from "./scope-id.ts";
import { revokeAllDisclosures, revokeRecordDisclosures } from "./revocation.ts";
import { inheritEdge } from "./revoke-commit.ts";
import { insertMemoryRecord, safeMemoryRecordText } from "./record-write.ts";

export type ImportSelection = {kind:"bot";botId:string;topic?:string}|{kind:"section";section:string}|{kind:"partition";botId:string;partition:Partition;topic?:string};
// `hash` is over the text as stored (redacted and masked), so the hash kept beside a masked payload says nothing about the digits it
// lost. `legacyHash` is over the text as read, the hash 1.0.3 and earlier stored: a notebook forgotten then is still refused by its tombstone.
interface ImportItem {selection:ImportSelection;path:string;hash:string;legacyHash:string;bytes:number;text:string;scopeId:string;scopeLabel:string;alreadyImported:boolean}
interface Preview {previewId:string;items:ImportItem[];expiresAt:number;policyRevision:number}
const previews=new Map<string,Preview>();
/** Test hook: previews are process state that only time ends (at most 20 at once); a test file that imports many times starts each test with none. */
export function resetMemoryImportPreviews():void{previews.clear();}
let checkedDatabase:ReturnType<typeof database>|undefined;
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");

/** The part of an import path that survives a move of the data dir ("workspaces/bot/MEMORY.md", "section-contexts.json#Team"). */
function relativeImportPath(path:string):string{
  return (path.startsWith(DATA_DIR+sep)?path.slice(DATA_DIR.length+1):path).split(sep).join("/");
}
/** A notebook's source id. New ids hash [scope, path under DATA_DIR], so moving the data dir keeps them. A source already imported under the
 * old id (a hash of the absolute path) keeps that id, and one imported under another data dir's absolute path is found by its stored path
 * (a move or restore): no id is rewritten, so nothing is imported twice and a real change is still seen. Only an id with no row either way
 * (never imported, or moved) reads the scope's few legacy sources. */
const legacyIdMemo=new WeakMap<object,{revision:number;ids:Map<string,string|null>}>();
function importSourceId(db:ReturnType<typeof database>,scopeId:string,path:string):string{
  const relativeId=`legacy:${hash(JSON.stringify([scopeId,relativeImportPath(path)]))}`;
  const exists=db.prepare("SELECT 1 FROM memory_sources WHERE id=?");
  if(exists.get(relativeId))return relativeId;
  const absoluteId=`legacy:${hash(JSON.stringify([scopeId,path]))}`;
  if(exists.get(absoluteId))return absoluteId;
  const wanted="/"+relativeImportPath(path);
  // The scan below reads the scope's legacy sources: it is done once per (scope, path) until the memory data changes (data_revision moves on
  // every capture, import and edit), so a turn that meets the same notebook again reads two primary keys and one meta row.
  const revision=Number(db.prepare("SELECT data_revision AS r FROM memory_meta WHERE id=1").get()?.r);
  const memoKey=JSON.stringify([scopeId,wanted]),memo=legacyIdMemo.get(db);
  if(memo&&memo.revision===revision){const hit=memo.ids.get(memoKey);if(hit!==undefined)return hit??relativeId;}
  let found:string|null=null;
  for(const row of db.prepare("SELECT s.id,json_extract(v.payload,'$.path') AS stored FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id>='legacy:' AND s.id<'legacy;' AND s.scope_id=?").all(scopeId)){
    const stored=typeof row.stored==="string"?row.stored.replace(/\\/g,"/"):"";
    if(stored.endsWith(wanted)){found=String(row.id);break;}
  }
  if(!memo||memo.revision!==revision)legacyIdMemo.set(db,{revision,ids:new Map()});
  const ids=legacyIdMemo.get(db)!.ids;
  if(ids.size>=512)ids.delete(ids.keys().next().value!);
  ids.set(memoKey,found);
  if(found)return found;
  return relativeId;
}

/** The configured profile root is trusted; every selected descendant must be a
 * regular non-symlink file. Never accept arbitrary paths from import requests.
 */
function readSelected(parts:string[],maximum=262144):string {
  let path:string;
  if(parts[0]==="workspaces"){
    // C6 (S5-DATADIR-PATHS r4.1): a linked workspaces root is followed once, at its admitted canonical target (DR3/DR4);
    // a link below the root, or a root that is not ok, is still MEMORY_IMPORT_SYMLINK.
    if(parts.length<2||parts.some(part=>!part||part==="."||part===".."))throw new Error("MEMORY_IMPORT_PATH_DENIED");
    let dir:string;
    try{dir=ownedPath(join(DATA_DIR,...parts.slice(0,-1)),{create:false}).canonical;}
    catch(error){if(error instanceof WorkspaceTreeError)throw new Error("MEMORY_IMPORT_SYMLINK");throw error;}
    path=join(dir,parts[parts.length-1]!);
    if(lstatSync(path).isSymbolicLink())throw new Error("MEMORY_IMPORT_SYMLINK");
  } else {
    if(lstatSync(DATA_DIR).isSymbolicLink())throw new Error("MEMORY_IMPORT_SYMLINK");
    const root=realpathSync(DATA_DIR);path=join(root,...parts);
    const rel=relative(root,path);if(rel.startsWith(`..${sep}`)||rel===".."||resolve(path)===root)throw new Error("MEMORY_IMPORT_PATH_DENIED");
    let at=root;
    for(const part of parts){at=join(at,part);if(lstatSync(at).isSymbolicLink())throw new Error("MEMORY_IMPORT_SYMLINK");}
  }
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
  const legacyHash=hash(text);
  text=redactSecretsInText(text);
  const originalHash=hash(text);
  if(!text.trim())throw new Error("MEMORY_IMPORT_EMPTY");
  const sourceId=importSourceId(database(),scopeId,path);
  const previous=database().prepare("SELECT content_hash FROM memory_sources WHERE id=?").get(sourceId);
  return {selection,path,hash:originalHash,legacyHash,bytes:Buffer.byteLength(text),text,scopeId,scopeLabel,alreadyImported:previous?.content_hash===originalHash||previous?.content_hash===legacyHash};
}

/** Import sources for the two notebooks a turn's prompt carries whole: the
 * bot's MEMORY.md and its section's team brief. Recall skips records that
 * rest only on these, so one fact is not sent twice. Read-only: an absent
 * scope means nothing was imported from it. */
export function notebookSourceIds(botId:string,section?:string|null,partition:Partition = {kind:"home"}):{notebook?:string;brief?:string;general?:string} {
  if(partition.kind === "isolated") return {};
  const db=database(),team=isHomePartition(partition) ? section?.trim()||"" : partition.kind === "team" ? teamMemoryKey(partition.teamId) : null;
  const scope=(kind:string,owner:string)=>scopeRow(db, kind,owner)?.id;
  const idOf=(scopeId:unknown,path:string)=>importSourceId(db,String(scopeId),path);
  const bot=scope("bot",partitionScopeKey(botId,partition)!),brief=team === null ? undefined : scope("team",team);
  const general=partition.kind !== "general" ? scope("bot",botId+"#general") : undefined;
  return {
    ...general?{general:idOf(general,join(notebookRoot(botId,{kind:"general"}),"GENERAL.md"))}:{},
    ...bot?{notebook:idOf(bot,join(notebookRoot(botId,partition),partition.kind === "general" ? "GENERAL.md" : "MEMORY.md"))}:{},
    ...brief?{brief:idOf(brief,`${join(DATA_DIR,"section-contexts.json")}#${team}`)}:{},
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
  // cause10 v2 (review High, import.ts:187): the items written are the ones read NOW, so the forget checks see the raw hash (legacyHash)
  // of the bytes committed, never the preview's (other raw bytes that redact to the same text would be checked under the wrong hash)
  const current=preview.items.map(item=>{const now=selectionItem(item.selection,roster);if(now.hash!==item.hash||now.scopeId!==item.scopeId||now.text!==item.text)throw new Error("MEMORY_IMPORT_CHANGED");return now;});
  return commitImportItems(current, track);
}

/** Whether memory_evidence_by_source is built (every older row is in it). Until then a changed import is deferred, never answered by a scan of the
 * evidence table (455,296 rows, 77 MB, on the main thread for the whole upgrade). */
function evidenceReady(db:ReturnType<typeof database>):boolean{
  try{return Number(db.prepare("SELECT ready FROM memory_late_build WHERE name='evidence'").get()?.ready)===1;}catch{return false;/* no late table yet */}
}
const evidenceSourceQuery="SELECT record_id FROM memory_evidence_by_source WHERE source_id=?";
const CONFLICT_OF_RECORD="(r.owner_pinned=1 OR r.state IN ('archived','deleted') OR r.assertion!='unverified-import')";

/** cause10: `keep` off writes a changed notebook as 1.0.20 and 1.0.21 did (every chunk superseded and written again). Tests only: upgraded
 * profiles hold such chains, and the readers' witnesses for them (ctxrev-h1-import-tick.test.ts) build theirs through the real import. */
export const IMPORT_CHUNK_DIFF={keep:true};
/** cause10: the newest version of chunk ?1 when a changed notebook (source ?2, until now at revision ?3, scope ?4) leaves it as it is: active,
 * an import chunk with exactly the new text ?5, not pinned, resting on that notebook alone at the revision being replaced, with no later
 * version of any state, no tombstone and no deny mark on it (a marked or tombstoned chunk is written afresh, as before). */
const KEEPABLE_CHUNK=`SELECT r.version FROM memory_records r WHERE r.id=?1 AND r.state='active' AND r.kind='evidence' AND r.assertion='unverified-import'
  AND r.owner_pinned=0 AND r.scope_id=?4 AND r.text=?5 AND r.version=(SELECT max(m.version) FROM memory_records m WHERE m.id=r.id)
  AND (SELECT count(*) FROM memory_evidence e WHERE e.record_id=r.id AND e.record_version=r.version)=1
  AND EXISTS (SELECT 1 FROM memory_evidence e WHERE e.record_id=r.id AND e.record_version=r.version AND e.source_id=?2 AND e.source_revision=?3)
  AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM memory_deny_memory d WHERE d.kind='record' AND d.id=r.id AND d.version IN (0,r.version))`;
/** `retryLater`: the tracked sync and the notebook walk, which leave the link as it was and look again. Anything else is told to try again in a moment. */
function commitImportItems(items:ImportItem[], track=false, retryLater=false){
  return transaction(db=>{
    let imported=0,skipped=0;const recordIds:string[]=[];const withdrawn:Record<string,number>={};const replacement:Record<string,number>={};const withdrawnSources:string[]=[];let deferred=0;
    for(const item of items){
      const id=importSourceId(db,item.scopeId,item.path);
      if(db.prepare("SELECT 1 FROM memory_tombstones WHERE (target_type='source' AND target_id=?) OR (target_type='import' AND target_id=? AND content_hash IN (?,?))").get(id,item.scopeId,item.hash,item.legacyHash??item.hash))throw new Error("MEMORY_IMPORT_FORGOTTEN");
      // 1.0.21 cause10 v2: a Forget is effective for import from its own commit by that key alone: every revision's import key is in the
      // Forget's commit (forget.ts), and a Forget an older build left queued is keyed whole before the open returns (legacy-forget-keys.ts).
      const prior=db.prepare("SELECT revision,content_hash,state FROM memory_sources WHERE id=?").get(id);
      if(prior && prior.state!=="active")throw new Error("MEMORY_IMPORT_SOURCE_RETIRED");
      // No row for the source means no evidence can name it (the foreign key runs through memory_sources), so a first import reads no evidence at
      // all. A changed one reads it by source through memory_evidence_by_source, which leads with source_id (memory_evidence has no index on it).
      // While that index is not built nothing of the notebook is applied: records that cite the old revision (derived ones too) could not all be
      // found, and the tracked sync tries it again once the index is ready.
      // an unscrubbed 1.0.3 row holds the hash of the text as read: the same notebook, not a change (the scrub rewrites the hash)
      const unchangedSince=Boolean(prior && (prior.content_hash===item.hash || prior.content_hash===item.legacyHash));
      if(prior && !unchangedSince){
        if(!evidenceReady(db)){
          if(!retryLater)throw new Error("MEMORY_IMPORT_INDEX_BUILDING");
          deferred++;continue;
        }
        if(db.prepare(`SELECT 1 FROM memory_records r WHERE r.id IN (${evidenceSourceQuery}) AND ${CONFLICT_OF_RECORD} LIMIT 1`).get(id))throw new Error("MEMORY_IMPORT_REVIEW_CONFLICT");
      }
      if(track){
        // Written only when the link is new or something about it changed: a rescan of
        // an unchanged notebook leaves the database as it found it.
        const linked=db.prepare("SELECT state,intent FROM memory_scope_bindings WHERE id=?").get(`notebook-link:${id}`);
        let unchanged=false;
        if(linked?.state==="granted"){try{const saved=JSON.parse(String(linked.intent));unchanged=saved.hash===item.hash&&saved.status==="current"&&!saved.error&&JSON.stringify(saved.selection)===JSON.stringify(item.selection);}catch{/* rewritten below */}}
        if(!unchanged)db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','notebook-link',0,'granted',?) ON CONFLICT(id) DO UPDATE SET state='granted',intent=excluded.intent")
          .run(`notebook-link:${id}`,item.scopeId,JSON.stringify({selection:item.selection,hash:item.hash,status:"current",checkedAt:Date.now()}));
      }
      if(unchangedSince){skipped++;continue;}
      const revision=prior?Number(prior.revision)+1:1;
      // 1.0.20 T5: a changed notebook ends only the receipts that cite what it withdraws (its earlier chunks and the notebook source), never
      // every receipt on the machine (that reset every warm session and refused the next turn on every thread). The write-time revoke names
      // the earlier version of each chunk, so its replacement, which shares the id, is not denied with it. A first import ends nothing.
      // 1.0.21 cause10 (chunk-diff): a chunk whose words did not change keeps its record, its version and its projection receipt. Only its
      // evidence handle moves to the new notebook revision (every reader asks that an active record's evidence cites the current revision).
      // Before this, one appended line superseded and rewrote EVERY chunk as a new version (a change-journal row and a projection receipt
      // each, re-projected into every recall view), and the supersede UPDATE also re-touched every OLDER version of every chunk, so the
      // cost of one append grew with the notebook's size times its revision count.
      const chunks=chunksFor(item.text);
      const kept=new Map<number,number>();
      if(prior){
        const keepable=db.prepare(KEEPABLE_CHUNK);
        if(IMPORT_CHUNK_DIFF.keep)for(const [index,chunk] of chunks.entries()){
          const row=keepable.get(`${id}:chunk:${index}`,id,Number(prior.revision),item.scopeId,safeMemoryRecordText("evidence",chunk.text));
          if(row)kept.set(index,Number(row.version));
        }
        const keptIds=JSON.stringify([...kept.keys()].map(index=>`${id}:chunk:${index}`));
        // the newest version of each: the one this change withdraws (earlier ones were withdrawn by the change that replaced them). An id
        // with no version left to withdraw (a chunk a shorter notebook dropped at an earlier change, withdrawn then) is not withdrawn again:
        // it would take a whole-record revoke on every later change, for ever.
        for(const row of db.prepare(`SELECT id,MAX(version) AS version FROM memory_records WHERE id IN (${evidenceSourceQuery}) AND state NOT IN ('deleted','superseded') AND id NOT IN (SELECT value FROM json_each(?)) GROUP BY id`).all(id,keptIds))withdrawn[String(row.id)]=Number(row.version);
        withdrawnSources.push(id);
        // a version already superseded is not written again (each such write was a change-journal row for nothing)
        db.prepare(`UPDATE memory_records SET state='superseded' WHERE id IN (${evidenceSourceQuery}) AND state NOT IN ('deleted','superseded') AND id NOT IN (SELECT value FROM json_each(?))`).run(id,keptIds);
      }
      db.prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,?,?,'legacy-import','import','imported',NULL,'active') ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,state='active'").run(id,item.scopeId,revision,item.hash);
      db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,?)").run(id,revision,item.hash,JSON.stringify({text:item.text,path:item.path,originalHash:item.hash,selection:item.selection}),Date.now());
      for(const [index,chunk] of chunks.entries()){
        const recordId=`${id}:chunk:${index}`;recordIds.push(recordId);
        const keptVersion=kept.get(index);
        if(keptVersion!==undefined){
          // delete + insert, never UPDATE: memory_evidence_by_source is kept by the insert and delete triggers only
          db.prepare("DELETE FROM memory_evidence WHERE record_id=? AND record_version=? AND source_id=?").run(recordId,keptVersion,id);
          db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,?,?)").run(recordId,keptVersion,id,revision,chunk.startByte,chunk.endByte);
          // the re-inserted edge is a late write like any other (2.11, T15): a Forget of this source whose walk already passed takes the kept version at its write
          inheritEdge(db,{kind:"record",id:recordId,version:keptVersion},{kind:"source",id});
          continue;
        }
        replacement[recordId]=revision;
        insertMemoryRecord(db,{id:recordId,version:revision,scopeId:item.scopeId,kind:"evidence",text:chunk.text,assertion:"unverified-import",state:"active",validFrom:Date.now(),createdAt:Date.now()});
        db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,?,?)").run(recordId,revision,id,revision,chunk.startByte,chunk.endByte);
        inheritEdge(db,{kind:"record",id:recordId,version:revision},{kind:"source",id});
        db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(recordId,revision);
      }
      imported++;
    }
    // A brand-new notebook withdraws nothing: no receipt could cite it, so no session resets and no hold moves (the notebook-link binding is a
    // NOISY subject of the authority epoch). A changed one ends the receipts citing what it withdrew (T5 above).
    // cause10: a change that withdrew no record (every earlier chunk kept, e.g. an append that only adds chunks) ends nothing and revokes
    // nothing: no receipt scan, no revoke job, no pending window, no deny generation bump.
    if(imported){db.exec("UPDATE memory_meta SET data_revision=data_revision+1");if(withdrawnSources.length&&Object.keys(withdrawn).length){
      // The write-time revoke names a version ONLY for a chunk whose replacement keeps its id, and only when that earlier version is a real
      // one below the replacement's (memory_records is keyed by id and version, so it always is). A withdrawn record with no replacement
      // (a shorter notebook, a record derived from the old text) is withdrawn at every version, as a record edit withdraws it. If the two
      // versions could not be told apart, a version-scoped revoke would deny the replacement too: every receipt ends instead, as before 1.0.20.
      const versions:Record<string,number>={};let indistinct=false;
      for(const [recordId,version] of Object.entries(withdrawn)){const next=replacement[recordId];if(next===undefined)continue;if(!(version>0)||version>=next)indistinct=true;else versions[recordId]=version;}
      // 1.0.20 reclaim-n6: a chunk whose replacement keeps its id AND its exact words withdraws nothing a session was shown, so it takes no
      // write-time revoke (each one held every thread's lines in checking:pending until the paced marker walked it; a routine's one-line
      // append to a notebook queued one per chunk, every minute). Receipts citing the notebook source still end below (sourceIds).
      if(!indistinct){const same=db.prepare("SELECT 1 FROM memory_records o JOIN memory_records n ON n.id=o.id WHERE o.id=? AND o.version=? AND n.version=? AND n.text=o.text AND n.kind=o.kind AND n.scope_id=o.scope_id");
        for(const [recordId,version] of Object.entries(versions))if(same.get(recordId,version,replacement[recordId]!)){delete withdrawn[recordId];delete versions[recordId];}}
      if(indistinct)revokeAllDisclosures(db,"import");
      // 1.0.20 ctxrev-h1: a receipt that cites only unchanged chunks (and so the notebook source at its old revision) keeps its turn: it
      // ends by a withdrawn record it cites, never by the source alone (deny-read.ts judges that source by the chunk's replacement).
      else revokeRecordDisclosures(db,"import",{recordIds:Object.keys(withdrawn),sourceIds:withdrawnSources,versions,receiptsByRecordOnly:true});
    }}
    return {imported,skipped,deferred,recordIds,originals:"preserved" as const};
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

/** The stored source for this item is active, holds exactly this text's hash and has no tombstone: committing it would change nothing. */
function unchangedActive(item:ImportItem):boolean{
  const db=database(),id=importSourceId(db,item.scopeId,item.path);
  if(db.prepare("SELECT 1 FROM memory_tombstones WHERE (target_type='source' AND target_id=?) OR (target_type='import' AND target_id=? AND content_hash IN (?,?))").get(id,item.scopeId,item.hash,item.legacyHash))return false;
  return Boolean(db.prepare("SELECT 1 FROM memory_sources WHERE id=? AND state='active' AND content_hash=?").get(id,item.hash));
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
      // 1.0.20 checkfix-n4: byte-identical text (a file rewritten or touched with the same words: a new mtime, the same hash as the stored
      // source) is a no-op before any transaction, revoke or receipt work; only a changed hash reaches the commit and its write-time revoke.
      if(item.alreadyImported&&item.hash===previous.hash&&previous.status==="current"&&!previous.error&&unchangedActive(item)){linkSeen.set(id,{intent,at:Date.now(),sig:signature,fullAt:Date.now()});continue;}
      if(commitImportItems([item],false,true).deferred)continue; // the evidence index is not ready: the link keeps its old hash and the next look tries again
      link={selection:previous.selection,hash:item.hash,status:"current",checkedAt:Date.now()};
    }catch(error){
      // a held write lock is "try again shortly" (the idle pass is retried), never a link that needs review
      if(isDatabaseBusy(error))throw error;
      const code=error instanceof Error?error.message:"MEMORY_IMPORT_SYNC_FAILED";
      link={...previous,status:"needs-review",checkedAt:Date.now(),error:code.startsWith("MEMORY_IMPORT_")?code:"MEMORY_IMPORT_FILE_UNREADABLE"};
    }
    let stored=intent;
    if(link.hash!==previous.hash||link.status!==previous.status||link.error!==previous.error){
      stored=JSON.stringify(link);
      transaction(d=>d.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=? AND state='granted'").run(stored,id),{op:"notebook-link"});
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
  // C6: the workspaces root through rootFor + ownedPath (a linked root at its canonical target); a link below it stays unsafe.
  let canonicalBase:string|undefined;
  try{if(lstatSync(DATA_DIR).isSymbolicLink())throw new Error("MEMORY_IMPORT_SYMLINK");rootFor("workspaces");canonicalBase=ownedPath(base,{create:false}).canonical;}catch{canonicalBase=undefined;}
  const unsafeBase=canonicalBase===undefined;
  if(unsafeBase||existsSync(join(canonicalBase!,"MEMORY.md")))selections.push({kind:"bot",botId});
  // Invalid descendants are recorded by selectionItem, never followed.
  try{if(!unsafeBase){const topics=join(canonicalBase!,"memory");if(!lstatSync(topics).isSymbolicLink())for(const topic of readdirSync(topics).sort())if(isMemoryTopicName(topic))selections.push({kind:"bot",botId,topic});}}catch{/* No topic directory. */}
  const key=(selection:ImportSelection)=>selection.kind==="bot"&&selection.topic?`memory/${selection.topic}`:"MEMORY.md";
  const pending=selections.filter(selection=>botId!==after.bot||key(selection)>after.file).sort((a,b)=>key(a)<key(b)?-1:1);
  let imported=0,skipped=0,needsReview=0;
  for(const selection of pending.slice(0,4)){
    const path=join(base,key(selection)),sourceId=importSourceId(db,scopeId,path),linkId=`notebook-link:${sourceId}`;
    // Stopping tracking is an owner choice, not an invitation to relink later.
    if(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=? AND state!='granted'").get(linkId)){skipped++;continue;}
    try{
      const item=selectionItem(selection,roster);
      if(item.text===MEMORY_SEED){skipped++;continue;}
      const result=commitImportItems([item],true,true);imported+=result.imported;skipped+=result.skipped+result.deferred;
    }catch(error){
      if(isDatabaseBusy(error))throw error; // as above: the walk carries on from its cursor at the next idle pass
      const code=error instanceof Error&&error.message.startsWith("MEMORY_IMPORT_")?error.message:"MEMORY_IMPORT_FILE_UNREADABLE";
      if(code==="MEMORY_IMPORT_EMPTY"){skipped++;continue;}
      const intent=JSON.stringify({selection,hash:"",status:"needs-review",checkedAt:Date.now(),error:code});
      transaction(d=>d.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','notebook-link',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent WHERE state='granted'").run(linkId,scopeId,intent),{op:"notebook-link"});
      needsReview++;
    }
  }
  const next=pending.length>4?{bot:botId,file:key(pending[3])}:bots.find(id=>id>botId)?{bot:bots.find(id=>id>botId)!,file:""}:undefined;
  if(!next){
    const scope=db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id;
    if(scope)transaction(d=>d.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','notebook-migration',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
      .run(MIGRATION_DONE_ID,scope,JSON.stringify({signature:notebookWalkSignature(bots)})),{op:"notebook-migration"});
  }
  return {imported,skipped,needsReview,paused:false,...next?{nextCursor:Buffer.from(JSON.stringify(next)).toString("base64url")}:{}};
}

export function availableMemoryNotebooks(ticket:object,roster:MemoryRoster){
  requireMemoryOwner(ticket);
  const selections:ImportSelection[]=[];
  const issues:{label:string;error:string}[]=[];
  for(const bot of roster.bots){
    if(existsSync(join(DATA_DIR,"workspaces",bot.id,"MEMORY.md")))selections.push({kind:"bot",botId:bot.id});
    try{
      // C6: walked from the workspaces root's canonical target; a link at the bot folder or memory throws here
      const topics=ownedPath(join(DATA_DIR,"workspaces",bot.id,"memory"),{create:false}).canonical;
      if(existsSync(topics)){
        if(lstatSync(topics).isSymbolicLink())throw new Error("MEMORY_IMPORT_SYMLINK");
        for(const name of readdirSync(topics).slice(0,100))if(isMemoryTopicName(name))selections.push({kind:"bot",botId:bot.id,topic:name});
      }
    }catch{issues.push({label:bot.id,error:"Topic directory could not be read."});}
    for(const suffix of ["teams","projects","rooms","general"] as const){
      let base:string;
      try{base=ownedPath(join(DATA_DIR,"workspaces",`${bot.id}.${suffix}`),{create:false}).canonical;}catch{continue;}
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
