import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../config.ts";
import { transaction, database } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { chunksFor } from "./chunks.ts";
import { redactSecretsInText } from "../redact.ts";
import { isMemoryTopicName } from "../workspace.ts";

export type ImportSelection = {kind:"bot";botId:string;topic?:string}|{kind:"section";section:string};
interface ImportItem {selection:ImportSelection;path:string;hash:string;bytes:number;text:string;scopeId:string;scopeLabel:string;alreadyImported:boolean}
interface Preview {previewId:string;items:ImportItem[];expiresAt:number;policyRevision:number}
const previews=new Map<string,Preview>();
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
  if(selection.kind==="bot"){
    if(!/^[\w-]+$/.test(selection.botId)||!roster.bots.some(bot=>bot.id===selection.botId))throw new Error("MEMORY_IMPORT_BOT_UNKNOWN");
    if(selection.topic!==undefined&&!isMemoryTopicName(selection.topic))throw new Error("MEMORY_IMPORT_TOPIC_DENIED");
    const parts=["workspaces",selection.botId,...selection.topic?["memory",selection.topic]:["MEMORY.md"]];
    text=readSelected(parts);path=join(DATA_DIR,...parts);scopeId=ensureScope("bot",selection.botId);scopeLabel=`Private notebook: ${selection.botId}`;
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

export function commitMemoryImport(ticket:object,previewId:string,roster:MemoryRoster){
  requireMemoryOwner(ticket);
  const preview=previews.get(previewId);
  if(!preview||preview.expiresAt<Date.now())throw new Error("MEMORY_IMPORT_PREVIEW_EXPIRED");
  if(Number(database().prepare("SELECT policy_revision FROM memory_meta WHERE id=1").get()!.policy_revision)!==preview.policyRevision)throw new Error("MEMORY_IMPORT_POLICY_CHANGED");
  // File changes require another review; commit cannot silently import new bytes.
  for(const item of preview.items){const current=selectionItem(item.selection,roster);if(current.hash!==item.hash||current.scopeId!==item.scopeId||current.text!==item.text)throw new Error("MEMORY_IMPORT_CHANGED");}
  return transaction(db=>{
    let imported=0,skipped=0;const recordIds:string[]=[];
    for(const item of preview.items){
      const id=`legacy:${hash(JSON.stringify([item.scopeId,item.path]))}`;
      if(db.prepare("SELECT 1 FROM memory_tombstones WHERE (target_type='source' AND target_id=?) OR (target_type='import' AND target_id=? AND content_hash=?)").get(id,item.scopeId,item.hash))throw new Error("MEMORY_IMPORT_FORGOTTEN");
      const prior=db.prepare("SELECT revision,content_hash FROM memory_sources WHERE id=?").get(id);
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
    if(imported){db.exec("UPDATE memory_meta SET data_revision=data_revision+1");db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'").run();}
    return {imported,skipped,recordIds,originals:"preserved" as const};
  });
}
