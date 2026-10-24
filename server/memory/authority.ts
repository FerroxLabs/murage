import { isProjectCloseLesson } from "../project-close.ts";
import { roomRequest } from "../room-requests.ts";
import { executionStore, partitionOfScope } from "../execution-audience.ts";
import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { database, transaction } from "../database.ts";
import { redactSecretsInText } from "../redact.ts";
import type { MemoryEvidenceHandle } from "../../shared/memory.ts";
import { groundMemoryClaim, type TextOnlyExtractor } from "./extract.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { activateGroundedMemory, holdMemoryCandidate, ownerLearningRefusal, invitedCanonRefusal, type MemoryClaimType } from "./automatic-learning.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import { enqueueProcedureCorrectionReview } from "./procedure-review.ts";
import { isPipKind } from "./pip-kinds.ts";
import { assertOwnerPinsFit, ownerPinUse } from "./bundle.ts";
import { revokeAllDisclosures, revokeRecordDisclosures } from "./revocation.ts";
import { inheritEdge, inheritEdges } from "./revoke-commit.ts";
import { WORKSPACE_OWNER } from "../human-principals.ts";
import { ensureScope } from "./policy.ts";
import { memoryState } from "./repository.ts";
import { ownerNoteId, type LamDatePrecision } from "../../shared/learn-about-me/origin.ts";
import type { LamProvider } from "../../shared/learn-about-me/parse.ts";
import { insertMemoryRecord } from "./record-write.ts";

const ownerTickets = new WeakSet<object>();
/** Mint only after the HTTP desktop-authority check; not exposed as an agent tool. */
export function ownerMemoryTicket() { const ticket = Object.freeze({}); ownerTickets.add(ticket); return ticket; }
export function requireMemoryOwner(ticket: object) { if (!ownerTickets.has(ticket)) throw new Error("MEMORY_OWNER_REQUIRED"); }

/** Identity writes have their own bounded imprint/reveal contract. Generic
 * corrections and audience promotion must not silently change that contract. */
export function assertGenericMemoryTarget(db:DatabaseSync,id:string,version:number){
  // I-10: a PIP kind is refused by kind as well as by partition, so no path that
  // forgets to set the partition can reach one through approve, correct, forget or promote.
  const kind=db.prepare("SELECT kind FROM memory_records WHERE id=? AND version=?").get(id,version);
  if(kind&&isPipKind(kind.kind))throw new Error("MEMORY_IDENTITY_WRITE_REQUIRED");
  if(db.prepare("SELECT 1 FROM memory_record_details WHERE record_id=? AND record_version=? AND partition='identity'").get(id,version))throw new Error("MEMORY_IDENTITY_WRITE_REQUIRED");
}


export function saveMemoryCandidate(text: string, evidence: MemoryEvidenceHandle[], key: string, access: MemoryAccess, claimType?: MemoryClaimType) {
  return saveCandidate(text,evidence,key,access,claimType);
}

/** This authority is available only to a live, server-issued close lesson. */
export function saveProjectCloseLesson(text: string, evidence: MemoryEvidenceHandle[], key: string, access: MemoryAccess, requestId: string) {
  // The same capture fence every other save runs first (lane D).
  assertMemoryCaptureComplete(evidence,access);
  const db = database();
  const request = roomRequest(db,requestId);
  if (!request || request.state !== 'running' || request.toBotId !== access.botId || (request.targetThreadId ?? request.rootThreadId) !== access.threadId || !isProjectCloseLesson(db,request)) throw new Error('MEMORY_CLOSE_LESSON_REQUIRED');
  const scope = db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(access.botId);
  if (!scope) throw new Error('MEMORY_SCOPE_DENIED');
  assertMemoryAccess(access,String(scope.id));
  // Project room evidence may be carried into this member's own candidate,
  // but unrelated private or other-project evidence cannot be relabelled.
  for (const handle of evidence) {
    const source = db.prepare("SELECT s.kind,s.owner_key FROM memory_sources e JOIN memory_scopes s ON s.id=e.scope_id WHERE e.id=?").get(handle.sourceId);
    if (source?.kind !== 'room' || source.owner_key !== request.groupId) throw new Error('MEMORY_PROJECT_EVIDENCE_REQUIRED');
  }
  const lessonKey = createHash('sha256').update(JSON.stringify([request.id,access.botId,key])).digest('hex');
  return saveCandidate(text,evidence,lessonKey,access,undefined,String(scope.id));
}
function saveCandidate(text: string, evidence: MemoryEvidenceHandle[], key: string, access: MemoryAccess, claimType?: MemoryClaimType, candidateScope?: string) {
  assertMemoryAccess(access);
  if (!text.trim() || text.length > 4096 || !evidence.length || evidence.length > 20 || !/^[\w-]{1,160}$/.test(key)) throw new Error("INVALID_MEMORY_CANDIDATE");
  return transaction(db => {
    const scopes = new Set<string>();
    for (const handle of evidence) {
      const source = db.prepare("SELECT s.scope_id,s.state,s.revision,s.kind,s.outcome,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?").get(handle.revision,handle.sourceId);
      if (!source || source.state !== "active" || source.revision !== handle.revision || (["tool-outcome", "activity"].includes(String(source.kind)) && source.outcome === "failed")) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
      assertMemoryAccess(access,String(source.scope_id)); scopes.add(String(source.scope_id));
      const payload = JSON.parse(String(source.payload));
      if (!Number.isSafeInteger(handle.startByte) || !Number.isSafeInteger(handle.endByte) || handle.startByte < 0 || handle.endByte <= handle.startByte || handle.endByte > Buffer.byteLength(payload.text ?? "")) throw new Error("INVALID_MEMORY_SPAN");
      if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(handle.sourceId,handle.revision)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
    }
    // Cross-scope synthesis must not implicitly expand its audience.
    if (scopes.size !== 1) throw new Error("MEMORY_PROMOTION_REQUIRED");
    const id = createHash("sha256").update(JSON.stringify([access.threadId,key])).digest("hex"), scope = candidateScope ?? [...scopes][0];
    if (partitionOfScope(scope)?.partition.kind === "general") throw new Error(`Only you can change what ${executionStore()?.bot(access.botId)?.name ?? "this bot"} knows for every team.`);
    const existing = db.prepare("SELECT text,state,scope_id FROM memory_records WHERE id=? AND version=1").get(id);
    const safeText = redactSecretsInText(text);
    if (existing) {
      const saved=db.prepare("SELECT source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=1").all(id);
      const canonical=(rows:unknown[][])=>JSON.stringify(rows.map(row=>JSON.stringify(row)).sort());
      if(existing.text!==safeText || !["candidate","active"].includes(String(existing.state)) || existing.scope_id!==scope ||
        canonical(saved.map(h=>[h.source_id,h.source_revision,h.start_byte,h.end_byte]))!==canonical(evidence.map(h=>[h.sourceId,h.revision,h.startByte,h.endByte])))throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
      return id;
    }
    insertMemoryRecord(db,{id,version:1,scopeId:String(scope),kind:"fact",text:safeText,assertion:"assistant-inference",state:"candidate",validFrom:Date.now(),createdAt:Date.now()});
    for (const h of evidence) { db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,?,?)").run(id,h.sourceId,h.revision,h.startByte,h.endByte); inheritEdge(db,{kind:"record",id,version:1},{kind:"source",id:h.sourceId}); }
    if (!candidateScope) activateGroundedMemory(db,id,claimType);
    return id;
  });
}

/** Only jobs which can still complete warrant a retry. */
export function assertMemoryCaptureComplete(evidence:ReadonlyArray<{sourceId:string;revision:number}>,access:MemoryAccess){
 const db=database();
 for(const h of evidence){
  const source=db.prepare("SELECT scope_id FROM memory_sources WHERE id=? AND revision=? AND state='active'").get(h.sourceId,h.revision);
  if(!source)continue;
  assertMemoryAccess(access,String(source.scope_id));
  const jobs=db.prepare("SELECT status FROM memory_jobs WHERE source_id=? AND source_revision=? AND stage='capture'").all(h.sourceId,h.revision);
  if(jobs.some(j=>j.status==="complete"))continue;
  if(jobs.some(j=>["pending","leased","partial","deferred"].includes(String(j.status))))throw Object.assign(new Error("Source capture is still pending. Try saving this memory again after capture finishes."),{status:409});
  throw Object.assign(new Error("This source cannot be used because its capture did not complete."),{status:400});
 }
}

/** Ground through the configured isolated text-only evaluator. The durable
 * candidate exists before optional synthesis; a changed audience/source/config
 * fences activation, while unavailable synthesis remains honestly provisional. */
export async function saveGroundedMemory(text:string,evidence:MemoryEvidenceHandle[],key:string,access:MemoryAccess,claimType:MemoryClaimType|undefined,extractor:TextOnlyExtractor|null,ownerInvitation?:MemoryEvidenceHandle,options:{budgetGate?:(scopeId:string)=>boolean}={}){
  if(ownerInvitation&&claimType!=="character-canon")throw Object.assign(new Error("Owner invitations can only support character canon."),{status:400});
  assertMemoryAccess(access);
  const cited=ownerInvitation?[...evidence,ownerInvitation]:evidence;
  assertMemoryCaptureComplete(cited,access);
  const id=saveMemoryCandidate(text,cited,key,access);
  if(!claimType||database().prepare("SELECT state FROM memory_records WHERE id=? AND version=1").get(id)?.state==="active")return id;
  const db=database(),learningRevision=readMemoryLearning(db).revision;
  if(db.prepare("SELECT supersedes_id FROM memory_records WHERE id=? AND version=1").get(id)?.supersedes_id){transaction(()=>holdMemoryCandidate(db,id,"correction-review"));return id;}
  {
    const reason=ownerInvitation?invitedCanonRefusal(db,evidence,ownerInvitation,access.botId):ownerLearningRefusal(db,cited);
    if(reason){transaction(()=>holdMemoryCandidate(db,id,reason));return id;}
  }
  if(evidence.length!==1)return id;
  const h=evidence[0],source=db.prepare("SELECT s.*,v.payload FROM memory_sources s JOIN memory_source_versions v ON s.id=v.source_id AND s.revision=v.revision WHERE s.id=?").get(h.sourceId)!;
  const quote=Buffer.from(JSON.parse(String(source.payload)).text).subarray(h.startByte,h.endByte).toString("utf8");
  let invitation:string|undefined;
  if(ownerInvitation){
    const invited=db.prepare("SELECT s.*,v.payload FROM memory_sources s JOIN memory_source_versions v ON s.id=v.source_id AND s.revision=v.revision WHERE s.id=? AND s.revision=? AND s.state='active' AND s.speaker='owner'").get(ownerInvitation.sourceId,ownerInvitation.revision);
    if(!invited||invited.scope_id!==source.scope_id)throw new Error("MEMORY_INVITATION_UNAVAILABLE");
    assertMemoryAccess(access,String(invited.scope_id));
    const bytes=Buffer.from(JSON.parse(String(invited.payload)).text);
    if(ownerInvitation.startByte<0||ownerInvitation.endByte>bytes.length||ownerInvitation.endByte<=ownerInvitation.startByte)throw new Error("INVALID_MEMORY_SPAN");
    invitation=bytes.subarray(ownerInvitation.startByte,ownerInvitation.endByte).toString("utf8");
  }
  const needsGrounding=text!==quote||claimType==="character-canon"&&(source.speaker!=="owner"||Boolean(invitation));
  if(needsGrounding&&options.budgetGate&&!options.budgetGate(String(source.scope_id))){transaction(()=>holdMemoryCandidate(db,id,"project-budget-reached"));return id;}
  const support=needsGrounding?await groundMemoryClaim({text,quote,claimType,speaker:String(source.speaker),outcome:String(source.outcome),ownerInvitation:invitation},extractor,new AbortController().signal):undefined;
  return transaction(()=>{
    assertMemoryAccess(access,String(source.scope_id));assertEvidenceCurrent(db,id,1);
    if(readMemoryLearning(db).revision!==learningRevision)throw new Error("MEMORY_CONSOLIDATION_REVOKED");
    if(ownerInvitation){
      const current=db.prepare("SELECT 1 FROM memory_sources WHERE id=? AND revision=? AND state='active' AND speaker='owner'").get(ownerInvitation.sourceId,ownerInvitation.revision);
      if(!current||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(ownerInvitation.sourceId,ownerInvitation.revision))throw new Error("MEMORY_INVITATION_UNAVAILABLE");
    }
    const activated=activateGroundedMemory(db,id,claimType,support?{...support,ownerInvitation:invitation,ownerInvitationSourceId:ownerInvitation?.sourceId}:undefined,{botId:access.botId,connection:extractor?.learningConnection,reviewOnly:needsGrounding&&extractor?.reviewOnly});
    if(activated&&ownerInvitation){db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,1,?,?,?,?)").run(id,ownerInvitation.sourceId,ownerInvitation.revision,ownerInvitation.startByte,ownerInvitation.endByte);inheritEdge(db,{kind:"record",id,version:1},{kind:"source",id:ownerInvitation.sourceId});}
    if(!activated&&support&&!db.prepare("SELECT 1 FROM memory_record_details WHERE record_id=? AND confidence_basis IS NOT NULL").get(id))db.prepare("UPDATE memory_record_details SET confidence_basis=? WHERE record_id=? AND record_version=1 AND claim_status='provisional'").run(support.reason,id);
    return id;
  });
}

/** What the owner decides about an owner pin on the fact a correction replaces. */
export type CorrectionPinChoice = "transfer" | "unpin";
/** `changed`: the target was corrected or replaced after the proposal.
 * `unavailable`: forgotten, archived, missing or an ambiguous derivation. */
export type CorrectionTargetStatus = "current" | "changed" | "unavailable";
export interface CorrectionTargetReview {
  status: CorrectionTargetStatus;
  target: { id: string; version: number; text: string; state: string; ownerPinned: boolean; scopeId: string } | null;
}

/** The exact target version an agent-proposed correction was made against
 * (`supersedes_id` plus its single recorded derivation), or null when the
 * candidate is not a correction proposal. Approval never guesses a target. */
export function readCorrectionTarget(db: DatabaseSync, id: string, version: number): CorrectionTargetReview | null {
  const candidate = db.prepare("SELECT supersedes_id FROM memory_records WHERE id=? AND version=?").get(id,version);
  if (!candidate || typeof candidate.supersedes_id !== "string" || !candidate.supersedes_id) return null;
  const targetId = candidate.supersedes_id;
  const links = db.prepare("SELECT parent_version FROM memory_derivations WHERE child_id=? AND child_version=? AND parent_id=?").all(id,version,targetId);
  if (links.length !== 1) return {status:"unavailable",target:null};
  const row = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(targetId,Number(links[0].parent_version));
  if (!row) return {status:"unavailable",target:null};
  const target = {id:targetId,version:Number(row.version),text:String(row.text),state:String(row.state),ownerPinned:row.owner_pinned===1,scopeId:String(row.scope_id)};
  const latest = Number(db.prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(targetId)?.version);
  const tombstoned = db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(targetId,target.version);
  if (tombstoned || target.state === "deleted" || target.state === "archived" || target.state === "candidate") return {status:"unavailable",target};
  if (latest !== target.version || target.state !== "active") return {status:"changed",target};
  return {status:"current",target};
}

/** Evidence must still be exactly what the owner reviewed: active sources at
 * the recorded revision, not tombstoned, spans inside the stored text. */
function assertEvidenceCurrent(db: DatabaseSync, id: string, version: number) {
  const handles = db.prepare("SELECT source_id,source_revision,end_byte FROM memory_evidence WHERE record_id=? AND record_version=?").all(id,version);
  if (!handles.length) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
  for (const handle of handles) {
    const source = db.prepare("SELECT s.state,s.revision,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?").get(handle.source_revision,handle.source_id);
    if (!source || source.state !== "active" || source.revision !== handle.source_revision) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
    if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(handle.source_id,handle.source_revision)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
    const text = JSON.parse(String(source.payload)).text;
    if (typeof text !== "string" || Number(handle.end_byte) > Buffer.byteLength(text)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
  }
}

/** Owner approval of an agent-proposed correction (audit C1, decision U-16):
 * validate the exact recorded target version, revalidate the candidate's
 * evidence, then supersede only that target and activate the replacement in
 * one transaction. A pinned target needs an explicit transfer/unpin choice. */
export function approveCorrection(db: DatabaseSync, record: Record<string, unknown>, review: CorrectionTargetReview, options: {pin?: boolean; scopeId?: string; correctionPin?: CorrectionPinChoice}) {
  // A correction replaces one reviewed fact in its own audience. Promotion and
  // an implicit pin flag are separate owner decisions, never folded in here.
  if (options.pin !== undefined || (options.scopeId !== undefined && options.scopeId !== record.scope_id)) throw new Error("MEMORY_CORRECTION_OPTIONS_INVALID");
  if (options.correctionPin !== undefined && options.correctionPin !== "transfer" && options.correctionPin !== "unpin") throw new Error("MEMORY_CORRECTION_OPTIONS_INVALID");
  if (!review.target || review.status === "unavailable") throw new Error("MEMORY_CORRECTION_TARGET_UNAVAILABLE");
  if (review.status === "changed") throw new Error("MEMORY_CORRECTION_TARGET_CHANGED");
  const target = review.target;
  assertGenericMemoryTarget(db,target.id,target.version);
  if (target.scopeId !== record.scope_id) throw new Error("MEMORY_CORRECTION_SCOPE_MISMATCH");
  assertEvidenceCurrent(db,String(record.id),Number(record.version));
  if (target.ownerPinned && options.correctionPin === undefined) throw new Error("MEMORY_CORRECTION_PIN_CHOICE_REQUIRED");
  // The owner chose for a pin that is no longer there: the review is stale.
  if (!target.ownerPinned && options.correctionPin !== undefined) throw new Error("MEMORY_CORRECTION_PIN_CHANGED");
  const pinUse = target.ownerPinned && options.correctionPin === "transfer" ? ownerPinUse(db,String(record.scope_id)).used : undefined;
  const retired = db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=? AND state='active'").run(Date.now(),target.id,target.version);
  if (retired.changes !== 1) throw new Error("MEMORY_CORRECTION_TARGET_CHANGED");
  const activated = db.prepare("UPDATE memory_records SET state='active',owner_pinned=? WHERE id=? AND version=? AND state='candidate'")
    .run(target.ownerPinned && options.correctionPin === "transfer" ? 1 : 0,String(record.id),Number(record.version));
  if (activated.changes !== 1) throw new Error("MEMORY_VERSION_CONFLICT");
  // The pin moves to the new words: they must fit with the scope's other pins (1.0.4).
  if (pinUse !== undefined) assertOwnerPinsFit(db,String(record.scope_id),pinUse);
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  revokeRecordDisclosures(db,"approve-correction",{recordIds:[target.id,String(record.id)]});
  enqueueProcedureCorrectionReview(db,String(record.id),Number(record.version),{ownerAuthorized:true});
  return String(record.id);
}

export function approveMemory(ticket: object, id: string, version: number, options: {pin?: boolean; scopeId?: string; correctionPin?: CorrectionPinChoice} = {}) {
  requireMemoryOwner(ticket);
  return transaction(db => {
    const record = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=? AND state='candidate'").get(id,version);
    if (!record) throw new Error("MEMORY_VERSION_CONFLICT");
    const correction = readCorrectionTarget(db,id,version);
    if (correction) return approveCorrection(db,record,correction,options);
    if (options.correctionPin !== undefined) throw new Error("MEMORY_CORRECTION_PIN_CHOICE_INVALID");
    // A candidate was never in a bundle; approving it ends only receipts that
    // somehow cite it (none, in practice). No policy change: who may read
    // what is unchanged.
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    revokeRecordDisclosures(db,"approve",{recordIds:[id],viaSources:false});
    if (options.scopeId && options.scopeId !== record.scope_id) {
      assertGenericMemoryTarget(db,id,version);
      if (!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(options.scopeId)) throw new Error("MEMORY_SCOPE_UNKNOWN");
      const copy = randomUUID();
      insertMemoryRecord(db,{id:copy,version:1,scopeId:String(options.scopeId),kind:String(record.kind),text:String(record.text),assertion:"owner-statement",state:"active",ownerPinned:options.pin?1:0,validFrom:Date.now(),createdAt:Date.now()});
      db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(id,version,copy);
      inheritEdge(db,{kind:"record",id:copy,version:1},{kind:"record",id,version});
      if (options.pin) assertOwnerPinsFit(db,options.scopeId);
      return copy;
    }
    db.prepare("UPDATE memory_records SET state='active',owner_pinned=? WHERE id=? AND version=?").run(options.pin?1:0,id,version);
    if (options.pin) assertOwnerPinsFit(db,String(record.scope_id));
    return id;
  });
}

export function correctMemory(ticket: object, id: string, version: number, text: string, options: {correctionPin?: CorrectionPinChoice} = {}) {
  requireMemoryOwner(ticket);
  if (!text.trim() || text.length > 4096) throw new Error("INVALID_MEMORY_TEXT");
  return transaction(db => {
    const row = db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
    if (!row || row.version !== version || row.state === "deleted") throw new Error("MEMORY_VERSION_CONFLICT");
    if(row.state==="archived")throw new Error("Restore this memory before editing it.");
    if(row.state==="superseded")throw new Error("This was replaced; edit the current version.");
    assertGenericMemoryTarget(db,id,version);
    const correction=row.state==="candidate"?readCorrectionTarget(db,id,version):null;
    if(correction){
      if(correction.status!=="current")throw new Error("The memory this corrects has changed. Forget this proposal or approve a fresh one.");
      const next=version+1;
      insertMemoryRecord(db,{id,version:next,scopeId:String(row.scope_id),kind:String(row.kind),text,assertion:"owner-statement",state:"candidate",validFrom:Date.now(),supersedesId:row.supersedes_id==null?null:String(row.supersedes_id),createdAt:Date.now()});
      db.prepare("INSERT INTO memory_evidence SELECT record_id,?,source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=?").run(next,id,version);
      db.prepare("INSERT INTO memory_derivations SELECT parent_id,parent_version,child_id,? FROM memory_derivations WHERE child_id=? AND child_version=?").run(next,id,version);
      inheritEdges(db,{id,version:next});
      const edited=db.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(id,next)!;
      approveCorrection(db,edited,correction,options);
      db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(Date.now(),id,version);
      db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(id,version,id,next);
      inheritEdge(db,{kind:"record",id,version:next},{kind:"record",id,version});
      return next;
    }else if(options.correctionPin!==undefined)throw new Error("MEMORY_CORRECTION_PIN_CHOICE_INVALID");
    const pinUse=row.owner_pinned===1?ownerPinUse(db,String(row.scope_id)).used:undefined;
    db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(Date.now(),id,version);
    insertMemoryRecord(db,{id,version:version+1,scopeId:String(row.scope_id),kind:String(row.kind),text,assertion:"owner-statement",state:"active",ownerPinned:Number(row.owner_pinned),validFrom:Date.now(),supersedesId:id,createdAt:Date.now()});
    db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(id,version,id,version+1);
    inheritEdge(db,{kind:"record",id,version:version+1},{kind:"record",id,version});
    // The new version keeps the pin: its words must fit with the scope's other pins (1.0.4).
    if (pinUse !== undefined) assertOwnerPinsFit(db,String(row.scope_id),pinUse);
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    revokeRecordDisclosures(db,"correct",{recordIds:[id]});
    enqueueProcedureCorrectionReview(db,id,version+1,{ownerAuthorized:true});
    return version+1;
  });
}

export function pinMemory(ticket: object, id: string, version: number, pinned: boolean) {
  requireMemoryOwner(ticket);
  transaction(db => {
    // Owner-authored continuity is delivered by its own slot, never pinned (PIP A8). Unpinning stays open: a brief
    // pinned before it became a PIP kind keeps a repair path, and the bundle delivers it in the brief slot meanwhile.
    const target = db.prepare("SELECT kind,scope_id FROM memory_records WHERE id=? AND version=?").get(id,version);
    if (pinned && target && isPipKind(target.kind)) throw new Error("MEMORY_IDENTITY_NOT_PINNABLE");
    const result = db.prepare("UPDATE memory_records SET owner_pinned=? WHERE id=? AND version=? AND state='active'").run(pinned?1:0,id,version);
    if (!result.changes) throw new Error("MEMORY_VERSION_CONFLICT");
    // 1.0.4: a pin is taken only when the scope's pins, this one included, fit the share every default engine gives them. Unpin is never checked.
    if (pinned) assertOwnerPinsFit(db,String(target!.scope_id));
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    revokeRecordDisclosures(db,"pin",{recordIds:[id],viaSources:false});
  });
}

/** The durable outcome of every `remember` action (memory_scope_bindings system rows): the record it wrote or the record it found
 * already holding the words, and a hash of what was asked. It is never removed by Forget, so a retried action id answers what the
 * first call did and never writes the line again (Learn about me, Astra r3 H1 and N2). */
const REMEMBER_LEDGER = "remember-action";
const REDACTION = /\u00abredacted \d+ chars\u00bb/g;
export const REMEMBER_TEXT_MAX = 1000;
export interface RememberInput { actionId: string; text: string; origin?: { provider: LamProvider; date?: string } }
export interface RememberOutcome { id: string; version: number; duplicate: boolean; fresh: boolean }
const rememberConflict = () => Object.assign(new Error("MEMORY_IDEMPOTENCY_CONFLICT"), { status: 409 });

/** The start of the given day, month or year in this machine's time zone (the owner's desktop); undated, malformed, before
 * 1970 or in the future: now. */
export function rememberedStart(date: string | undefined, now = Date.now()): { at: number; precision: LamDatePrecision } {
  const undated = { at: now, precision: "u" as const };
  const match = date ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date) : null;
  if (!match) return undated;
  const year = Number(match[1]), month = match[2] ? Number(match[2]) : undefined, day = match[3] ? Number(match[3]) : undefined;
  if (month !== undefined && (month < 1 || month > 12)) return undated;
  if (day !== undefined && (day < 1 || day > new Date(year, month!, 0).getDate())) return undated;
  const at = new Date(year, (month ?? 1) - 1, day ?? 1).getTime();
  if (year < 1970 || at > now) return undated;
  return { at, precision: day !== undefined ? "d" : month !== undefined ? "m" : "y" };
}

/** Learn about me (r3 C1): one kept line becomes one active owner memory in the owner's own preferences scope, the scope only an
 * owner-audience turn reads (policy.ts). No source, no evidence: an owner statement needs neither (eligibility.ts, readable.ts).
 * The words are the exact ones the owner kept, secrets redacted. The action id is the key, in its own namespace whichever
 * provider the line names: the same id with other words or another origin is refused, and its outcome row outlives Forget. */
export function rememberMemory(ticket: object, input: RememberInput): RememberOutcome {
  requireMemoryOwner(ticket);
  const text = input.text.trim();
  if (!text || text.length > REMEMBER_TEXT_MAX) throw Object.assign(new Error("INVALID_MEMORY_TEXT"), { status: 400 });
  const safeText = redactSecretsInText(text);
  if (!safeText.replace(REDACTION, "").replace(/[\s\p{P}\p{S}]/gu, "")) throw Object.assign(new Error("That line looked like a key or password, so it was not kept."), { status: 400, code: "MEMORY_TEXT_REDACTED" });
  const provider = input.origin?.provider ?? "typed";
  const start = rememberedStart(input.origin?.date);
  const key = createHash("sha256").update("murage-remember\u0000" + input.actionId).digest("hex");
  const ledgerId = `${REMEMBER_LEDGER}:${key.slice(0, 40)}`;
  const asked = createHash("sha256").update(JSON.stringify([text, provider, input.origin?.date ?? null])).digest("hex");
  return transaction(db => {
    const prior = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id=?").get(ledgerId, REMEMBER_LEDGER);
    if (prior) {
      const outcome = JSON.parse(String(prior.intent)) as { recordId: string; version: number; outcome: string; asked: string };
      if (outcome.asked !== asked) throw rememberConflict();
      return { id: outcome.recordId, version: outcome.version, duplicate: outcome.outcome === "duplicate", fresh: false };
    }
    if (memoryState().mode !== "active") throw Object.assign(new Error("Turn memory on to keep lines."), { status: 409, code: "MEMORY_NOT_ACTIVE" });
    const scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
    const id = ownerNoteId(provider, start.precision, key.slice(0, 32));
    if (db.prepare("SELECT 1 FROM memory_records WHERE id=? LIMIT 1").get(id)) throw rememberConflict();
    // the words are already an active memory of the owner's: say so and write no second copy
    const same = db.prepare("SELECT id,version FROM memory_records WHERE scope_id=? AND kind='fact' AND state='active' AND text=? LIMIT 1").get(scope, safeText);
    const outcome = same ? { recordId: String(same.id), version: Number(same.version), outcome: "duplicate" } : { recordId: id, version: 1, outcome: "inserted" };
    if (!same) {
      insertMemoryRecord(db, { id, version: 1, scopeId: String(scope), kind: "fact", text: safeText, assertion: "owner-statement", state: "active", validFrom: start.at, createdAt: Date.now() });
      db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
      revokeRecordDisclosures(db, "remember", { recordIds: [id] });
    }
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)").run(ledgerId, scope, REMEMBER_LEDGER, JSON.stringify({ ...outcome, asked, at: Date.now() }));
    return { id: outcome.recordId, version: outcome.version, duplicate: Boolean(same), fresh: !same };
  });
}

export function bindMemoryScope(ticket: object, scopeId: string, subjectType: "bot" | "room", subjectId: string) {
  requireMemoryOwner(ticket);
  transaction(db => {
    if (!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(scopeId)) throw new Error("MEMORY_SCOPE_UNKNOWN");
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,?,?,?,'granted','{}')").run(randomUUID(),scopeId,subjectType,subjectId,Number(database().prepare("SELECT policy_revision FROM memory_meta").get()?.policy_revision));
  });
}

/** Rename identity only as part of an owner-reviewed roster rename operation. */
export function renameMemoryTeam(ticket: object, oldName: string, newName: string) {
  requireMemoryOwner(ticket);
  const from = oldName.trim(), to = newName.trim();
  if (from === to) return;
  transaction(db => {
    if (db.prepare("SELECT 1 FROM memory_scopes WHERE kind='team' AND owner_key=?").get(to)) throw new Error("MEMORY_TEAM_EXISTS");
    const changed = db.prepare("UPDATE memory_scopes SET owner_key=?,revision=revision+1 WHERE kind='team' AND owner_key=?").run(to,from);
    if (!changed.changes) throw new Error("MEMORY_TEAM_UNKNOWN");
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    revokeAllDisclosures(db,"team-rename");
  });
}
