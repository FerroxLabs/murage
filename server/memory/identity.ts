import { createHash } from "node:crypto";
import { z } from "zod";
import { database, transaction } from "../database.ts";
import { redactSecretsInText } from "../redact.ts";
import { requireMemoryOwner } from "./authority.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
export const identityWriteSchema = z.object({
  action:z.literal("identity-write"),botId:z.string().min(1).max(180),
  kind:z.enum(["continuity-brief","character-canon","reveal-state"]),key,
  expectedVersion:z.number().int().nonnegative(),text:z.string().min(1).max(4096),
  basis:z.enum(["owner-fact","fiction"]),
  audience:z.literal("owner-private"),
  canon:z.object({id:z.string().min(1).max(180),version:z.number().int().positive()}).strict().optional(),
  revealed:z.boolean().optional(),
}).strict();
export const identityReadSchema = z.object({action:z.literal("identity-read"),botId:z.string().min(1).max(180),cursor:z.string().max(180).optional()}).strict();
export type IdentityWrite = z.infer<typeof identityWriteSchema>;

export function botIdentityRecordId(botId:string,kind:IdentityWrite["kind"],identityKey:string) {
  return "identity:"+createHash("sha256").update(JSON.stringify([botId,kind,identityKey,"owner-private"])).digest("hex");
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
  if(input.kind==="continuity-brief"&&input.key!=="core")throw new Error("MEMORY_IDENTITY_CORE_KEY_REQUIRED");
  if(input.kind==="character-canon"&&input.basis!=="fiction")throw new Error("MEMORY_IDENTITY_FICTION_REQUIRED");
  if(input.kind==="reveal-state"?!input.canon||input.revealed===undefined:input.canon!==undefined||input.revealed!==undefined)throw new Error("MEMORY_IDENTITY_REVEAL_INVALID");
  const scopeId=privateScope(ticket,input.botId,roster);
  // Reveals are indexed by canonical fact and audience, not a caller-selected
  // event key: repeated reports update one durable state across tasks/models.
  const identityKey=input.kind==="reveal-state"?input.canon!.id:input.key;
  const id=botIdentityRecordId(input.botId,input.kind,identityKey);
  return transaction(db=>{
    const previous=db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
    if(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(id)||previous?.state==="deleted")throw new Error("MEMORY_RECORD_UNAVAILABLE");
    if(Number(previous?.version??0)!==input.expectedVersion || previous&&previous.state!=="active")throw new Error("MEMORY_VERSION_CONFLICT");
    if(input.canon){
      const canon=db.prepare("SELECT * FROM memory_records WHERE id=? AND version=? AND scope_id=? AND kind='character-canon' AND state='active'").get(input.canon.id,input.canon.version,scopeId);
      if(!canon||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(input.canon.id,input.canon.version))throw new Error("MEMORY_IDENTITY_CANON_UNAVAILABLE");
      if(input.basis!=="fiction")throw new Error("MEMORY_IDENTITY_FICTION_REQUIRED");
    }
    const version=input.expectedVersion+1,now=Date.now();
    const text=redactSecretsInText(input.kind==="reveal-state"?JSON.stringify({canonId:input.canon!.id,audience:input.audience,revealed:input.revealed,note:input.text}):input.text);
    if(previous)db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(now,id,input.expectedVersion);
    db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement','active',?,?,NULL,?,?)").run(id,version,scopeId,input.kind,text,previous?.owner_pinned??0,now,previous?id:null,now);
    db.prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis=?,entities=? WHERE record_id=? AND record_version=?")
      .run(input.basis==="fiction"?"Owner-authored fictional continuity; not model autobiography or world truth":"Owner-authored continuity; not independently verified",JSON.stringify([input.audience,identityKey]),id,version);
    if(input.canon)db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(input.canon.id,input.canon.version,id,version);
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(id,version);
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1,data_revision=data_revision+1; UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked';");
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
