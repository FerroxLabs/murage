import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { database, transaction } from "../database.ts";
import { redactSecretsInText } from "../redact.ts";
import { requireMemoryOwner } from "./authority.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { PIP_OWNER_KINDS, isPipKind, isPipOwnerKind, pipCounterId, pipRenderId, pipTierOf } from "./pip-kinds.ts";
import { claimEntity, parseAuthoredStatement } from "./pip-claims.ts";
import type { MemoryBundle } from "../../shared/memory.ts";
import { applyRecordTombstone } from "./restore.ts";
import { revokeRecordDisclosures, revokeAllDisclosures } from "./revocation.ts";

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
export const identityWriteSchema = z.object({
  action:z.literal("identity-write"),botId:z.string().min(1).max(180),
  kind:z.enum(["continuity-brief","character-canon","reveal-state","commitment","self-trait","relation"]),key,
  expectedVersion:z.number().int().nonnegative(),
  /** The record id the caller based its edit on (the relation's generation lives in its id). Absent for a new row. */
  expectedId:z.string().min(1).max(180).optional(),text:z.string().min(1).max(4096),
  basis:z.enum(["owner-fact","fiction"]),
  audience:z.literal("owner-private"),
  canon:z.object({id:z.string().min(1).max(180),version:z.number().int().positive()}).strict().optional(),
  revealed:z.boolean().optional(),
}).strict();
export const identityReadSchema = z.object({action:z.literal("identity-read"),botId:z.string().min(1).max(180),cursor:z.string().max(180).optional()}).strict();
export const identityDeleteSchema = z.object({action:z.literal("identity-delete"),botId:z.string().min(1).max(180),kind:z.enum([...PIP_OWNER_KINDS,"continuity-brief"]),key,expectedVersion:z.number().int().positive(),expectedId:z.string().min(1).max(180).optional()}).strict();
export const continuityReadSchema = z.object({action:z.literal("continuity-read"),botId:z.string().min(1).max(180)}).strict();
export type IdentityWrite = z.infer<typeof identityWriteSchema>;

/** PIP P1 (owner-authored Continuity): per-kind active-row cap and slug rules. */
export const PIP_ACTIVE_CAP = 24;
const PIP_SLUG = /^[a-z0-9-]{1,48}$/;
const PIP_BASIS = "pip:attested; Owner-authored continuity; not independently verified";

export function botIdentityRecordId(botId:string,kind:IdentityWrite["kind"],identityKey:string,generation=0) {
  return "identity:"+createHash("sha256").update(JSON.stringify(generation?[botId,kind,identityKey,"owner-private",generation]:[botId,kind,identityKey,"owner-private"])).digest("hex");
}
type Db=ReturnType<typeof database>;
/** The live record id for a key. The relation ("How we work together") is a
 * singleton whose id carries a generation: deleting it tombstones that id
 * for good, and the next write lands on the first generation whose id is not
 * tombstoned, so the field is never permanently disabled. Every other kind
 * keeps its single id (a deleted slug stays retired). Generation 0 is the
 * original id, so existing data is unchanged. */
function currentIdentityId(db:Db,botId:string,kind:IdentityWrite["kind"],identityKey:string) {
  // The brief joined the PIP kinds with a dedicated, version-fenced delete (I-10), so it
  // gets the relation's generations: a deleted brief must not retire the field for good.
  if(kind!=="relation"&&kind!=="continuity-brief")return botIdentityRecordId(botId,kind,identityKey);
  for(let generation=0;;generation++){
    const id=botIdentityRecordId(botId,kind,identityKey,generation);
    if(!db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(id))return id;
  }
}

/** Fence an edit or delete to the record generation the caller saw. A relation or brief re-created after a delete is a new
 * id whose version restarts at 1, so a version alone cannot tell it from the one a stale window holds. A relation or brief
 * edit or delete that names a version must therefore name its id too; any other kind may omit it, but an id it
 * does send must still match. A mismatch is a version conflict, never a write. */
function fenceIdentityId(kind:IdentityWrite["kind"],current:string,expectedId:string|undefined,versionNamed:boolean) {
  if(expectedId===undefined?((kind==="relation"||kind==="continuity-brief")&&versionNamed):expectedId!==current)throw new Error("MEMORY_VERSION_CONFLICT");
}

function privateScope(ticket:object,botId:string,roster:MemoryRoster) {
  requireMemoryOwner(ticket);
  if(!roster.bots.some(bot=>bot.id===botId))throw new Error("MEMORY_SUBJECT_UNKNOWN");
  return ensureScope("bot",botId);
}
/** One stable private identity record per canonical key; an edit is a new
 * authoritative memory version, never a second store or an implicit promotion. */
export function writeBotIdentity(ticket:object,input:IdentityWrite,roster:MemoryRoster) {
  requireMemoryOwner(ticket);
  input=identityWriteSchema.parse(input);
  if(!input.text.trim() || Buffer.byteLength(input.text)> (input.kind==="continuity-brief"?768:4096))throw new Error("MEMORY_IDENTITY_TEXT_LIMIT");
  // The brief is a PIP kind (no receipt, PIP-only revoke) but keeps its own
  // basis and key contract; the owner rows below are the slug-keyed ones.
  const pip=isPipKind(input.kind),ownerRow=isPipOwnerKind(input.kind);
  if(ownerRow){
    // Owner bytes are the attestation: no evidence, no fiction basis, a strict key.
    if(input.basis!=="owner-fact")throw new Error("MEMORY_IDENTITY_PIP_BASIS_INVALID");
    if(input.kind==="relation"?input.key!=="owner":!PIP_SLUG.test(input.key))throw new Error("MEMORY_IDENTITY_PIP_KEY_INVALID");
  }
  if(input.kind==="continuity-brief"&&input.key!=="core")throw new Error("MEMORY_IDENTITY_CORE_KEY_REQUIRED");
  if(input.kind==="character-canon"&&input.basis!=="fiction")throw new Error("MEMORY_IDENTITY_FICTION_REQUIRED");
  if(input.kind==="reveal-state"?!input.canon||input.revealed===undefined:input.canon!==undefined||input.revealed!==undefined)throw new Error("MEMORY_IDENTITY_REVEAL_INVALID");
  const scopeId=privateScope(ticket,input.botId,roster);
  // Reveals are indexed by canonical fact and audience, not a caller-selected
  // event key: repeated reports update one durable state across tasks/models.
  const identityKey=input.kind==="reveal-state"?input.canon!.id:input.key;
  return transaction(db=>{
    const id=currentIdentityId(db,input.botId,input.kind,identityKey);
    fenceIdentityId(input.kind,id,input.expectedId,input.expectedVersion>0);
    const previous=db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
    if(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(id)||previous?.state==="deleted")throw new Error("MEMORY_RECORD_UNAVAILABLE");
    if(Number(previous?.version??0)!==input.expectedVersion || previous&&previous.state!=="active")throw new Error("MEMORY_VERSION_CONFLICT");
    // The cap counts ACTIVE keys of this kind in the bot scope, in this transaction.
    if(ownerRow&&!previous&&Number(db.prepare("SELECT count(*) AS n FROM memory_records WHERE scope_id=? AND kind=? AND state='active'").get(scopeId,input.kind)!.n)>=PIP_ACTIVE_CAP)throw new Error("MEMORY_IDENTITY_PIP_CAP");
    if(input.canon){
      const canon=db.prepare("SELECT * FROM memory_records WHERE id=? AND version=? AND scope_id=? AND kind='character-canon' AND state='active'").get(input.canon.id,input.canon.version,scopeId);
      if(!canon||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(input.canon.id,input.canon.version))throw new Error("MEMORY_IDENTITY_CANON_UNAVAILABLE");
      if(input.basis!=="fiction")throw new Error("MEMORY_IDENTITY_FICTION_REQUIRED");
    }
    const version=input.expectedVersion+1,now=Date.now();
    // Lived rows (design 1.2, I-5): an owner edit of an observed row with different bytes becomes owner-attested,
    // takes the next generation and re-parses its claim under I-3b; identical bytes change nothing.
    let lived:{generation:number}|undefined;
    if(ownerRow&&previous){
      const prior=db.prepare("SELECT entities,confidence_basis FROM memory_record_details WHERE record_id=? AND record_version=?").get(id,Number(previous.version));
      if(pipTierOf(prior?.confidence_basis)==="observed"||String(prior?.entities).includes('"gen:')){
        if(previous.text===input.text)return {id,version:Number(previous.version),scopeId,kind:input.kind,text:String(previous.text),basis:input.basis,audience:input.audience};
        let generation=1;try{generation=Number(String(JSON.parse(String(prior!.entities)).find((e:unknown)=>typeof e==="string"&&e.startsWith("gen:"))??"gen:1").slice(4))||1;}catch{}
        lived={generation};
      }
    }
    const text=redactSecretsInText(input.kind==="reveal-state"?JSON.stringify({canonId:input.canon!.id,audience:input.audience,revealed:input.revealed,note:input.text}):input.text);
    if(previous)db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(now,id,input.expectedVersion);
    db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement','active',?,?,NULL,?,?)").run(id,version,scopeId,input.kind,text,previous?.owner_pinned??0,now,previous?id:null,now);
    db.prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis=?,entities=? WHERE record_id=? AND record_version=?")
      .run(ownerRow?PIP_BASIS:input.basis==="fiction"?"Owner-authored fictional continuity; not model autobiography or world truth":"Owner-authored continuity; not independently verified",JSON.stringify(lived?[input.audience,identityKey,claimEntity(parseAuthoredStatement(text)),`gen:${lived.generation+1}`,`reinforcedAt:${now}`]:ownerRow?[input.audience,identityKey,claimEntity(parseAuthoredStatement(text)),"gen:1"]:[input.audience,identityKey]),id,version);
    if(lived){
      // A generation change retires the old counter (its occasions counted against words that no longer stand).
      const counter=pipCounterId(id,lived.generation);
      if(db.prepare("SELECT 1 FROM memory_records WHERE id=?").get(counter)&&!db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(counter)){
        db.prepare("INSERT INTO memory_tombstones VALUES(?,'record',?,NULL,NULL,?,'pip-generation-change',?)").run(randomUUID(),counter,Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch),now);
        applyRecordTombstone(db,counter);
      }
    }
    if(input.canon)db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(input.canon.id,input.canon.version,id,version);
    // Continuity rows are never projected into the shared recall index (PIP):
    // no lexical or embedding receipt, so the FTS corpus the other rows rank
    // against is the same with or without them. Owner browsing reads the
    // authoritative records. Every other identity kind keeps its receipt.
    if(!pip)db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(id,version);
    // An identity write changes one record of one bot, never who may read
    // what: no policy bump, and only receipts that carried this record (or a
    // record derived from it, such as a reveal resting on this canon) end.
    // Continuity rows touch only this bot (PIP A2) and leave data_revision
    // alone too: they are not in the recall index whose caches it keys.
    if(!pip)db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    if(input.kind==="character-canon"){
      // Canon is rendered outside the identity slot and can live on in replayed
      // replies that no receipt cites, so a targeted revoke could miss a resumed
      // session still holding the old canon. Canon keeps the global bump
      // (integration owner's condition, 2026-10-06 review).
      db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1");
      revokeAllDisclosures(db,"identity-write-canon");
    }else revokeRecordDisclosures(db,pip?"identity-write-pip":"identity-write",{recordIds:[id]});
    if(pip)invalidatePipRender(db,input.botId);
    return {id,version,scopeId,kind:input.kind,text,basis:input.basis,audience:input.audience};
  });
}

/** Owner-only, paginated full canon and reveal inspection. Deleted content never
 * appears here; general memory forget owns erasure and derived-record cleanup. */
export function readBotIdentity(ticket:object,botId:string,roster:MemoryRoster,cursor="") {
  const scope=privateScope(ticket,botId,roster);
  const rows=database().prepare(`SELECT r.id,r.version,r.kind,r.text,d.confidence_basis AS basis,d.entities
    FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    WHERE r.scope_id=? AND d.partition='identity' AND r.state='active' AND r.id>?
    AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))
    ORDER BY r.id LIMIT 51`).all(scope,cursor);
  return {records:rows.slice(0,50),...(rows.length>50?{nextCursor:String(rows[49].id)}:{})};
}

/** Owner delete of one continuity row (PIP A3): one record tombstone for the
 * whole id, applied now, so every version (superseded ones included) is
 * 'deleted'. Owner-authored rows have no sources, so no source tombstones. The
 * slug stays retired (writeBotIdentity refuses a tombstoned id). The caller
 * names the version it saw (`expectedVersion`), compared inside the deletion
 * transaction: a stale view gets MEMORY_VERSION_CONFLICT and deletes nothing.
 * No installation-wide bump and no installation-wide tombstone sweep: only the
 * affected record is marked, and only disclosures that carried it are revoked
 * (applyRecordTombstone), so another bot's finished deletion receipts and
 * pending work stay as they were. */
export function deleteBotIdentity(ticket:object,input:z.infer<typeof identityDeleteSchema>,roster:MemoryRoster) {
  requireMemoryOwner(ticket);
  input=identityDeleteSchema.parse(input);
  const scopeId=privateScope(ticket,input.botId,roster);
  const id=currentIdentityId(database(),input.botId,input.kind,input.key);
  fenceIdentityId(input.kind,id,input.expectedId,true);
  return deletePipRecord(id,scopeId,input.expectedVersion);
}
/** The one delete for every PIP kind (I-11): a version-fenced record tombstone, applied now. */
export function deletePipRecord(id:string,scopeId:string,expectedVersion:number) {
  return transaction(db=>{
    const current=db.prepare("SELECT version,kind FROM memory_records WHERE id=? AND scope_id=? AND state='active'").get(id,scopeId);
    if(!current||!isPipKind(current.kind))throw new Error("MEMORY_NOT_FOUND");
    if(Number(current.version)!==expectedVersion)throw new Error("MEMORY_VERSION_CONFLICT");
    const epoch=Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
    db.prepare("INSERT INTO memory_tombstones VALUES(?,'record',?,NULL,NULL,?,'owner-continuity-delete',?)").run(randomUUID(),id,epoch,Date.now());
    applyRecordTombstone(db,id);
    const owner=db.prepare("SELECT owner_key FROM memory_scopes WHERE id=? AND kind='bot'").get(scopeId);
    if(owner)invalidatePipRender(db,String(owner.owner_key));
    return {id,deleted:true as const};
  });
}
/** The generic "forget" control refuses a continuity row (PIP A8): deletion goes
 * through the dedicated, version-fenced Delete in Continuity, so a caller that
 * saw version N can never delete version N+1 unseen. A non-continuity target
 * returns normally and keeps the installation-wide forget path. */
export function rejectGenericForgetOfPip(ticket:object,target:{kind:string;id:string}) {
  requireMemoryOwner(ticket);
  if(target.kind!=="record")return;
  const row=database().prepare("SELECT kind FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(target.id);
  if(row&&isPipKind(row.kind))throw new Error("MEMORY_IDENTITY_PIP_USE_CONTINUITY");
}

/** Owner-only: this bot's continuity rows (brief included) with their keys and
 * edit times, and how much of it the last conversation carried. */
export function readContinuity(ticket:object,botId:string,roster:MemoryRoster) {
  const scope=privateScope(ticket,botId,roster);
  const rows=database().prepare(`SELECT r.id,r.version,r.kind,r.text,r.created_at AS editedAt,d.entities,d.confidence_basis AS basis,d.claim_status AS claimStatus
    FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    WHERE r.scope_id=? AND d.partition='identity' AND r.state='active' AND r.kind IN ('continuity-brief','relation','commitment','self-trait')
    ORDER BY r.kind,r.created_at DESC,r.id`).all(scope);
  return {
    records:rows.map(row=>{let key="";try{key=String(JSON.parse(String(row.entities))[1]??"");}catch{}
      // Lived rows carry the owner's confirmation (tier), their generation and whether counter evidence is disputing them.
      const observed=pipTierOf(row.basis)==="observed";let generation=0;
      if(observed)try{generation=Number(String(JSON.parse(String(row.entities)).find((e:unknown)=>typeof e==="string"&&e.startsWith("gen:"))??"gen:1").slice(4))||1;}catch{}
      return {id:String(row.id),version:Number(row.version),kind:String(row.kind),key,text:String(row.text),editedAt:Number(row.editedAt),...observed?{tier:"observed" as const,generation,disputed:row.claimStatus==="disputed"}:{}};}),
    limits:{perKind:PIP_ACTIVE_CAP,bytes:4096,briefBytes:768},
    coverage:readContinuityCoverage(botId),
  };
}

/** The render cache row (bundle.ts, `pip-render:<botId>`); every PIP writer drops it (design §2.1). */
export function invalidatePipRender(db:Db,botId:string) {
  db.prepare("DELETE FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='pip-render'").run(pipRenderId(botId));
}

const coverageId=(botId:string)=>"pip-coverage:"+botId;
/** How many continuity rows the last DELIVERED direct conversation carried.
 * Owner-only; kept beside the memory data (never in the model text) so it
 * survives a restart. Written when the disclosure becomes delivered, tied to
 * that turn's bundle, and always stamped. */
export function recordContinuityCoverage(botId:string,coverage:{brought:number;total:number}|undefined,turn?:string) {
  if(!coverage)return;
  const scopeId=ensureScope("bot",botId);
  database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','pip-coverage',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(coverageId(botId),scopeId,JSON.stringify({brought:coverage.brought,total:coverage.total,at:Date.now(),...turn?{turn}:{}}));
}
/** A turn that did not carry continuity (switch off, memory not active, or not a
 * direct owner turn) makes the last count not current: it is cleared, so the
 * owner is never shown the success of an earlier conversation. */
export function clearContinuityCoverage(botId:string) {
  database().prepare("DELETE FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='pip-coverage'").run(coverageId(botId));
}
/** Wire a dispatch receipt to the owner's count for one turn: a turn that carried
 * continuity records its count only once the disclosure is delivered (a rejected
 * dispatch never reaches it); any other turn makes the last count not current. */
export function attachContinuityCoverage(receipt:{addOnDelivered:(listener:(bundle:MemoryBundle)=>void)=>void},botId:string,coverage:{brought:number;total:number}|undefined) {
  if(!coverage){clearContinuityCoverage(botId);return;}
  const counted={brought:coverage.brought,total:coverage.total};
  receipt.addOnDelivered(bundle=>recordContinuityCoverage(botId,counted,bundle.bundleId));
}
export function readContinuityCoverage(botId:string):{brought:number;total:number;at:number;turn?:string}|null {
  const row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='pip-coverage'").get(coverageId(botId));
  if(!row)return null;
  try{const value=JSON.parse(String(row.intent));return Number.isSafeInteger(value.brought)&&Number.isSafeInteger(value.total)?{brought:value.brought,total:value.total,at:Number(value.at)||0,...typeof value.turn==="string"?{turn:value.turn}:{}}:null;}catch{return null;}
}
